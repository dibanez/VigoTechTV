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

    chrome.action.setIcon({ path: 'images/' + images[imgIndex] });

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

    chrome.action.setIcon({ path: 'images/main-icon.png' });
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
            // Desktop capture - need active tab as target for chooseDesktopMedia in MV3
            getActiveTab(function(activeTab) {
                var screenSources = ['screen', 'window'];
                if (config.enableSpeakers !== false) {
                    screenSources.push('audio');
                }

                if (!activeTab) {
                    console.error('No active tab found for desktop capture');
                    setDefaults();
                    return;
                }

                chrome.desktopCapture.chooseDesktopMedia(screenSources, activeTab, function(streamId, opts) {
                    if (!streamId || !streamId.toString().length) {
                        setDefaults();
                        return;
                    }
                    sendToOffscreen({
                        target: 'offscreen',
                        action: 'start-recording',
                        config: config,
                        desktopStreamId: streamId,
                        canRequestAudioTrack: opts ? opts.canRequestAudioTrack : false
                    });
                });
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
    chrome.action.setIcon({ path: 'images/main-icon.png' });
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
            onRecording();

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
            chrome.action.setIcon({ path: 'images/main-icon.png' });
            chrome.action.setTitle({ title: 'Record Your Screen, Tab or Camera' });

            chrome.storage.sync.set({
                isRecording: 'false',
                openPreviewPage: 'false'
            });

            if (openPreviewOnStopRecording) {
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
        }

        if (message.action === 'recording-error') {
            console.error('Recording error:', message.error);
            setDefaults();
        }
    }
});

// --- Port-based messaging (from popup and content scripts) ---
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

            if (message.RecordRTC_Extension) {
                openPreviewOnStopRecording = false;
                openCameraPreviewDuringRecording = false;

                enableTabCaptureAPI = message['enableTabCaptureAPI'] === true;
                enableTabCaptureAPIAudioOnly = message['enableTabCaptureAPIAudioOnly'] === true;
                enableScreen = message['enableScreen'] === true;
                enableMicrophone = message['enableMicrophone'] === true;
                enableCamera = message['enableCamera'] === true;
                enableSpeakers = message['enableSpeakers'] === true;

                chrome.storage.sync.set({
                    enableTabCaptureAPI: enableTabCaptureAPI ? 'true' : 'false',
                    enableTabCaptureAPIAudioOnly: enableTabCaptureAPIAudioOnly ? 'true' : 'false',
                    enableMicrophone: enableMicrophone ? 'true' : 'false',
                    enableCamera: enableCamera ? 'true' : 'false',
                    enableScreen: enableScreen ? 'true' : 'false',
                    enableSpeakers: enableSpeakers ? 'true' : 'false',
                    isRecording: 'true'
                }, function() {
                    startRecording();
                });
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
