// VigoTechTV - Whisper transcription (local, in-browser)
//
// Live Web Speech transcription is NOT viable in this extension: during a
// recording, getUserMedia holds the microphone in the offscreen document and
// Chrome denies webkitSpeechRecognition with "not-allowed" (it cannot share the
// mic in the same document). So instead we transcribe the ALREADY-RECORDED audio
// afterwards, on demand, using Whisper running locally via transformers.js (WASM).
// Free, private (audio never leaves the browser), works for screen/tab/camera.
//
// This is an ES module. It exposes window.VigoWhisper.transcribe(blob, opts) and
// fires a "vigowhisper-ready" event once loaded. The classic-script subtitles
// panel (preview.subtitles.js) calls into it.

import { pipeline, env } from '../vendor/transformers.min.js';

// Models are fetched from the Hugging Face hub on first use and cached by the
// browser. We bundle no model weights (keeps the extension small).
env.allowLocalModels = false;
env.useBrowserCache = true;

// Run ONNX single-threaded to stay within the extension CSP (threaded mode spawns
// a blob-URL worker, which MV3 extension pages block). The ONNX runtime (.mjs glue
// + .wasm) MUST be served from the extension itself: the extension CSP forbids
// loading remote scripts, so we bundle ort-wasm-simd-threaded.jsep.{mjs,wasm} in
// vendor/ and point wasmPaths at chrome-extension://<id>/vendor/.
env.backends.onnx.wasm.numThreads = 1;
env.backends.onnx.wasm.proxy = false;
env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL('vendor/');

// Our locale codes -> Whisper language names.
var LANG_MAP = {
    'es-ES': 'spanish', 'es-MX': 'spanish', 'gl-ES': 'galician',
    'ca-ES': 'catalan', 'en-US': 'english', 'en-GB': 'english',
    'pt-PT': 'portuguese', 'fr-FR': 'french', 'de-DE': 'german', 'it-IT': 'italian'
};

// Quality/speed tiers -> model repo.
var MODEL_MAP = {
    tiny: 'Xenova/whisper-tiny',
    base: 'Xenova/whisper-base',
    small: 'Xenova/whisper-small'
};

var _pipe = null;
var _pipeModel = null;

async function getPipe(modelId, onProgress) {
    if (_pipe && _pipeModel === modelId) return _pipe;
    _pipe = await pipeline('automatic-speech-recognition', modelId, {
        device: 'wasm',
        dtype: 'q8',
        progress_callback: onProgress
    });
    _pipeModel = modelId;
    return _pipe;
}

// Decode the recording's audio track to 16 kHz mono Float32 (what Whisper wants).
async function decodeAudio(blob) {
    var buf = await blob.arrayBuffer();
    var Ctx = window.AudioContext || window.webkitAudioContext;
    var ctx = new Ctx({ sampleRate: 16000 });
    try {
        var audioBuffer = await ctx.decodeAudioData(buf);
        // Channel 0 is enough for speech (and Whisper is mono anyway).
        var data = audioBuffer.getChannelData(0);
        // Copy out before closing the context.
        return new Float32Array(data);
    } finally {
        try { ctx.close(); } catch (e) {}
    }
}

window.VigoWhisper = {
    available: true,

    // transcribe(blob, { lang, size, onProgress }) -> { lang, cues:[{start,end,text}] }
    transcribe: async function(blob, opts) {
        opts = opts || {};
        var modelId = MODEL_MAP[opts.size] || MODEL_MAP.base;
        var language = LANG_MAP[opts.lang] || 'spanish';
        var onProgress = opts.onProgress || function() {};

        onProgress({ stage: 'audio' });
        var audio = await decodeAudio(blob);
        if (!audio || !audio.length) {
            throw new Error('No se pudo extraer audio de la grabación.');
        }

        onProgress({ stage: 'model' });
        var transcriber = await getPipe(modelId, function(p) {
            // p: { status, file, progress, loaded, total }
            if (p && p.status === 'progress' && typeof p.progress === 'number') {
                onProgress({ stage: 'model', file: p.file, progress: p.progress });
            }
        });

        onProgress({ stage: 'transcribe' });
        var output = await transcriber(audio, {
            language: language,
            task: 'transcribe',
            return_timestamps: true,
            chunk_length_s: 30,
            stride_length_s: 5
        });

        var chunks = (output && output.chunks) || [];
        var cues = chunks.map(function(c) {
            var t = c.timestamp || [];
            var start = typeof t[0] === 'number' ? t[0] : 0;
            var end = typeof t[1] === 'number' ? t[1] : start + 2;
            return { start: start, end: end, text: (c.text || '').trim() };
        }).filter(function(c) { return c.text; });

        onProgress({ stage: 'done', count: cues.length });
        return { lang: opts.lang || 'es-ES', cues: cues };
    }
};

window.dispatchEvent(new Event('vigowhisper-ready'));
