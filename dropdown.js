var runtimePort = chrome.runtime.connect({
    name: location.href.replace(/\/|:|#|\?|\$|\^|%|\.|`|~|!|\+|@|\[|\||]|\|*. /g, '').split('\n').join('').split('\r').join('')
});

runtimePort.onMessage.addListener(function(message) {
    if (!message || !message.messageFromContentScript1234) return;
});

// --- UI State ---

chrome.storage.sync.get('isRecording', function(obj) {
    var recording = obj.isRecording === 'true';
    document.getElementById('default-section').style.display = recording ? 'none' : 'block';
    document.getElementById('stop-section').style.display = recording ? 'block' : 'none';

    if (recording) {
        document.getElementById('btn-stop').click();
    }
});

// --- Build config from UI toggles ---

function buildConfig() {
    var source = document.querySelector('input[name="source"]:checked').value;
    var isTab = source === 'tab';

    return {
        enableTabCaptureAPI: isTab ? 'true' : 'false',
        enableTabCaptureAPIAudioOnly: 'false',
        enableMicrophone: document.getElementById('opt-mic').checked ? 'true' : 'false',
        enableCamera: document.getElementById('opt-camera').checked ? 'true' : 'false',
        enableScreen: isTab ? 'false' : 'true',
        enableSpeakers: document.getElementById('opt-speakers').checked ? 'true' : 'false',
        isRecording: 'true'
    };
}

// --- Start ---

document.getElementById('btn-start').onclick = function() {
    var config = buildConfig();
    chrome.storage.sync.set(config, function() {
        runtimePort.postMessage({
            messageFromContentScript1234: true,
            startRecording: true,
            dropdown: true
        });
        window.close();
    });
};

// --- Stop ---

document.getElementById('btn-stop').onclick = function() {
    chrome.storage.sync.set({ isRecording: 'false' }, function() {
        runtimePort.postMessage({
            messageFromContentScript1234: true,
            stopRecording: true,
            dropdown: true
        });
        window.close();
    });
};

// --- Options link ---

document.getElementById('btn-options').onclick = function(e) {
    e.preventDefault();
    chrome.tabs.create({ url: this.href });
};
