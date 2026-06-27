// VigoTechTV - Offscreen Document
// Handles all media recording since service workers have no DOM access

var recorder = null;
var compositor = null;
var audioMixer = null;
var isRecording = false;
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
    if (!recorder || !isRecording) return;
    isRecording = false;
    config = config || currentConfig || {};

    recorder.stop(function() {
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

        DiskStorage.StoreFile(file, function() {
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

function captureCamera(config, callback) {
    var supported = navigator.mediaDevices.getSupportedConstraints();
    var constraints = {
        audio: !!config.enableMicrophone,
        video: !!config.enableCamera
    };

    if (config.enableCamera) {
        var videoResolutions = config.videoResolutions || '1920x1080';
        if (videoResolutions !== 'default' && videoResolutions.length) {
            var parts = videoResolutions.split('x');
            if (parts[0] && parts[1]) {
                constraints.video = {
                    width: { ideal: parseInt(parts[0]) },
                    height: { ideal: parseInt(parts[1]) }
                };
            }
        }

        if (typeof constraints.video === 'object') {
            if (supported.aspectRatio) {
                constraints.video.aspectRatio = 1.777777778;
            }
            if (supported.frameRate && config.videoMaxFrameRates) {
                constraints.video.frameRate = { ideal: parseInt(config.videoMaxFrameRates) };
            }
            if (config.cameraDevice) {
                constraints.video.deviceId = config.cameraDevice;
            }
        }
    }

    if (config.enableMicrophone) {
        constraints.audio = {};
        if (config.microphoneDevice) {
            constraints.audio.deviceId = config.microphoneDevice;
        }
        if (supported.echoCancellation) {
            constraints.audio.echoCancellation = true;
        }
    }

    console.log('offscreen: captureCamera requesting getUserMedia',
        'video=' + !!constraints.video, 'audio=' + !!constraints.audio);

    navigator.mediaDevices.getUserMedia(constraints).then(function(stream) {
        console.log('offscreen: captureCamera OK',
            'videoTracks=' + stream.getVideoTracks().length,
            'audioTracks=' + stream.getAudioTracks().length);
        activeStreams.push(stream);
        callback(stream);
    }).catch(function(error) {
        reportError('Camera/microphone access failed: ' + error.message);
    });
}

function captureDesktop(config, desktopStreamId, canRequestAudioTrack) {
    var constraints = {
        audio: false,
        video: {
            mandatory: {
                chromeMediaSource: 'desktop',
                chromeMediaSourceId: desktopStreamId,
                maxWidth: 3840,
                maxHeight: 2160,
                minWidth: 3840,
                minHeight: 2160
            }
        }
    };

    if (config.videoMaxFrameRates) {
        var fps = parseInt(config.videoMaxFrameRates);
        if (fps) {
            constraints.video.mandatory.maxFrameRate = fps;
        }
    }

    if (canRequestAudioTrack) {
        constraints.audio = {
            mandatory: {
                chromeMediaSource: 'desktop',
                chromeMediaSourceId: desktopStreamId,
                echoCancellation: true
            }
        };
    }

    console.log('offscreen: captureDesktop requesting getUserMedia');

    navigator.mediaDevices.getUserMedia(constraints).then(function(screenStream) {
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

        buildFinalStream(screenStream, config);
    }).catch(function(error) {
        reportError('Desktop capture failed: ' + error.message);
    });
}

function buildFinalStream(screenStream, config) {
    try {
        var cameraStream = activeStreams.length > 1 ? activeStreams[0] : null;
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

            console.log('offscreen: PiP mode',
                'canvas=' + canvasWidth + 'x' + canvasHeight);

            compositor = new CanvasCompositor();

            compositor.addStream(screenStream, { fullCanvas: true });

            var pipWidth = Math.round(canvasWidth * 0.20);
            var pipHeight = Math.round(canvasHeight * 0.20);
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
                var compositeVideoStream = compositor.start(canvasWidth, canvasHeight);

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
        } else if (message.desktopStreamId) {
            if (currentConfig.enableMicrophone || currentConfig.enableCamera) {
                captureCamera(currentConfig, function() {
                    captureDesktop(currentConfig, message.desktopStreamId, message.canRequestAudioTrack);
                });
            } else {
                captureDesktop(currentConfig, message.desktopStreamId, message.canRequestAudioTrack);
            }
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
