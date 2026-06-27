// VigoTechTV - Meetup summary / minutes (local LLM)
//
// Turns the Whisper transcript into a Markdown "acta" (summary, key points,
// tools mentioned, links) using a small instruct LLM running locally in the
// browser via transformers.js (same ONNX runtime bundled in vendor/). Nothing
// is sent to a server; the model is downloaded once from the HF hub and cached.
//
// ES module. Exposes window.VigoSummary.generate(text, opts) and fires
// "vigosummary-ready" when loaded. Called from preview.subtitles.js.

import { pipeline, env } from '../vendor/transformers.min.js';

// (env is shared with preview.whisper.js since it's the same module instance,
// but we re-assert the essentials so this module works regardless of load order.)
env.allowLocalModels = false;
env.useBrowserCache = true;
env.backends.onnx.wasm.numThreads = 1;
env.backends.onnx.wasm.proxy = false;
env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL('vendor/');

// Quality/speed tiers -> instruct model (multilingual, good Spanish).
var MODEL_MAP = {
    small: 'onnx-community/Qwen2.5-0.5B-Instruct',
    large: 'onnx-community/Qwen2.5-1.5B-Instruct'
};

var LANG_NAMES = {
    'es-ES': 'español', 'es-MX': 'español', 'gl-ES': 'gallego',
    'ca-ES': 'catalán', 'en-US': 'English', 'en-GB': 'English',
    'pt-PT': 'portugués', 'fr-FR': 'francés', 'de-DE': 'alemán', 'it-IT': 'italiano'
};

var _gen = null;
var _genModel = null;
var _genDevice = null;

async function getGenerator(modelId, onProgress) {
    if (_gen && _genModel === modelId) return _gen;

    // Prefer WebGPU (much faster); fall back to WASM if unavailable/unsupported.
    var device = (typeof navigator !== 'undefined' && navigator.gpu) ? 'webgpu' : 'wasm';
    try {
        _gen = await pipeline('text-generation', modelId, {
            device: device, dtype: 'q4', progress_callback: onProgress
        });
        _genDevice = device;
    } catch (e) {
        if (device === 'webgpu') {
            console.warn('Summary: WebGPU failed, falling back to WASM.', e);
            _gen = await pipeline('text-generation', modelId, {
                device: 'wasm', dtype: 'q4', progress_callback: onProgress
            });
            _genDevice = 'wasm';
        } else {
            throw e;
        }
    }
    _genModel = modelId;
    return _gen;
}

async function chat(generator, system, user, maxNew) {
    var messages = [
        { role: 'system', content: system },
        { role: 'user', content: user }
    ];
    var out = await generator(messages, {
        max_new_tokens: maxNew,
        do_sample: false,
        temperature: 0,
        repetition_penalty: 1.1
    });
    var gen = out && out[0] && out[0].generated_text;
    if (Array.isArray(gen)) {
        return (gen[gen.length - 1].content || '').trim();
    }
    return ('' + (gen || '')).trim();
}

function chunkText(text, size) {
    var chunks = [];
    for (var i = 0; i < text.length; i += size) {
        chunks.push(text.slice(i, i + size));
    }
    return chunks;
}

function structurePrompt(langName) {
    return 'Redacta el resultado en ' + langName + ' y en formato Markdown, con EXACTAMENTE estas secciones:\n\n' +
        '## Resumen\n(2-4 frases)\n\n' +
        '## Puntos clave\n(viñetas)\n\n' +
        '## Herramientas y proyectos mencionados\n(viñetas; si no hay, escribe "—")\n\n' +
        '## Enlaces\n(viñetas con URLs si las hay; si no, "—")\n\n' +
        'No inventes datos que no aparezcan en el contenido.';
}

// Build final markdown: title + body + any literal URLs found in the transcript.
function assembleMarkdown(title, body, text) {
    var md = '# ' + title + '\n\n' + body.trim() + '\n';
    var urls = (text.match(/https?:\/\/[^\s)"']+/gi) || [])
        .map(function(u) { return u.replace(/[.,;:!?]+$/, ''); });
    if (urls.length) {
        var uniq = Array.from(new Set(urls));
        md += '\n<!-- URLs detectadas en la transcripción -->\n';
        uniq.forEach(function(u) { md += '- ' + u + '\n'; });
    }
    return md;
}

// --- Local provider (transformers.js) ---
async function generateLocal(text, opts) {
    var modelId = MODEL_MAP[opts.model] || MODEL_MAP.small;
    var langName = LANG_NAMES[opts.lang] || 'español';
    var title = opts.title || 'Resumen del meetup';
    var onProgress = opts.onProgress || function() {};

    onProgress({ stage: 'model' });
    var gen = await getGenerator(modelId, function(p) {
        if (p && p.status === 'progress' && typeof p.progress === 'number') {
            onProgress({ stage: 'model', file: p.file, progress: p.progress });
        }
    });
    window.VigoSummary.device = _genDevice;

    var chunks = chunkText(text, 3500);
    var body;

    if (chunks.length === 1) {
        onProgress({ stage: 'reduce' });
        var sysOne = 'Eres un editor técnico que redacta actas de charlas. Sé fiel al contenido y conciso.';
        var usrOne = 'A partir de esta transcripción de un meetup, redacta el acta.\n\n' +
            structurePrompt(langName) + '\n\nTranscripción:\n"""' + text + '"""';
        body = await chat(gen, sysOne, usrOne, 700);
    } else {
        var notes = [];
        for (var i = 0; i < chunks.length; i++) {
            onProgress({ stage: 'map', index: i, total: chunks.length });
            var sysM = 'Eres un asistente que toma notas de charlas técnicas. Responde en ' +
                langName + '. Sé conciso y fiel; no inventes.';
            var usrM = 'De este fragmento de la transcripción de un meetup, extrae en viñetas: ' +
                'puntos clave, herramientas/proyectos/tecnologías mencionados, y enlaces o ' +
                'nombres propios relevantes. Solo viñetas.\n\nFragmento:\n"""' + chunks[i] + '"""';
            notes.push(await chat(gen, sysM, usrM, 350));
        }
        onProgress({ stage: 'reduce' });
        var sysR = 'Eres un editor técnico. No inventes datos que no estén en las notas.';
        var usrR = 'Con estas notas de un meetup, redacta el acta.\n\n' +
            structurePrompt(langName) + '\n\nNotas:\n"""' + notes.join('\n') + '"""';
        body = await chat(gen, sysR, usrR, 700);
    }

    return assembleMarkdown(title, body, text);
}

// --- OpenAI provider (external API; transcript is sent to OpenAI) ---
async function generateOpenAI(text, opts) {
    var apiKey = (opts.apiKey || '').trim();
    if (!apiKey) throw new Error('Falta la API key de OpenAI (configúrala en Opciones).');

    var model = opts.openaiModel || 'gpt-4o-mini';
    var langName = LANG_NAMES[opts.lang] || 'español';
    var title = opts.title || 'Resumen del meetup';
    var onProgress = opts.onProgress || function() {};

    // OpenAI models have large context, but cap pathological lengths.
    var MAX_CHARS = 100000;
    if (text.length > MAX_CHARS) text = text.slice(0, MAX_CHARS);

    onProgress({ stage: 'reduce' });
    var system = 'Eres un editor técnico que redacta actas de charlas. No inventes datos que no estén en la transcripción.';
    var user = 'A partir de esta transcripción de un meetup, redacta el acta.\n\n' +
        structurePrompt(langName) + '\n\nTranscripción:\n"""' + text + '"""';

    var resp = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + apiKey
        },
        body: JSON.stringify({
            model: model,
            temperature: 0,
            messages: [
                { role: 'system', content: system },
                { role: 'user', content: user }
            ]
        })
    });

    if (!resp.ok) {
        var detail = '';
        try {
            var errJson = JSON.parse(await resp.text());
            detail = (errJson.error && errJson.error.message) || '';
        } catch (e) {}
        throw new Error('OpenAI ' + resp.status + (detail ? ': ' + detail : ''));
    }

    var data = await resp.json();
    var body = (data.choices && data.choices[0] && data.choices[0].message &&
                data.choices[0].message.content || '').trim();
    if (!body) throw new Error('Respuesta vacía de OpenAI.');

    window.VigoSummary.device = 'openai:' + model;
    onProgress({ stage: 'done' });
    return assembleMarkdown(title, body, text);
}

window.VigoSummary = {
    available: true,
    device: null,

    // generate(text, { provider, lang, model, openaiModel, apiKey, title, onProgress })
    generate: async function(text, opts) {
        opts = opts || {};
        text = (text || '').replace(/\s+/g, ' ').trim();
        if (!text) throw new Error('La transcripción está vacía.');

        if (opts.provider === 'openai') {
            return generateOpenAI(text, opts);
        }
        return generateLocal(text, opts);
    }
};

window.dispatchEvent(new Event('vigosummary-ready'));
