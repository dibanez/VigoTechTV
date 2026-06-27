var port;
try {
    port = chrome.runtime.connect();
} catch (e) {
    // Extension context invalidated (e.g. on chrome:// pages)
}

if (port) {
    port.onMessage.addListener(function(message) {
        message.messageFromContentScript1234 = true;
        window.postMessage(message, '*');
    });

    port.onDisconnect.addListener(function() {
        port = null;
    });

    window.addEventListener('message', function(event) {
        if (event.source != window || !event.data.messageFromContentScript1234) return;
        if (port) {
            port.postMessage(event.data);
        }
    });

    // Ctrl+Space to stop the recording
    var isControlKeyPressed;
    window.addEventListener('keydown', function(e) {
        var keyCode = e.which || e.keyCode || 0;
        if (keyCode === 17) {
            isControlKeyPressed = true;
        }
    }, false);

    window.addEventListener('keyup', function(e) {
        var keyCode = e.which || e.keyCode || 0;

        if (isControlKeyPressed && keyCode === 32) {
            if (port) {
                port.postMessage({
                    messageFromContentScript1234: true,
                    stopRecording: true,
                    dropdown: true
                });
            }
            e.preventDefault();
            e.stopPropagation();
            return false;
        }

        if (keyCode === 17) {
            isControlKeyPressed = false;
        }
    }, false);

    var script = document.createElement('script');
    script.src = chrome.runtime.getURL('injected.js');
    (document.head || document.body || document.documentElement).appendChild(script);
    script.onload = function() {
        script.remove();
    };
}
