// VigoTechTV - Subtitles panel (preview page)
// Generates subtitles for the selected recording with local Whisper (on demand),
// shows .srt/.vtt download buttons, and uploads captions to YouTube on upload.
//
// Transcription is post-recording (see preview.whisper.js for why live is not
// possible). Cues are cached in IndexedDB under "<name>.transcript" so a recording
// is only transcribed once.

(function() {
    // Current transcript for the selected recording: { lang, cues } or null.
    window.__currentTranscript = null;

    // --- UI panel (built dynamically to avoid touching preview.html layout) ---
    var panel = document.createElement('div');
    panel.id = 'subtitles-panel';
    panel.style.cssText = [
        'position: fixed',
        'left: 10px',
        'bottom: 10px',
        'background: white',
        'border: 1px dotted red',
        'border-radius: 4px',
        'padding: 8px 12px',
        'font-size: 14px',
        'z-index: 99',
        'max-width: 320px',
        'display: none',
        'box-shadow: 0 1px 6px rgba(0,0,0,.2)'
    ].join(';');
    panel.innerHTML =
        '<div style="margin-bottom:6px;"><b>Subtítulos</b> ' +
        '<span id="subtitles-lang" style="color:#666;font-size:12px;"></span> ' +
        '<span id="subtitles-count" style="color:#666;font-size:12px;"></span></div>' +
        '<button id="subtitles-generate" style="cursor:pointer;padding:4px 10px;border:1px solid red;background:#fff;color:red;border-radius:3px;">Generar subtítulos</button>' +
        '<div id="subtitles-links" style="display:none;">' +
        '<a href="#" id="subtitles-srt" style="color:red;text-decoration:underline;cursor:pointer;margin-right:12px;">⬇ .srt</a>' +
        '<a href="#" id="subtitles-vtt" style="color:red;text-decoration:underline;cursor:pointer;">⬇ .vtt</a>' +
        '</div>' +
        '<div id="subtitles-progress" style="display:none;color:#666;font-size:12px;margin-top:6px;"></div>' +
        '<div id="subtitles-status" style="color:green;font-size:12px;margin-top:6px;"></div>';
    (document.body || document.documentElement).appendChild(panel);

    var btnGenerate = document.getElementById('subtitles-generate');
    var linksBox = document.getElementById('subtitles-links');
    var progressBox = document.getElementById('subtitles-progress');
    var statusBox = document.getElementById('subtitles-status');

    // Transcription settings (set defaults; refreshed from storage below).
    var settings = { lang: 'es-ES', size: 'base', enabled: true };
    if (typeof chrome !== 'undefined' && chrome.storage) {
        chrome.storage.sync.get(null, function(items) {
            if (items['transcriptionLang']) settings.lang = items['transcriptionLang'];
            if (items['transcriptionModel']) settings.size = items['transcriptionModel'];
            settings.enabled = (typeof items['enableTranscription'] === 'undefined') ||
                items['enableTranscription'] === 'true';
        });
    }

    function baseName() {
        if (window.file && window.file.name) {
            return window.file.name.replace(/\.[^.]+$/, '');
        }
        return 'subtitulos';
    }

    function download(filename, text, mime) {
        var blob = new Blob([text], { type: mime + ';charset=utf-8' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        setTimeout(function() {
            URL.revokeObjectURL(url);
            if (a.parentNode) a.parentNode.removeChild(a);
        }, 1000);
    }

    document.getElementById('subtitles-srt').onclick = function(e) {
        e.preventDefault();
        if (!window.__currentTranscript) return;
        download(baseName() + '.srt', Subtitles.buildSRT(window.__currentTranscript.cues), 'text/plain');
    };

    document.getElementById('subtitles-vtt').onclick = function(e) {
        e.preventDefault();
        if (!window.__currentTranscript) return;
        download(baseName() + '.vtt', Subtitles.buildVTT(window.__currentTranscript.cues), 'text/vtt');
    };

    // --- Panel states ---

    function showReady(data) {
        window.__currentTranscript = data;
        document.getElementById('subtitles-lang').textContent = '(' + (data.lang || '') + ')';
        document.getElementById('subtitles-count').textContent = data.cues.length + ' líneas';
        btnGenerate.style.display = 'none';
        progressBox.style.display = 'none';
        linksBox.style.display = 'block';
        panel.style.display = 'block';
    }

    function showGenerateButton() {
        window.__currentTranscript = null;
        document.getElementById('subtitles-lang').textContent = '';
        document.getElementById('subtitles-count').textContent = '';
        btnGenerate.style.display = 'inline-block';
        btnGenerate.disabled = false;
        btnGenerate.textContent = 'Generar subtítulos';
        linksBox.style.display = 'none';
        progressBox.style.display = 'none';
        statusBox.textContent = '';
        panel.style.display = 'block';
    }

    function hidePanel() {
        panel.style.display = 'none';
    }

    function setProgress(text) {
        progressBox.style.display = 'block';
        progressBox.textContent = text;
    }

    // --- Generate button: run Whisper on the current recording ---
    btnGenerate.onclick = function() {
        if (!window.file) {
            statusBox.style.color = '#b00';
            statusBox.textContent = 'No hay grabación seleccionada.';
            return;
        }
        if (!window.VigoWhisper || !window.VigoWhisper.available) {
            statusBox.style.color = '#b00';
            statusBox.textContent = 'El motor de transcripción no se cargó.';
            return;
        }

        btnGenerate.disabled = true;
        btnGenerate.textContent = 'Generando…';
        statusBox.style.color = 'green';
        statusBox.textContent = '';
        var currentName = window.file.name;

        setProgress('Preparando…');

        window.VigoWhisper.transcribe(window.file, {
            lang: settings.lang,
            size: settings.size,
            onProgress: function(p) {
                if (p.stage === 'audio') {
                    setProgress('Extrayendo audio de la grabación…');
                } else if (p.stage === 'model') {
                    if (typeof p.progress === 'number') {
                        setProgress('Descargando modelo Whisper… ' + Math.round(p.progress) + '%');
                    } else {
                        setProgress('Cargando modelo Whisper…');
                    }
                } else if (p.stage === 'transcribe') {
                    setProgress('Transcribiendo audio… (puede tardar según la duración)');
                } else if (p.stage === 'done') {
                    setProgress('Listo: ' + p.count + ' líneas');
                }
            }
        }).then(function(data) {
            if (!data.cues.length) {
                btnGenerate.disabled = false;
                btnGenerate.textContent = 'Generar subtítulos';
                setProgress('');
                statusBox.style.color = '#b00';
                statusBox.textContent = 'No se detectó voz en la grabación.';
                return;
            }

            // Persist so we only transcribe once.
            DiskStorage.Store({ key: currentName + '.transcript', value: data }, function() {
                // Only swap to ready state if the user is still on the same recording.
                if (window.file && window.file.name === currentName) {
                    showReady(data);
                    statusBox.style.color = 'green';
                    statusBox.textContent = '✓ Subtítulos generados';
                }
            });
        }).catch(function(err) {
            console.error('Whisper transcription failed:', err);
            btnGenerate.disabled = false;
            btnGenerate.textContent = 'Reintentar';
            setProgress('');
            statusBox.style.color = '#b00';
            statusBox.textContent = 'Error: ' + (err && err.message ? err.message : err);
        });
    };

    // Called by preview.js whenever a recording is selected.
    window.onTranscriptForFile = function(file, item) {
        window.__currentTranscript = null;
        hidePanel();
        if (!file || !item || !item.name) return;
        if (!settings.enabled) return;

        DiskStorage.Fetch(item.name + '.transcript', function(data) {
            if (data && data !== 'success' && data.cues && data.cues.length) {
                showReady(data);
            } else {
                // No cached transcript yet -> offer to generate it.
                showGenerateButton();
            }
        });
    };

    // --- YouTube caption upload (called from preview.youtube.upload.js) ---
    // Requires the "youtube.force-ssl" OAuth scope (declared in manifest.json).
    window.uploadCaptionsToYouTube = function(videoId, accessToken, callback) {
        callback = callback || function() {};
        var data = window.__currentTranscript;
        if (!data || !data.cues || !data.cues.length) {
            callback('no-transcript');
            return;
        }

        var srt = Subtitles.buildSRT(data.cues);
        var language = (data.lang || 'es').split('-')[0];
        var metadata = {
            snippet: {
                videoId: videoId,
                language: language,
                name: 'Auto (VigoTechTV)',
                isDraft: false
            }
        };

        var boundary = 'vtcaption' + Math.random().toString(36).slice(2);
        var body =
            '--' + boundary + '\r\n' +
            'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
            JSON.stringify(metadata) + '\r\n' +
            '--' + boundary + '\r\n' +
            'Content-Type: application/octet-stream\r\n\r\n' +
            srt + '\r\n' +
            '--' + boundary + '--';

        if (statusBox) statusBox.textContent = 'Subiendo subtítulos a YouTube...';

        var xhr = new XMLHttpRequest();
        xhr.open('POST', 'https://www.googleapis.com/upload/youtube/v3/captions?part=snippet&uploadType=multipart', true);
        xhr.setRequestHeader('Authorization', 'Bearer ' + accessToken);
        xhr.setRequestHeader('Content-Type', 'multipart/related; boundary=' + boundary);
        xhr.onload = function() {
            if (xhr.status >= 200 && xhr.status < 300) {
                if (statusBox) statusBox.textContent = '✓ Subtítulos subidos a YouTube';
                callback('ok');
            } else {
                console.error('Caption upload failed:', xhr.status, xhr.responseText);
                if (statusBox) statusBox.textContent = '⚠ No se pudieron subir los subtítulos';
                callback('error', xhr.responseText);
            }
        };
        xhr.onerror = function() {
            if (statusBox) statusBox.textContent = '⚠ Error de red subiendo subtítulos';
            callback('error');
        };
        xhr.send(body);
    };
})();
