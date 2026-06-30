// VigoTechTV - Offscreen Document
// Handles all media recording since service workers have no DOM access

var recorder = null;
var compositor = null;
var audioMixer = null;
var isRecording = false;
var isStarting = false; // guards against duplicate start-recording messages
var activeStreams = [];
var currentConfig = null;

// --- Utility ---

function getFileName(fileExtension) {
    var d = new Date();
    var year = d.getUTCFullYear() + '';
    var month = (d.getUTCMonth() + 1) + '';
    var date = d.getUTCDate() + '';
    if (month.length === 1) month = '0' + month;
    if (date.length === 1) date = '0' + date;

    var token = '';
    var a = crypto.getRandomValues(new Uint32Array(3));
    for (var i = 0; i < a.length; i++) {
        token += a[i].toString(36);
    }

    return year + month + date + token + '.' + fileExtension;
}

function addStreamStopListener(stream, callback) {
    var called = false;
    function onEnded() {
        if (called) return;
        called = true;
        callback();
    }
    stream.getTracks().forEach(function(track) {
        track.addEventListener('ended', onEnded);
    });
}

function stopAllStreams() {
    activeStreams.forEach(function(stream) {
        stream.getTracks().forEach(function(track) {
            track.stop();
        });
    });
    activeStreams = [];
}

function reportError(errorMsg) {
    isStarting = false;
    console.error('VigoTechTV offscreen error:', errorMsg);
    chrome.runtime.sendMessage({
        target: 'service-worker',
        action: 'recording-error',
        error: errorMsg
    });
}

// --- Position & Logo Helpers ---

function calcPosition(position, canvasW, canvasH, itemW, itemH) {
    var margin = Math.round(canvasW * 0.02);
    switch (position) {
        case 'top-left':     return { x: margin, y: margin };
        case 'top-right':    return { x: canvasW - itemW - margin, y: margin };
        case 'bottom-left':  return { x: margin, y: canvasH - itemH - margin };
        case 'bottom-right':
        default:             return { x: canvasW - itemW - margin, y: canvasH - itemH - margin };
    }
}

function loadImage(dataUri) {
    return new Promise(function(resolve, reject) {
        var img = new Image();
        img.onload = function() { resolve(img); };
        img.onerror = function() { reject(new Error('Failed to load logo image')); };
        img.src = dataUri;
    });
}

function addLogoToCompositor(comp, config, canvasW, canvasH) {
    if (!config.logoDataUri) {
        return Promise.resolve();
    }
    return loadImage(config.logoDataUri).then(function(img) {
        var logoSizePct = (parseInt(config.logoSize) || 10) / 100;
        var logoW = Math.round(canvasW * logoSizePct);
        var logoH = Math.round(logoW * (img.height / img.width));
        var pos = calcPosition(config.logoPosition || 'bottom-left', canvasW, canvasH, logoW, logoH);
        comp.addImage(img, { x: pos.x, y: pos.y, width: logoW, height: logoH });
    }).catch(function(e) {
        console.warn('offscreen: failed to load logo:', e.message);
    });
}

// Place the logo centred (preserving aspect ratio) inside a reserved box.
// Used by the "framed" layout so the logo never overlaps screen or camera.
// The logo is sized from the "Logo size" setting (% of canvas width) and only
// shrunk further if it would not fit the reserved box — it is never upscaled
// to fill the box.
function addLogoFramed(comp, config, box, canvasW) {
    if (!config.logoDataUri || box.w < 20 || box.h < 20) {
        return Promise.resolve();
    }
    return loadImage(config.logoDataUri).then(function(img) {
        var logoSizePct = (parseInt(config.logoSize) || 10) / 100;
        var targetW = canvasW * logoSizePct;
        // Fit within the target width, the box width and the box height.
        var scale = Math.min(targetW / img.width, box.w / img.width, box.h / img.height);
        var logoW = Math.round(img.width * scale);
        var logoH = Math.round(img.height * scale);
        var pad = Math.round(canvasW * 0.012);
        // Centred horizontally in the narrow column; anchored to the outer
        // vertical edge (away from the camera) so it sits in the corner.
        var x = Math.round(box.x + (box.w - logoW) / 2);
        var y;
        if (box.vAlign === 'top') {
            y = Math.round(box.y + pad);
        } else {
            y = Math.round(box.y + box.h - logoH - pad);
        }
        comp.addImage(img, { x: x, y: y, width: logoW, height: logoH });
    }).catch(function(e) {
        console.warn('offscreen: failed to load logo (framed):', e.message);
    });
}

// Shared finish step for the screen+camera composite: start the compositor,
// mix audio from both sources and hand the final stream to the recorder.
function finishPiP(comp, canvasWidth, canvasHeight, screenStream, cameraStream, config) {
    var compositeVideoStream = comp.start(canvasWidth, canvasHeight);
    if (!compositeVideoStream) {
        reportError('Canvas captureStream not supported');
        return;
    }

    console.log('offscreen: compositor started',
        'compositeVideoTracks=' + compositeVideoStream.getVideoTracks().length);

    audioMixer = new AudioMixer();
    var mixedAudio = audioMixer.mix([screenStream, cameraStream]);

    var finalStream = new MediaStream();
    compositeVideoStream.getVideoTracks().forEach(function(track) {
        finalStream.addTrack(track);
    });
    if (mixedAudio) {
        mixedAudio.getAudioTracks().forEach(function(track) {
            finalStream.addTrack(track);
        });
    }

    console.log('offscreen: final PiP stream ready',
        'videoTracks=' + finalStream.getVideoTracks().length,
        'audioTracks=' + finalStream.getAudioTracks().length);

    startRecordingStream(finalStream, config);
}

// Subtitles are NOT generated here. Live Web Speech transcription is impossible
// during recording: getUserMedia holds the mic in this offscreen document and
// Chrome denies webkitSpeechRecognition with "not-allowed" (the mic can't be
// shared in the same document). Instead, the recorded audio is transcribed later
// with local Whisper from the preview page (see preview/preview.whisper.js).

// --- Recording Logic ---

function startRecordingStream(finalStream, config) {
    try {
        var audioOnly = config.enableTabCaptureAPIAudioOnly ||
            (config.enableMicrophone && !config.enableCamera && !config.enableScreen) ||
            (config.enableSpeakers && !config.enableScreen && !config.enableCamera);

        var recorderOptions = {
            audioOnly: audioOnly
        };

        if (config.bitsPerSecond) {
            var bps = parseInt(config.bitsPerSecond);
            if (bps && bps >= 100) {
                recorderOptions.bitsPerSecond = bps;
            }
        }

        // Select mimeType based on codec preference
        var videoCodec = config.videoCodec || 'Default';
        if (!audioOnly) {
            if (videoCodec === 'VP8') {
                recorderOptions.mimeType = 'video/webm;codecs=vp8';
            } else if (videoCodec === 'VP9' || videoCodec === 'Default') {
                recorderOptions.mimeType = 'video/webm;codecs=vp9';
            } else if (videoCodec === 'H264' && MediaRecorder.isTypeSupported('video/webm;codecs=h264')) {
                recorderOptions.mimeType = 'video/webm;codecs=h264';
            } else if (videoCodec === 'MKV' && MediaRecorder.isTypeSupported('video/x-matroska;codecs=avc1')) {
                recorderOptions.mimeType = 'video/x-matroska;codecs=avc1';
            }
        }

        // Verify the stream has tracks
        var videoTracks = finalStream.getVideoTracks();
        var audioTracks = finalStream.getAudioTracks();
        console.log('offscreen: startRecordingStream',
            'videoTracks=' + videoTracks.length,
            'audioTracks=' + audioTracks.length,
            'audioOnly=' + audioOnly,
            'mimeType=' + (recorderOptions.mimeType || 'auto'));

        if (videoTracks.length === 0 && audioTracks.length === 0) {
            reportError('Cannot record: stream has no tracks');
            return;
        }

        recorder = new NativeRecorder(finalStream, recorderOptions);
        recorder.streams = activeStreams.slice();
        recorder.onError(function(err) {
            reportError('MediaRecorder error: ' + (err.message || err));
        });
        recorder.record();
        isRecording = true;
        isStarting = false;
        console.log('offscreen: recording started');

        addStreamStopListener(finalStream, function() {
            stopScreenRecording(config);
        });

        chrome.runtime.sendMessage({
            target: 'service-worker',
            action: 'recording-started',
            showCameraPreview: config.enableCamera && !config.enableScreen && !config.enableTabCaptureAPI
        });
    } catch (e) {
        reportError('startRecordingStream failed: ' + e.message);
    }
}

function stopScreenRecording(config) {
    isStarting = false;
    console.log('offscreen: stopScreenRecording called, recorder=' + !!recorder + ', isRecording=' + isRecording);
    if (!recorder || !isRecording) return;
    isRecording = false;
    config = config || currentConfig || {};

    recorder.stop(function() {
        console.log('offscreen: recorder.stop callback, blob size=' +
            (recorder && recorder.blob ? recorder.blob.size : 'no blob'));
        var fileExtension = 'webm';
        var mimeType = 'video/webm';

        var audioOnly = config.enableTabCaptureAPIAudioOnly ||
            (config.enableMicrophone && !config.enableCamera && !config.enableScreen) ||
            (config.enableSpeakers && !config.enableScreen && !config.enableCamera);

        if (audioOnly) {
            mimeType = 'audio/webm';
            fileExtension = 'webm';
        } else {
            var videoCodec = config.videoCodec || 'Default';
            if (videoCodec === 'H264' && MediaRecorder.isTypeSupported('video/webm;codecs=h264')) {
                mimeType = 'video/mp4';
                fileExtension = 'mp4';
            } else if (videoCodec === 'MKV' && MediaRecorder.isTypeSupported('video/x-matroska;codecs=avc1')) {
                mimeType = 'video/mkv';
                fileExtension = 'mkv';
            }
        }

        var file = new File([recorder.blob || ''], getFileName(fileExtension), {
            type: mimeType
        });

        console.log('offscreen: storing file ' + file.name + ' (' + file.size + ' bytes)');
        DiskStorage.StoreFile(file, function() {
            console.log('offscreen: file stored, notifying service worker');
            stopAllStreams();

            if (compositor) {
                compositor.destroy();
                compositor = null;
            }
            if (audioMixer) {
                audioMixer.destroy();
                audioMixer = null;
            }

            recorder = null;

            // Pass the just-recorded file name so the service worker can mark it
            // (chrome.storage is NOT available in offscreen documents - only the
            // chrome.runtime messaging APIs are). The preview uses it to open this
            // recording by default instead of the last-viewed one.
            function notifyStopped() {
                chrome.runtime.sendMessage({
                    target: 'service-worker',
                    action: 'recording-stopped',
                    fileName: file.name
                });
            }

            notifyStopped();
        });
    });
}

// --- Capture Functions ---

// getUserMedia that rejects after timeoutMs instead of hanging forever (which it
// does on Linux when the device is busy). On a late resolve, the stream is stopped.
function gumWithTimeout(constraints, timeoutMs) {
    return new Promise(function(resolve, reject) {
        var settled = false;
        var to = setTimeout(function() {
            if (settled) return;
            settled = true;
            reject(new Error('timeout'));
        }, timeoutMs);
        navigator.mediaDevices.getUserMedia(constraints).then(function(s) {
            if (settled) { s.getTracks().forEach(function(t) { t.stop(); }); return; }
            settled = true;
            clearTimeout(to);
            resolve(s);
        }).catch(function(e) {
            if (settled) return;
            settled = true;
            clearTimeout(to);
            reject(e);
        });
    });
}

// Capture camera and/or mic. Video and audio are requested SEPARATELY so a busy
// microphone (common when other apps hold it) doesn't block the camera. Audio is
// best-effort: if the mic is unavailable we still record video. onFail (optional)
// lets the caller fall back (e.g. screen-only) instead of aborting the recording.
function captureCamera(config, callback, onFail) {
    var supported = navigator.mediaDevices.getSupportedConstraints();

    var videoConstraints = false;
    if (config.enableCamera) {
        videoConstraints = true;
        var videoResolutions = config.videoResolutions || '1920x1080';
        if (videoResolutions !== 'default' && videoResolutions.length) {
            var parts = videoResolutions.split('x');
            if (parts[0] && parts[1]) {
                videoConstraints = {
                    width: { ideal: parseInt(parts[0]) },
                    height: { ideal: parseInt(parts[1]) }
                };
            }
        }
        if (typeof videoConstraints === 'object') {
            if (supported.aspectRatio) videoConstraints.aspectRatio = 1.777777778;
            if (supported.frameRate && config.videoMaxFrameRates) {
                videoConstraints.frameRate = { ideal: parseInt(config.videoMaxFrameRates) };
            }
            if (config.cameraDevice) videoConstraints.deviceId = config.cameraDevice;
        }
    }

    var audioConstraints = false;
    if (config.enableMicrophone) {
        audioConstraints = {};
        if (config.microphoneDevice) audioConstraints.deviceId = config.microphoneDevice;
        if (supported.echoCancellation) audioConstraints.echoCancellation = true;
    }

    console.log('offscreen: captureCamera (separate) video=' + !!videoConstraints + ' audio=' + !!audioConstraints);

    var combined = new MediaStream();
    var chain = Promise.resolve();

    // Video first (fatal -> onFail/abort if the camera itself can't be obtained).
    if (videoConstraints) {
        chain = chain.then(function() {
            return gumWithTimeout({ video: videoConstraints, audio: false }, 12000).then(function(s) {
                s.getVideoTracks().forEach(function(t) { combined.addTrack(t); });
                console.log('offscreen: camera video OK');
            });
        });
    }

    // Audio second (best-effort -> keep video if the mic is busy/unavailable).
    if (audioConstraints) {
        chain = chain.then(function() {
            return gumWithTimeout({ audio: audioConstraints, video: false }, 8000).then(function(s) {
                s.getAudioTracks().forEach(function(t) { combined.addTrack(t); });
                console.log('offscreen: mic audio OK');
            }).catch(function(e) {
                console.warn('offscreen: mic unavailable (' + (e.name || e.message) +
                    '); continuing without audio');
            });
        });
    }

    chain.then(function() {
        if (!combined.getTracks().length) {
            var msg = 'Camera/microphone unavailable (device busy or permission missing).';
            if (typeof onFail === 'function') { console.warn('offscreen: ' + msg); onFail(msg); }
            else { reportError(msg); }
            return;
        }
        console.log('offscreen: captureCamera OK',
            'videoTracks=' + combined.getVideoTracks().length,
            'audioTracks=' + combined.getAudioTracks().length);
        activeStreams.push(combined);
        callback(combined);
    }).catch(function(error) {
        // Reached only if the camera (video) itself failed.
        var msg = 'Camera access failed [' + (error.name || '?') + ']: ' + (error.message || error);
        if (typeof onFail === 'function') { console.warn('offscreen: ' + msg); onFail(msg); }
        else { reportError(msg); }
    });
}

// Screen capture via getDisplayMedia (uses the OS desktop portal). This is the
// reliable path on Wayland, where the legacy desktopCapture streamId aborts.
function captureScreenDisplayMedia(config) {
    var video = true;
    if (config.videoMaxFrameRates) {
        var fps = parseInt(config.videoMaxFrameRates);
        if (fps) video = { frameRate: { ideal: fps } };
    }

    function attempt(withAudio) {
        return navigator.mediaDevices.getDisplayMedia({ video: video, audio: withAudio });
    }

    function onOk(screenStream) {
        var t = screenStream.getVideoTracks()[0];
        var s = t ? t.getSettings() : {};
        console.log('offscreen: getDisplayMedia OK',
            'videoTracks=' + screenStream.getVideoTracks().length,
            'audioTracks=' + screenStream.getAudioTracks().length,
            'resolution=' + (s.width || '?') + 'x' + (s.height || '?'));

        activeStreams.push(screenStream);

        addStreamStopListener(screenStream, function() {
            stopScreenRecording(config);
        });

        // Capture camera/mic AFTER the screen picker so the picker always appears.
        // If the camera/mic can't be obtained (e.g. permission not granted), fall
        // back to a screen-only recording instead of aborting.
        if (config.enableMicrophone || config.enableCamera) {
            captureCamera(config, function() {
                buildFinalStream(screenStream, config);
            }, function() {
                console.warn('offscreen: recording screen only (no camera/mic)');
                buildFinalStream(screenStream, config);
            });
        } else {
            buildFinalStream(screenStream, config);
        }
    }

    var wantAudio = config.enableSpeakers !== false;
    console.log('offscreen: requesting getDisplayMedia, audio=' + wantAudio);

    attempt(wantAudio).then(onOk).catch(function(error) {
        // Retry video-only if system audio caused the failure (but not if the user
        // cancelled / activation was missing -> NotAllowedError).
        if (wantAudio && error.name !== 'NotAllowedError') {
            console.warn('offscreen: getDisplayMedia with audio failed (' +
                error.message + '); retrying video-only');
            attempt(false).then(onOk).catch(function(err2) {
                reportError('Screen capture failed [' + (err2.name || '?') + ']: ' + err2.message);
            });
        } else {
            reportError('Screen capture failed [' + (error.name || '?') + ']: ' + error.message);
        }
    });
}

function captureDesktop(config, desktopStreamId, canRequestAudioTrack) {
    // Build the desktop constraints. Only cap the resolution (maxWidth/maxHeight):
    // forcing a minimum (or an exact min=max) breaks full-screen capture on
    // sub-4K monitors, since Chrome can't upscale an "entire screen" source.
    function buildConstraints(withAudio) {
        var video = {
            mandatory: {
                chromeMediaSource: 'desktop',
                chromeMediaSourceId: desktopStreamId,
                maxWidth: 3840,
                maxHeight: 2160
            }
        };
        if (config.videoMaxFrameRates) {
            var fps = parseInt(config.videoMaxFrameRates);
            if (fps) video.mandatory.maxFrameRate = fps;
        }
        var c = { audio: false, video: video };
        if (withAudio) {
            c.audio = {
                mandatory: {
                    chromeMediaSource: 'desktop',
                    chromeMediaSourceId: desktopStreamId,
                    echoCancellation: true
                }
            };
        }
        return c;
    }

    function onOk(screenStream) {
        var screenTrack = screenStream.getVideoTracks()[0];
        var settings = screenTrack ? screenTrack.getSettings() : {};
        console.log('offscreen: captureDesktop OK',
            'videoTracks=' + screenStream.getVideoTracks().length,
            'audioTracks=' + screenStream.getAudioTracks().length,
            'resolution=' + (settings.width || '?') + 'x' + (settings.height || '?'));

        activeStreams.push(screenStream);

        addStreamStopListener(screenStream, function() {
            stopScreenRecording(config);
        });

        // Capture camera/mic AFTER the screen, so the (short-lived) desktop
        // streamId is consumed immediately and doesn't go stale.
        if (config.enableMicrophone || config.enableCamera) {
            captureCamera(config, function() {
                buildFinalStream(screenStream, config);
            });
        } else {
            buildFinalStream(screenStream, config);
        }
    }

    console.log('offscreen: captureDesktop requesting getUserMedia, audio=' + !!canRequestAudioTrack);

    navigator.mediaDevices.getUserMedia(buildConstraints(!!canRequestAudioTrack))
        .then(onOk)
        .catch(function(error) {
            // Desktop/system audio is unsupported on many platforms (notably Linux),
            // and a mandatory audio track makes the WHOLE capture fail ("Error
            // starting tab capture"). Retry video-only so the screen still records.
            if (canRequestAudioTrack) {
                console.warn('offscreen: desktop capture with audio failed (' +
                    error.message + '); retrying video-only');
                navigator.mediaDevices.getUserMedia(buildConstraints(false))
                    .then(onOk)
                    .catch(function(err2) {
                        reportError('Desktop capture failed: ' + err2.message);
                    });
            } else {
                reportError('Desktop capture failed [' + (error.name || '?') + ']: ' + error.message);
            }
        });
}

function buildFinalStream(screenStream, config) {
    try {
        // If the screen was stopped/cancelled before we got here (e.g. the user
        // stopped sharing during the camera wait), its track is already ended and
        // compositing would throw. Abort cleanly.
        var primaryTrack = screenStream.getVideoTracks()[0];
        if (primaryTrack && primaryTrack.readyState === 'ended') {
            console.warn('offscreen: screen track ended before recording started; aborting');
            stopAllStreams();
            isStarting = false;
            return;
        }

        // The camera/mic stream is whatever active stream isn't the screen one
        // (order-independent: the screen may be captured before or after the camera).
        var cameraStream = activeStreams.filter(function(s) { return s !== screenStream; })[0] || null;
        var hasLogo = !!config.logoDataUri;

        console.log('offscreen: buildFinalStream',
            'activeStreams=' + activeStreams.length,
            'enableScreen=' + config.enableScreen,
            'enableCamera=' + config.enableCamera,
            'hasCameraStream=' + !!cameraStream,
            'cameraVideoTracks=' + (cameraStream ? cameraStream.getVideoTracks().length : 0),
            'hasLogo=' + hasLogo);

        // Case: Screen/Tab + Camera PiP
        var primaryHasVideo = screenStream.getVideoTracks().length > 0;
        if (primaryHasVideo && cameraStream && cameraStream.getVideoTracks().length) {
            var screenTrack = screenStream.getVideoTracks()[0];
            var screenSettings = screenTrack.getSettings();
            var canvasWidth = screenSettings.width || 1920;
            var canvasHeight = screenSettings.height || 1080;

            compositor = new CanvasCompositor();

            var layoutMode = config.layoutMode || 'overlay';

            if (layoutMode === 'framed') {
                // No-overlap layout: the screen is fitted into the main area and
                // the camera + logo live in a dedicated sidebar. Nothing is
                // painted on top of anything else. The sidebar side (left/right)
                // and the camera position within it (top/bottom) follow the
                // "Camera PiP position" setting.
                var pipPos = config.pipPosition || 'bottom-right';
                var sidebarLeft = pipPos.indexOf('left') !== -1;
                var camAtTop = pipPos.indexOf('top') !== -1;

                var camPct = parseInt(config.cameraSize) || 25;
                var gap = Math.round(canvasWidth * 0.012);
                var camColW = Math.round(canvasWidth * (camPct / 100));
                camColW = Math.max(160, Math.min(camColW, Math.round(canvasWidth * 0.45)));

                console.log('offscreen: PiP framed mode',
                    'canvas=' + canvasWidth + 'x' + canvasHeight,
                    'sidebar=' + camColW + 'px (' + camPct + '%)',
                    'side=' + (sidebarLeft ? 'left' : 'right'),
                    'camera=' + (camAtTop ? 'top' : 'bottom'));

                compositor.setBackground('#101114');

                // X of the sidebar column and of the screen region.
                var sidebarX = sidebarLeft ? gap : (canvasWidth - camColW - gap);
                var screenX = sidebarLeft ? (camColW + gap * 2) : gap;

                // Screen fitted (letterboxed) into the main region.
                var screenBoxW = canvasWidth - camColW - gap * 3;
                var screenBoxH = canvasHeight - gap * 2;
                compositor.addStream(screenStream, {
                    x: screenX, y: gap, width: screenBoxW, height: screenBoxH, fit: 'contain'
                });

                // Camera fitted into a 16:9 box at the top or bottom of the sidebar.
                var camBoxW = camColW;
                var camBoxH = Math.round(camBoxW * 9 / 16);
                var camBoxY = camAtTop ? gap : (canvasHeight - camBoxH - gap);
                compositor.addStream(cameraStream, {
                    x: sidebarX, y: camBoxY, width: camBoxW, height: camBoxH, fit: 'contain'
                });

                // Logo centred in the sidebar space left free by the camera.
                var logoBox = camAtTop
                    ? { x: sidebarX, y: camBoxY + camBoxH + gap, w: camBoxW,
                        h: canvasHeight - (camBoxY + camBoxH + gap) - gap, vAlign: 'bottom' }
                    : { x: sidebarX, y: gap, w: camBoxW, h: camBoxY - gap * 2, vAlign: 'top' };

                addLogoFramed(compositor, config, logoBox, canvasWidth).then(function() {
                    finishPiP(compositor, canvasWidth, canvasHeight, screenStream, cameraStream, config);
                });
                return;
            }

            // Overlay layout (default): camera floats as a PiP over the screen.
            console.log('offscreen: PiP overlay mode',
                'canvas=' + canvasWidth + 'x' + canvasHeight);

            compositor.addStream(screenStream, { fullCanvas: true });

            var camPctOverlay = parseInt(config.cameraSize) || 20;
            var pipWidth = Math.round(canvasWidth * (camPctOverlay / 100));
            var pipHeight = Math.round(canvasHeight * (camPctOverlay / 100));
            var pipPos = calcPosition(config.pipPosition || 'bottom-right', canvasWidth, canvasHeight, pipWidth, pipHeight);
            compositor.addStream(cameraStream, {
                x: pipPos.x,
                y: pipPos.y,
                width: pipWidth,
                height: pipHeight
            });

            console.log('offscreen: PiP camera position',
                'x=' + pipPos.x,
                'y=' + pipPos.y,
                'size=' + pipWidth + 'x' + pipHeight);

            addLogoToCompositor(compositor, config, canvasWidth, canvasHeight).then(function() {
                finishPiP(compositor, canvasWidth, canvasHeight, screenStream, cameraStream, config);
            });
            return;
        }

        // Case: Screen + mic audio (no camera video)
        if (cameraStream && cameraStream.getAudioTracks().length) {
            if (hasLogo && primaryHasVideo) {
                // Need compositor for logo overlay
                var screenTrack = screenStream.getVideoTracks()[0];
                var screenSettings = screenTrack.getSettings();
                var canvasWidth = screenSettings.width || 1920;
                var canvasHeight = screenSettings.height || 1080;

                compositor = new CanvasCompositor();
                compositor.addStream(screenStream, { fullCanvas: true });

                addLogoToCompositor(compositor, config, canvasWidth, canvasHeight).then(function() {
                    var compositeVideoStream = compositor.start(canvasWidth, canvasHeight);

                    if (!compositeVideoStream) {
                        reportError('Canvas captureStream not supported');
                        return;
                    }

                    audioMixer = new AudioMixer();
                    var mixedAudio = audioMixer.mix([screenStream, cameraStream]);

                    var finalStream = new MediaStream();
                    compositeVideoStream.getVideoTracks().forEach(function(track) {
                        finalStream.addTrack(track);
                    });
                    if (mixedAudio) {
                        mixedAudio.getAudioTracks().forEach(function(track) {
                            finalStream.addTrack(track);
                        });
                    } else {
                        screenStream.getAudioTracks().forEach(function(track) {
                            finalStream.addTrack(track);
                        });
                    }

                    startRecordingStream(finalStream, config);
                });
            } else {
                audioMixer = new AudioMixer();
                var mixedAudio = audioMixer.mix([screenStream, cameraStream]);

                var finalStream = new MediaStream();
                screenStream.getVideoTracks().forEach(function(track) {
                    finalStream.addTrack(track);
                });
                if (mixedAudio) {
                    mixedAudio.getAudioTracks().forEach(function(track) {
                        finalStream.addTrack(track);
                    });
                } else {
                    screenStream.getAudioTracks().forEach(function(track) {
                        finalStream.addTrack(track);
                    });
                }

                startRecordingStream(finalStream, config);
            }
            return;
        }

        // Case: Screen only (with or without system audio)
        if (hasLogo && primaryHasVideo) {
            var screenTrack = screenStream.getVideoTracks()[0];
            var screenSettings = screenTrack.getSettings();
            var canvasWidth = screenSettings.width || 1920;
            var canvasHeight = screenSettings.height || 1080;

            compositor = new CanvasCompositor();
            compositor.addStream(screenStream, { fullCanvas: true });

            addLogoToCompositor(compositor, config, canvasWidth, canvasHeight).then(function() {
                var compositeVideoStream = compositor.start(canvasWidth, canvasHeight);

                if (!compositeVideoStream) {
                    reportError('Canvas captureStream not supported');
                    return;
                }

                var finalStream = new MediaStream();
                compositeVideoStream.getVideoTracks().forEach(function(track) {
                    finalStream.addTrack(track);
                });
                screenStream.getAudioTracks().forEach(function(track) {
                    finalStream.addTrack(track);
                });

                startRecordingStream(finalStream, config);
            });
        } else {
            startRecordingStream(screenStream, config);
        }
    } catch (e) {
        reportError('buildFinalStream failed: ' + e.message);
    }
}

function captureTab(config, tabCaptureStreamId) {
    var constraints = {
        audio: {
            mandatory: {
                chromeMediaSource: 'tab',
                chromeMediaSourceId: tabCaptureStreamId
            }
        },
        video: {
            mandatory: {
                chromeMediaSource: 'tab',
                chromeMediaSourceId: tabCaptureStreamId
            }
        }
    };

    if (config.enableTabCaptureAPIAudioOnly) {
        constraints.video = false;
    }

    console.log('offscreen: captureTab requesting getUserMedia');

    navigator.mediaDevices.getUserMedia(constraints).then(function(tabStream) {
        console.log('offscreen: captureTab OK',
            'videoTracks=' + tabStream.getVideoTracks().length,
            'audioTracks=' + tabStream.getAudioTracks().length);

        activeStreams.push(tabStream);

        addStreamStopListener(tabStream, function() {
            stopScreenRecording(config);
        });

        // Route through buildFinalStream for PiP/audio mixing support
        buildFinalStream(tabStream, config);
    }).catch(function(error) {
        reportError('Tab capture failed: ' + error.message);
    });
}

// --- Message Listener ---

chrome.runtime.onMessage.addListener(function(message, sender, sendResponse) {
    if (message.target !== 'offscreen') return;

    // Acknowledge receipt so service worker retry logic knows we are ready
    sendResponse({ received: true });

    if (message.action === 'start-recording') {
        // The service worker retries start-recording until acknowledged, so the
        // same message can arrive more than once. Ignore duplicates, otherwise we
        // start two captures (two getDisplayMedia pickers, two recorders).
        if (isStarting || isRecording) {
            console.warn('offscreen: ignoring duplicate start-recording');
            return;
        }
        isStarting = true;

        // Release any leftover streams from a previous/aborted attempt; otherwise
        // the camera/mic stay busy and the next getUserMedia hangs forever.
        stopAllStreams();
        if (compositor) { try { compositor.destroy(); } catch (e) {} compositor = null; }
        if (audioMixer) { try { audioMixer.destroy(); } catch (e) {} audioMixer = null; }
        recorder = null;

        currentConfig = message.config;
        console.log('offscreen: start-recording received',
            'enableScreen=' + currentConfig.enableScreen,
            'enableCamera=' + currentConfig.enableCamera,
            'enableMicrophone=' + currentConfig.enableMicrophone,
            'hasDesktopStreamId=' + !!message.desktopStreamId,
            'hasTabCaptureStreamId=' + !!message.tabCaptureStreamId);

        if (message.tabCaptureStreamId) {
            if (currentConfig.enableMicrophone || currentConfig.enableCamera) {
                captureCamera(currentConfig, function() {
                    captureTab(currentConfig, message.tabCaptureStreamId);
                });
            } else {
                captureTab(currentConfig, message.tabCaptureStreamId);
            }
        } else if (message.useDisplayMedia) {
            // Modern path (required on Wayland): screen via getDisplayMedia (goes
            // through the desktop portal). Show the screen picker FIRST; the camera
            // is captured afterwards and is non-fatal (screen-only if it fails).
            captureScreenDisplayMedia(currentConfig);
        } else if (message.desktopStreamId) {
            // Legacy path (non-Wayland fallback): capture the screen FIRST so the
            // short-lived desktop streamId is used before it expires.
            captureDesktop(currentConfig, message.desktopStreamId, message.canRequestAudioTrack);
        } else {
            captureCamera(currentConfig, function(stream) {
                startRecordingStream(stream, currentConfig);
            });
        }
    }

    if (message.action === 'stop-recording') {
        stopScreenRecording(currentConfig);
    }
});
