chrome.storage.sync.get(null, function(items) {
    if (items['videoCodec']) {
        querySelectorAll('#videoCodec input').forEach(function(input) {
            var codec = input.parentNode.textContent;
            if (codec !== items['videoCodec']) {
                input.checked = false;
                return;
            }
            input.checked = true;
        });
    } else {
        chrome.storage.sync.set({
            videoCodec: 'Default'
        }, function() {
            querySelectorAll('#videoCodec input')[0].checked = true;
        });
    }

    if (items['videoMaxFrameRates'] && items['videoMaxFrameRates'] !== 'None' && items['videoMaxFrameRates'].length) {
        document.getElementById('videoMaxFrameRates').value = items['videoMaxFrameRates'];
    } else {
        chrome.storage.sync.set({
            videoMaxFrameRates: ''
        }, function() {
            document.getElementById('videoMaxFrameRates').value = 'None';
        });
    }

    if (items['bitsPerSecond']) {
        document.getElementById('bitsPerSecond').value = items['bitsPerSecond'];
    } else {
        chrome.storage.sync.set({
            bitsPerSecond: ''
        }, function() {
            document.getElementById('bitsPerSecond').value = 'default';
        });
    }

    if (items['youtube_privacy']) {
        document.getElementById('youtube_privacy').value = items['youtube_privacy'];
    } else {
        chrome.storage.sync.set({
            youtube_privacy: ''
        }, function() {
            document.getElementById('youtube_privacy').value = 'public';
        });
    }

    if (items['videoResolutions']) {
        document.getElementById('videoResolutions').value = items['videoResolutions'];
    } else {
        chrome.storage.sync.set({
            videoResolutions: '1920x1080'
        }, function() {
            document.getElementById('videoResolutions').value = '1920x1080';
        });
    }

    if (items['logoPosition']) {
        document.getElementById('logoPosition').value = items['logoPosition'];
    }

    if (items['logoSize']) {
        document.getElementById('logoSize').value = items['logoSize'];
    }

    if (items['pipPosition']) {
        document.getElementById('pipPosition').value = items['pipPosition'];
    }

    if (items['layoutMode']) {
        document.getElementById('layoutMode').value = items['layoutMode'];
    }

    if (items['cameraSize']) {
        document.getElementById('cameraSize').value = items['cameraSize'];
    }

    // Default transcription to ON unless explicitly disabled.
    document.getElementById('enableTranscription').checked =
        (typeof items['enableTranscription'] === 'undefined') || items['enableTranscription'] === 'true';

    if (items['transcriptionLang']) {
        document.getElementById('transcriptionLang').value = items['transcriptionLang'];
    }

    if (items['transcriptionModel']) {
        document.getElementById('transcriptionModel').value = items['transcriptionModel'];
    }

    document.getElementById('enableSummary').checked =
        (typeof items['enableSummary'] === 'undefined') || items['enableSummary'] === 'true';

    if (items['summaryModel']) {
        document.getElementById('summaryModel').value = items['summaryModel'];
    }

    if (items['summaryProvider']) {
        document.getElementById('summaryProvider').value = items['summaryProvider'];
    }

    if (items['openaiModel']) {
        document.getElementById('openaiModel').value = items['openaiModel'];
    }
});

// API key is a secret: keep it in local storage (not synced across devices).
chrome.storage.local.get('openaiApiKey', function(items) {
    if (items['openaiApiKey']) {
        document.getElementById('openaiApiKey').value = items['openaiApiKey'];
    }
});

// Load logo preview from local storage
chrome.storage.local.get('logoDataUri', function(items) {
    if (items['logoDataUri']) {
        document.getElementById('logo-preview').src = items['logoDataUri'];
        document.getElementById('logo-preview').style.display = 'inline-block';
        document.getElementById('logo-remove').style.display = 'inline-block';
    }
});

function querySelectorAll(selector) {
    return Array.prototype.slice.call(document.querySelectorAll(selector));
}

querySelectorAll('#videoCodec input').forEach(function(input) {
    input.onchange = function() {
        querySelectorAll('#videoCodec input').forEach(function(input) {
            input.checked = false;
        });

        this.checked = true;

        var codec = this.parentNode.textContent;

        showSaving();
        chrome.storage.sync.set({
            videoCodec: codec
        }, function() {
            hideSaving();
        });
    };
});

document.getElementById('videoMaxFrameRates').onchange = function() {
    this.disabled = true;

    showSaving();
    chrome.storage.sync.set({
        videoMaxFrameRates: this.value === 'None' ? '' : this.value
    }, function() {
        document.getElementById('videoMaxFrameRates').disabled = false;
        hideSaving();
    });
};

document.getElementById('bitsPerSecond').onchange = function() {
    this.disabled = true;
    showSaving();
    chrome.storage.sync.set({
        bitsPerSecond: this.value === 'default' ? '' : this.value
    }, function() {
        document.getElementById('bitsPerSecond').disabled = false;
        hideSaving();
    });
};

document.getElementById('youtube_privacy').onchange = function() {
    this.disabled = true;
    showSaving();
    chrome.storage.sync.set({
        youtube_privacy: this.value === 'public' ? '' : this.value
    }, function() {
        document.getElementById('youtube_privacy').disabled = false;
        hideSaving();
    });
};

document.getElementById('videoResolutions').onchange = function() {
    this.disabled = true;
    showSaving();
    chrome.storage.sync.set({
        videoResolutions: this.value || '1920x1080'
    }, function() {
        document.getElementById('videoResolutions').disabled = false;
        hideSaving();
    });
};

function showSaving() {
    document.getElementById('applying-changes').style.display = 'block';
}

function hideSaving() {
    setTimeout(function() {
        document.getElementById('applying-changes').style.display = 'none';
    }, 700);
}

// --- Device enumeration using native API ---
function populateDevices(stream) {
    navigator.mediaDevices.enumerateDevices().then(function(devices) {
        var audioInputDevices = devices.filter(function(d) { return d.kind === 'audioinput'; });
        var videoInputDevices = devices.filter(function(d) { return d.kind === 'videoinput'; });

        chrome.storage.sync.get('microphone', function(storage) {
            audioInputDevices.forEach(function(device, idx) {
                var option = document.createElement('option');
                option.innerHTML = device.label || device.deviceId;
                option.value = device.deviceId;

                if (!storage.microphone && idx === 0) {
                    option.selected = true;
                }

                if (storage.microphone && storage.microphone === device.deviceId) {
                    option.selected = true;
                }

                document.getElementById('microphone-devices').appendChild(option);
            });
        });

        chrome.storage.sync.get('camera', function(storage) {
            videoInputDevices.forEach(function(device, idx) {
                var option = document.createElement('option');
                option.innerHTML = device.label || device.deviceId;
                option.value = device.deviceId;

                if (!storage.camera && idx === 0) {
                    option.selected = true;
                }

                if (storage.camera && storage.camera === device.deviceId) {
                    option.selected = true;
                }

                document.getElementById('camera-devices').appendChild(option);
            });
        });

        if (stream) {
            stream.getTracks().forEach(function(track) {
                track.stop();
            });
        }
    });
}

// Try to enumerate - request permissions if labels are empty
navigator.mediaDevices.enumerateDevices().then(function(devices) {
    var hasLabels = devices.some(function(d) { return d.label; });
    if (hasLabels) {
        populateDevices();
    } else {
        navigator.mediaDevices.getUserMedia({ audio: true, video: true }).then(function(stream) {
            populateDevices(stream);
        }).catch(function() {
            populateDevices();
        });
    }
});

document.getElementById('microphone-devices').onchange = function() {
    showSaving();
    chrome.storage.sync.set({
        microphone: this.value
    }, hideSaving);
};

document.getElementById('camera-devices').onchange = function() {
    showSaving();
    chrome.storage.sync.set({
        camera: this.value
    }, hideSaving);
};

document.getElementById('logo-file').onchange = function() {
    var file = this.files[0];
    if (!file) return;

    if (file.size > 2 * 1024 * 1024) {
        alert('Logo file must be smaller than 2MB');
        this.value = '';
        return;
    }

    var reader = new FileReader();
    reader.onload = function(e) {
        var dataUri = e.target.result;
        showSaving();
        chrome.storage.local.set({ logoDataUri: dataUri }, function() {
            document.getElementById('logo-preview').src = dataUri;
            document.getElementById('logo-preview').style.display = 'inline-block';
            document.getElementById('logo-remove').style.display = 'inline-block';
            hideSaving();
        });
    };
    reader.readAsDataURL(file);
};

document.getElementById('logo-remove').onclick = function() {
    showSaving();
    chrome.storage.local.remove('logoDataUri', function() {
        document.getElementById('logo-preview').style.display = 'none';
        document.getElementById('logo-preview').src = '';
        document.getElementById('logo-remove').style.display = 'none';
        document.getElementById('logo-file').value = '';
        hideSaving();
    });
};

document.getElementById('logoPosition').onchange = function() {
    this.disabled = true;
    showSaving();
    chrome.storage.sync.set({
        logoPosition: this.value
    }, function() {
        document.getElementById('logoPosition').disabled = false;
        hideSaving();
    });
};

document.getElementById('logoSize').onchange = function() {
    this.disabled = true;
    showSaving();
    chrome.storage.sync.set({
        logoSize: this.value
    }, function() {
        document.getElementById('logoSize').disabled = false;
        hideSaving();
    });
};

document.getElementById('pipPosition').onchange = function() {
    this.disabled = true;
    showSaving();
    chrome.storage.sync.set({
        pipPosition: this.value
    }, function() {
        document.getElementById('pipPosition').disabled = false;
        hideSaving();
    });
};

document.getElementById('layoutMode').onchange = function() {
    this.disabled = true;
    showSaving();
    chrome.storage.sync.set({
        layoutMode: this.value
    }, function() {
        document.getElementById('layoutMode').disabled = false;
        hideSaving();
    });
};

document.getElementById('cameraSize').onchange = function() {
    this.disabled = true;
    showSaving();
    chrome.storage.sync.set({
        cameraSize: this.value
    }, function() {
        document.getElementById('cameraSize').disabled = false;
        hideSaving();
    });
};

document.getElementById('enableTranscription').onchange = function() {
    showSaving();
    chrome.storage.sync.set({
        enableTranscription: this.checked ? 'true' : 'false'
    }, hideSaving);
};

document.getElementById('transcriptionLang').onchange = function() {
    this.disabled = true;
    showSaving();
    chrome.storage.sync.set({
        transcriptionLang: this.value || 'es-ES'
    }, function() {
        document.getElementById('transcriptionLang').disabled = false;
        hideSaving();
    });
};

document.getElementById('transcriptionModel').onchange = function() {
    this.disabled = true;
    showSaving();
    chrome.storage.sync.set({
        transcriptionModel: this.value || 'base'
    }, function() {
        document.getElementById('transcriptionModel').disabled = false;
        hideSaving();
    });
};

document.getElementById('enableSummary').onchange = function() {
    showSaving();
    chrome.storage.sync.set({
        enableSummary: this.checked ? 'true' : 'false'
    }, hideSaving);
};

document.getElementById('summaryModel').onchange = function() {
    this.disabled = true;
    showSaving();
    chrome.storage.sync.set({
        summaryModel: this.value || 'small'
    }, function() {
        document.getElementById('summaryModel').disabled = false;
        hideSaving();
    });
};

document.getElementById('summaryProvider').onchange = function() {
    this.disabled = true;
    showSaving();
    chrome.storage.sync.set({
        summaryProvider: this.value || 'local'
    }, function() {
        document.getElementById('summaryProvider').disabled = false;
        hideSaving();
    });
};

document.getElementById('openaiModel').onchange = function() {
    this.disabled = true;
    showSaving();
    chrome.storage.sync.set({
        openaiModel: this.value || 'gpt-4o-mini'
    }, function() {
        document.getElementById('openaiModel').disabled = false;
        hideSaving();
    });
};

document.getElementById('openaiApiKey').onchange = function() {
    showSaving();
    chrome.storage.local.set({
        openaiApiKey: this.value.trim()
    }, hideSaving);
};
