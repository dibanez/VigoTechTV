// VigoTechTV - Service Worker (Manifest V3)
// Replaces all background/*.js scripts
// Service workers have no DOM access - recording is done in offscreen document

// --- State ---
var isRecording = false;
var enableTabCaptureAPI = false;
var enableTabCaptureAPIAudioOnly = false;
var enableScreen = true;
var enableMicrophone = false;
var enableCamera = false;
var enableSpeakers = true;
var videoCodec = 'Default';
var videoMaxFrameRates = '';
var videoResolutions = '1920x1080';
var bitsPerSecond = 0;
var openPreviewOnStopRecording = true;
var openCameraPreviewDuringRecording = true;
var logoPosition = 'bottom-left';
var logoSize = 10;
var pipPosition = 'bottom-right';

// --- Init ---
chrome.runtime.onInstalled.addListener(function() {
    chrome.storage.sync.set({ isRecording: 'false' });
});

// --- Badge Text ---
var images = ['recordRTC-progress-1.png', 'recordRTC-progress-2.png', 'recordRTC-progress-3.png', 'recordRTC-progress-4.png', 'recordRTC-progress-5.png'];
var imgIndex = 0;
var reverse = false;
var initialTime;
var timerInterval;

// MV3 service workers can't reliably set the action icon by `path` (it fails
// intermittently with "Failed to fetch", especially in a loop). Preload each PNG
// into ImageData once (via OffscreenCanvas) and set it from memory instead.
var iconImageData = {};
var iconsPreloaded = false;

async function preloadIcons() {
    if (iconsPreloaded) return;
    var names = images.concat(['main-icon.png']);
    await Promise.all(names.map(async function(name) {
        try {
            var resp = await fetch(chrome.runtime.getURL('images/' + name));
            var blob = await resp.blob();
            var bitmap = await createImageBitmap(blob);
            var canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
            var ctx = canvas.getContext('2d');
            ctx.drawImage(bitmap, 0, 0);
            iconImageData[name] = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
            bitmap.close();
        } catch (e) {
            console.warn('Icon preload failed for ' + name, e);
        }
    }));
    iconsPreloaded = true;
}

function setActionIcon(name) {
    if (iconImageData[name]) {
        chrome.action.setIcon({ imageData: iconImageData[name] }).catch(function() {});
    } else {
        // Fallback (and kick off preload for next time).
        chrome.action.setIcon({ path: 'images/' + name }).catch(function() {});
        preloadIcons();
    }
}

function setBadgeText(text) {
    chrome.action.setBadgeBackgroundColor({ color: [255, 0, 0, 255] });
    chrome.action.setBadgeText({ text: text + '' });
}

function convertTime(miliseconds) {
    var totalSeconds = Math.floor(miliseconds / 1000);
    var minutes = Math.floor(totalSeconds / 60);
    var seconds = totalSeconds - minutes * 60;
    minutes += '';
    seconds += '';
    if (seconds.length === 1) {
        seconds = '0' + seconds;
    }
    return minutes + ':' + seconds;
}

function checkTime() {
    if (!initialTime || !isRecording) return;
    var timeDifference = Date.now() - initialTime;
    var formatted = convertTime(timeDifference);
    setBadgeText(formatted);
    chrome.action.setTitle({ title: 'Recording duration: ' + formatted });
}

function onRecording() {
    if (!isRecording) return;

    setActionIcon(images[imgIndex]);

    if (!reverse) {
        imgIndex++;
        if (imgIndex > images.length - 1) {
            imgIndex = images.length - 1;
            reverse = true;
        }
    } else {
        imgIndex--;
        if (imgIndex < 0) {
            imgIndex = 1;
            reverse = false;
        }
    }

    if (isRecording) {
        setTimeout(onRecording, 800);
        return;
    }

    setActionIcon('main-icon.png');
}

// --- Offscreen Document Management ---
var offscreenCreated = false;

async function ensureOffscreenDocument() {
    if (offscreenCreated) return;

    try {
        var contexts = await chrome.runtime.getContexts({
            contextTypes: ['OFFSCREEN_DOCUMENT']
        });
        if (contexts.length > 0) {
            offscreenCreated = true;
            return;
        }
    } catch (e) {
        // getContexts may not be available in older Chrome versions
    }

    try {
        await chrome.offscreen.createDocument({
            url: 'offscreen.html',
            reasons: ['USER_MEDIA', 'DISPLAY_MEDIA'],
            justification: 'Recording screen, camera, and microphone for meetup recordings'
        });
        offscreenCreated = true;
    } catch (e) {
        if (!e.message.includes('Only a single offscreen')) {
            console.error('Failed to create offscreen document:', e);
        }
        offscreenCreated = true; // already exists
    }
}

// Send message to offscreen document with retry logic.
// After createDocument(), the offscreen HTML exists but scripts may not have
// loaded yet.  Chrome delivers the message to the context (no lastError) even
// when no onMessage listener is registered, so the message is silently dropped.
// We therefore check the *response* value: the offscreen listener calls
// sendResponse({received:true}) to confirm it actually processed the message.
function sendToOffscreen(message) {
    var attempts = 0;
    var maxAttempts = 20;

    function trySend() {
        chrome.runtime.sendMessage(message, function(response) {
            // Consume lastError to prevent "Unchecked runtime.lastError" warnings
            var err = chrome.runtime.lastError;

            if (err || !response || !response.received) {
                attempts++;
                if (attempts < maxAttempts) {
                    setTimeout(trySend, 200);
                } else {
                    console.error('Failed to reach offscreen document after ' + maxAttempts + ' attempts',
                        err ? err.message : 'no response');
                    setDefaults();
                }
            }
        });
    }

    trySend();
}

// --- User Config ---
function getUserConfigs(callback) {
    chrome.storage.sync.get(null, function(items) {
        if (items['bitsPerSecond'] && items['bitsPerSecond'].toString().length && items['bitsPerSecond'] !== 'default') {
            bitsPerSecond = parseInt(items['bitsPerSecond']);
        }
        if (items['enableTabCaptureAPI']) {
            enableTabCaptureAPI = items['enableTabCaptureAPI'] == 'true';
        }
        if (items['enableTabCaptureAPIAudioOnly']) {
            enableTabCaptureAPIAudioOnly = items['enableTabCaptureAPIAudioOnly'] == 'true';
        }
        if (items['enableCamera']) {
            enableCamera = items['enableCamera'] == 'true';
        }
        if (items['enableSpeakers']) {
            enableSpeakers = items['enableSpeakers'] == 'true';
        }
        if (items['enableScreen']) {
            enableScreen = items['enableScreen'] == 'true';
        }
        if (items['enableMicrophone']) {
            enableMicrophone = items['enableMicrophone'] == 'true';
        }
        if (items['videoCodec']) {
            videoCodec = items['videoCodec'];
        }
        if (items['videoMaxFrameRates'] && items['videoMaxFrameRates'].toString().length) {
            videoMaxFrameRates = parseInt(items['videoMaxFrameRates']);
        }
        if (items['videoResolutions'] && items['videoResolutions'].toString().length) {
            videoResolutions = items['videoResolutions'];
        }
        if (items['logoPosition']) {
            logoPosition = items['logoPosition'];
        }
        if (items['logoSize']) {
            logoSize = parseInt(items['logoSize']) || 10;
        }
        if (items['pipPosition']) {
            pipPosition = items['pipPosition'];
        }

        // Transcription (default ON; needs the microphone to work).
        var enableTranscription = true;
        if (typeof items['enableTranscription'] !== 'undefined') {
            enableTranscription = items['enableTranscription'] == 'true';
        }
        var transcriptionLang = items['transcriptionLang'] || 'es-ES';

        var microphoneDevice = items['microphone'] || false;
        var cameraDevice = items['camera'] || false;

        chrome.storage.local.get('logoDataUri', function(localItems) {
            callback({
                enableTabCaptureAPI: enableTabCaptureAPI,
                enableTabCaptureAPIAudioOnly: enableTabCaptureAPIAudioOnly,
                enableScreen: enableScreen,
                enableMicrophone: enableMicrophone,
                enableCamera: enableCamera,
                enableSpeakers: enableSpeakers,
                videoCodec: videoCodec,
                videoMaxFrameRates: videoMaxFrameRates,
                videoResolutions: videoResolutions,
                bitsPerSecond: bitsPerSecond,
                microphoneDevice: microphoneDevice,
                cameraDevice: cameraDevice,
                logoDataUri: localItems['logoDataUri'] || '',
                logoPosition: logoPosition,
                logoSize: logoSize,
                pipPosition: pipPosition,
                enableTranscription: enableTranscription,
                transcriptionLang: transcriptionLang
            });
        });
    });
}

// --- Helper: get active tab ---
function getActiveTab(callback) {
    chrome.tabs.query({ active: true, currentWindow: true }, function(tabs) {
        if (tabs && tabs.length) {
            callback(tabs[0]);
        } else {
            // Fallback: get any active tab
            chrome.tabs.query({ active: true }, function(tabs) {
                if (tabs && tabs.length) {
                    callback(tabs[0]);
                } else {
                    callback(null);
                }
            });
        }
    });
}

// --- Start Recording ---
async function startRecording() {
    getUserConfigs(async function(config) {
        await ensureOffscreenDocument();

        if (config.enableTabCaptureAPI) {
            // Tab capture - get stream ID first
            getActiveTab(function(activeTab) {
                if (!activeTab) {
                    console.error('No active tab found for tab capture');
                    setDefaults();
                    return;
                }

                chrome.tabCapture.getMediaStreamId({ targetTabId: activeTab.id }, function(streamId) {
                    if (chrome.runtime.lastError) {
                        console.error('Tab capture error:', chrome.runtime.lastError.message);
                        setDefaults();
                        return;
                    }
                    sendToOffscreen({
                        target: 'offscreen',
                        action: 'start-recording',
                        config: config,
                        tabCaptureStreamId: streamId
                    });
                });
            });
        } else if (config.enableScreen) {
            // Screen capture via getDisplayMedia in the offscreen document. This
            // uses the OS desktop portal and works on Wayland (the legacy
            // chooseDesktopMedia + getUserMedia streamId path aborts there).
            sendToOffscreen({
                target: 'offscreen',
                action: 'start-recording',
                config: config,
                useDisplayMedia: true
            });
        } else {
            // Camera/mic only
            sendToOffscreen({
                target: 'offscreen',
                action: 'start-recording',
                config: config
            });
        }
    });
}

function stopRecording() {
    sendToOffscreen({
        target: 'offscreen',
        action: 'stop-recording'
    });
}

function setDefaults() {
    setActionIcon('main-icon.png');
    isRecording = false;
    imgIndex = 0;
    if (timerInterval) {
        clearInterval(timerInterval);
        timerInterval = null;
    }
    setBadgeText('');
    chrome.storage.sync.set({ isRecording: 'false' });
}

// --- Message Handling ---
chrome.runtime.onMessage.addListener(function(message, sender, sendResponse) {
    if (message.target === 'service-worker') {
        if (message.action === 'recording-started') {
            isRecording = true;
            initialTime = Date.now();
            timerInterval = setInterval(checkTime, 100);
            preloadIcons().then(onRecording);

            // Open camera preview if needed
            if (message.showCameraPreview && openCameraPreviewDuringRecording) {
                chrome.tabs.create({ url: 'video.html' });
            }
        }

        if (message.action === 'recording-stopped') {
            isRecording = false;
            if (timerInterval) {
                clearInterval(timerInterval);
                timerInterval = null;
            }
            setBadgeText('');
            setActionIcon('main-icon.png');
            chrome.action.setTitle({ title: 'Record Your Screen, Tab or Camera' });

            chrome.storage.sync.set({
                isRecording: 'false',
                openPreviewPage: 'false'
            });

            if (openPreviewOnStopRecording) {
                function openPreview() {
                    chrome.tabs.query({}, function(tabs) {
                        var found = false;
                        var url = 'chrome-extension://' + chrome.runtime.id + '/preview.html';
                        for (var i = tabs.length - 1; i >= 0; i--) {
                            if (tabs[i].url === url) {
                                found = true;
                                chrome.tabs.update(tabs[i].id, { active: true, url: url });
                                break;
                            }
                        }
                        if (!found) {
                            chrome.tabs.create({ url: 'preview.html' });
                        }
                    });
                }

                // Mark the just-recorded file (set in storage here, since the
                // offscreen document has no chrome.storage access) so the preview
                // opens it by default. Open the preview only after it is stored.
                if (message.fileName) {
                    chrome.storage.local.set({ lastRecordedFile: message.fileName }, openPreview);
                } else {
                    openPreview();
                }
            }
        }

        if (message.action === 'recording-error') {
            console.error('Recording error:', message.error);
            setDefaults();
        }
    }
});

// --- Keyboard shortcut (replaces the old all-pages content script) ---
// Ctrl+Shift+S (configurable in chrome://extensions/shortcuts) stops recording.
if (chrome.commands && chrome.commands.onCommand) {
    chrome.commands.onCommand.addListener(function(command) {
        if (command === 'stop-recording' && isRecording) {
            stopRecording();
        }
    });
}

// --- Port-based messaging (from the popup) ---
var runtimePort;

chrome.runtime.onConnect.addListener(function(port) {
    runtimePort = port;

    runtimePort.onMessage.addListener(function(message) {
        if (!message || !message.messageFromContentScript1234) {
            return;
        }

        if (message.startRecording) {
            if (message.dropdown) {
                openPreviewOnStopRecording = true;
                openCameraPreviewDuringRecording = true;
            }

            if (isRecording && message.dropdown) {
                stopRecording();
                return;
            }

            startRecording();
            return;
        }

        if (message.stopRecording) {
            stopRecording();
            return;
        }
    });
});
