'use strict';

const { getPixaiArtifact, getPixaiProfile, PIXAI_PROFILE_ID } = require('./pluginModelRegistry.cjs');

const WIDTH = 448;
const HEIGHT = 448;
const LABEL_COUNT = 13_461;
const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 64_000_000;
const MAX_SIDECAR_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_RESULTS = 500;
const DEFAULT_THRESHOLDS = Object.freeze({ general: 0.30, character: 0.85 });
const CSV_HEADER = Object.freeze(['id', 'tag_id', 'name', 'category', 'count', 'ips']);

function fail() {
    throw new Error('PixAI inference failed');
}

function unavailable() {
    throw new Error('PixAI inference unavailable');
}

function aborted() {
    throw new Error('PixAI inference aborted');
}

function ownData(value, keys) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) fail();
    const found = Reflect.ownKeys(value);
    if (found.length !== keys.length || found.some((key) => typeof key !== 'string' || !keys.includes(key))) fail();
    const result = Object.create(null);
    for (const key of keys) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) fail();
        result[key] = descriptor.value;
    }
    return result;
}

function optionalData(value, keys) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) fail();
    const found = Reflect.ownKeys(value);
    if (found.some((key) => typeof key !== 'string' || !keys.includes(key))) fail();
    const result = Object.create(null);
    for (const key of found) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) fail();
        result[key] = descriptor.value;
    }
    return result;
}

function exactArray(value, expected) {
    if (!Array.isArray(value) || value.length !== expected.length) fail();
    for (let index = 0; index < expected.length; index += 1) {
        if (value[index] !== expected[index]) fail();
    }
}

function rejectDuplicateJsonKeys(text) {
    function whitespace(index) {
        while (index < text.length && /[\t\n\r ]/.test(text[index])) index += 1;
        return index;
    }
    function stringAt(index) {
        if (text[index] !== '"') fail();
        const start = index;
        index += 1;
        while (index < text.length) {
            if (text[index] === '\\') { index += text[index + 1] === 'u' ? 6 : 2; continue; }
            if (text[index] === '"') {
                index += 1;
                try { return [JSON.parse(text.slice(start, index)), index]; } catch { fail(); }
            }
            if (text.charCodeAt(index) < 0x20) fail();
            index += 1;
        }
        fail();
    }
    function valueAt(index) {
        index = whitespace(index);
        if (text[index] === '{') {
            const keys = new Set();
            index = whitespace(index + 1);
            if (text[index] === '}') return index + 1;
            while (true) {
                const parsed = stringAt(index);
                if (keys.has(parsed[0])) fail();
                keys.add(parsed[0]);
                index = whitespace(parsed[1]);
                if (text[index] !== ':') fail();
                index = whitespace(valueAt(index + 1));
                if (text[index] === '}') return index + 1;
                if (text[index] !== ',') fail();
                index = whitespace(index + 1);
            }
        }
        if (text[index] === '[') {
            index = whitespace(index + 1);
            if (text[index] === ']') return index + 1;
            while (true) {
                index = whitespace(valueAt(index));
                if (text[index] === ']') return index + 1;
                if (text[index] !== ',') fail();
                index = whitespace(index + 1);
            }
        }
        if (text[index] === '"') return stringAt(index)[1];
        const primitive = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(index));
        if (!primitive) fail();
        return index + primitive[0].length;
    }
    if (whitespace(valueAt(0)) !== text.length) fail();
}

function parsePreprocess(text) {
    let value;
    try { rejectDuplicateJsonKeys(text); value = JSON.parse(text); } catch { fail(); }
    const top = ownData(value, ['stages']);
    if (!Array.isArray(top.stages) || top.stages.length !== 3) fail();
    const resize = ownData(top.stages[0], ['type', 'size', 'interpolation', 'antialias', 'max_size']);
    if (resize.type !== 'resize' ||
        resize.interpolation !== 'bilinear' || resize.antialias !== null || resize.max_size !== null) fail();
    exactArray(resize.size, [WIDTH, HEIGHT]);
    const tensor = ownData(top.stages[1], ['type']);
    if (tensor.type !== 'to_tensor') fail();
    const normalize = ownData(top.stages[2], ['type', 'mean', 'std']);
    if (normalize.type !== 'normalize') fail();
    exactArray(normalize.mean, [0.5, 0.5, 0.5]);
    exactArray(normalize.std, [0.5, 0.5, 0.5]);
}

function parseCsv(text) {
    const rows = [];
    let row = [];
    let field = '';
    let quoted = false;
    let afterQuote = false;
    for (let index = 0; index < text.length; index += 1) {
        const character = text[index];
        if (quoted) {
            if (character === '"') {
                if (text[index + 1] === '"') { field += '"'; index += 1; } else { quoted = false; afterQuote = true; }
            } else {
                field += character;
            }
            continue;
        }
        if (afterQuote && character !== ',' && character !== '\n' && character !== '\r') fail();
        if (character === ',') { row.push(field); field = ''; afterQuote = false; continue; }
        if (character === '\n' || character === '\r') {
            if (character === '\r' && text[index + 1] === '\n') index += 1;
            row.push(field); rows.push(row); row = []; field = ''; afterQuote = false; continue;
        }
        if (character === '"') {
            if (field.length !== 0) fail();
            quoted = true;
            continue;
        }
        field += character;
    }
    if (quoted) fail();
    if (field.length !== 0 || row.length !== 0 || afterQuote) { row.push(field); rows.push(row); }
    if (rows.length !== LABEL_COUNT + 1) fail();
    exactArray(rows[0], CSV_HEADER);
    const tags = new Array(LABEL_COUNT);
    let general = 0;
    let character = 0;
    for (let id = 0; id < LABEL_COUNT; id += 1) {
        const values = rows[id + 1];
        if (!Array.isArray(values) || values.length !== 6 || values[0] !== String(id) ||
            !/^\d+$/.test(values[1]) || !/^\d+$/.test(values[4])) fail();
        const name = values[2];
        if (name.length === 0 || Buffer.byteLength(name, 'utf8') > 512 || name.includes('\0')) fail();
        let category;
        if (values[3] === '0') { category = 'general'; general += 1; }
        else if (values[3] === '4') { category = 'character'; character += 1; }
        else fail();
        if (Buffer.byteLength(values[5], 'utf8') > 512) fail();
        tags[id] = Object.freeze({ index: id, name, category });
    }
    if (general !== 9741 || character !== 3720) fail();
    return Object.freeze(tags);
}

async function readSidecar(store, name) {
    let descriptor;
    try { descriptor = await store.openVerified(name); } catch { unavailable(); }
    if (!descriptor || !Number.isSafeInteger(descriptor.size) || descriptor.size < 1 || descriptor.size > MAX_SIDECAR_BYTES || typeof descriptor.chunks !== 'function') fail();
    const chunks = [];
    let total = 0;
    try {
        for await (const chunk of descriptor.chunks({ chunkSize: 64 * 1024 })) {
            if (!(chunk instanceof Uint8Array) || chunk.byteLength === 0) fail();
            total += chunk.byteLength;
            if (total > descriptor.size || total > MAX_SIDECAR_BYTES) fail();
            chunks.push(Buffer.from(chunk));
        }
    } catch (error) {
        if (error && error.message === 'PixAI inference failed') throw error;
        unavailable();
    }
    if (total !== descriptor.size) fail();
    try { return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)); } catch { fail(); }
}

function validateSession(session) {
    if (!session || typeof session !== 'object' || !Array.isArray(session.inputNames) || !Array.isArray(session.outputNames) ||
        session.inputNames.length !== 1 || session.outputNames.length !== 1 ||
        typeof session.inputNames[0] !== 'string' || session.inputNames[0].length === 0 ||
        typeof session.outputNames[0] !== 'string' || session.outputNames[0].length === 0 || typeof session.run !== 'function') fail();
    return Object.freeze({ inputName: session.inputNames[0], outputName: session.outputNames[0] });
}

function validateRunOptions(options) {
    if (options === undefined) return { categories: new Set(['general', 'character']), thresholds: DEFAULT_THRESHOLDS, maxResults: DEFAULT_MAX_RESULTS, signal: undefined };
    const input = optionalData(options, ['categories', 'thresholds', 'maxResults', 'signal']);
    const rawCategories = input.categories === undefined ? ['general', 'character'] : input.categories;
    if (!Array.isArray(rawCategories) || rawCategories.length < 1 || rawCategories.length > 2) fail();
    const categories = new Set();
    for (const category of rawCategories) {
        if (category !== 'general' && category !== 'character' || categories.has(category)) fail();
        categories.add(category);
    }
    const rawThresholds = input.thresholds === undefined ? Object.create(null) : optionalData(input.thresholds, ['general', 'character']);
    const thresholds = Object.create(null);
    for (const category of ['general', 'character']) {
        const value = rawThresholds[category] === undefined ? DEFAULT_THRESHOLDS[category] : rawThresholds[category];
        if (!Number.isFinite(value) || value < 0 || value > 1) fail();
        thresholds[category] = value;
    }
    const maxResults = input.maxResults === undefined ? DEFAULT_MAX_RESULTS : input.maxResults;
    if (!Number.isSafeInteger(maxResults) || maxResults < 1 || maxResults > 500) fail();
    if (input.signal !== undefined && (!input.signal || typeof input.signal !== 'object' || typeof input.signal.aborted !== 'boolean')) fail();
    return { categories, thresholds: Object.freeze(thresholds), maxResults, signal: input.signal };
}

function checkAbort(signal) {
    if (signal?.aborted) aborted();
}

async function preprocessImage(image, sharp, signal) {
    const decodeStarted = performance.now();
    if (!(image instanceof Uint8Array) || image.byteLength === 0 || image.byteLength > MAX_IMAGE_BYTES) fail();
    checkAbort(signal);
    let metadata;
    try {
        metadata = await sharp(Buffer.from(image), { limitInputPixels: MAX_IMAGE_PIXELS, failOn: 'error' }).metadata();
    } catch { fail(); }
    if (!metadata || !['jpeg', 'png', 'webp'].includes(metadata.format) || !Number.isSafeInteger(metadata.width) || !Number.isSafeInteger(metadata.height) || metadata.width < 1 || metadata.height < 1 || metadata.width * metadata.height > MAX_IMAGE_PIXELS) fail();
    let raw;
    try {
        raw = await sharp(Buffer.from(image), { limitInputPixels: MAX_IMAGE_PIXELS, failOn: 'error' })
            .rotate().removeAlpha().toColourspace('srgb').raw().toBuffer({ resolveWithObject: true });
    } catch { fail(); }
    if (!raw || !raw.info || raw.info.channels !== 3 || !Number.isSafeInteger(raw.info.width) || !Number.isSafeInteger(raw.info.height) || raw.info.width * raw.info.height > MAX_IMAGE_PIXELS || raw.data.byteLength !== raw.info.width * raw.info.height * 3) fail();
    const preprocessStarted = performance.now();
    const input = new Float32Array(3 * WIDTH * HEIGHT);
    for (let y = 0; y < HEIGHT; y += 1) {
        const sourceY = Math.max(0, Math.min(raw.info.height - 1, (y + 0.5) * raw.info.height / HEIGHT - 0.5));
        const y0 = Math.floor(sourceY); const y1 = Math.min(raw.info.height - 1, y0 + 1); const wy = sourceY - y0;
        for (let x = 0; x < WIDTH; x += 1) {
            const sourceX = Math.max(0, Math.min(raw.info.width - 1, (x + 0.5) * raw.info.width / WIDTH - 0.5));
            const x0 = Math.floor(sourceX); const x1 = Math.min(raw.info.width - 1, x0 + 1); const wx = sourceX - x0;
            const target = y * WIDTH + x;
            for (let channel = 0; channel < 3; channel += 1) {
                const a = raw.data[(y0 * raw.info.width + x0) * 3 + channel];
                const b = raw.data[(y0 * raw.info.width + x1) * 3 + channel];
                const c = raw.data[(y1 * raw.info.width + x0) * 3 + channel];
                const d = raw.data[(y1 * raw.info.width + x1) * 3 + channel];
                const value = a * (1 - wx) * (1 - wy) + b * wx * (1 - wy) + c * (1 - wx) * wy + d * wx * wy;
                input[channel * WIDTH * HEIGHT + target] = value / 127.5 - 1;
            }
        }
    }
    checkAbort(signal);
    return {
        data: input,
        decodeMs: Math.min(60_000, Math.max(0, preprocessStarted - decodeStarted)),
        preprocessMs: Math.min(60_000, Math.max(0, performance.now() - preprocessStarted)),
    };
}

function createPluginModelInference(options) {
    const input = optionalData(options, ['store', 'ort', 'sharp']);
    if (!input.store || typeof input.store !== 'object' || typeof input.store.openVerified !== 'function' || typeof input.store.openVerifiedFile !== 'function') fail();
    const profile = getPixaiProfile(PIXAI_PROFILE_ID);
    const model = getPixaiArtifact(PIXAI_PROFILE_ID, 'model.onnx');
    let disposed = false;
    let session;
    let sessionInfo;
    let tags;
    let initializing;

    async function initializeInner() {
        const [preprocessText, tagsText] = await Promise.all([
            readSidecar(input.store, 'preprocess.json'), readSidecar(input.store, 'selected_tags.csv'),
        ]);
        parsePreprocess(preprocessText);
        const parsedTags = parseCsv(tagsText);
        let modelFile;
        try { modelFile = await input.store.openVerifiedFile('model.onnx'); } catch { unavailable(); }
        if (!modelFile || typeof modelFile.path !== 'string' || !Number.isSafeInteger(modelFile.size) || modelFile.size !== model.bytes) unavailable();
        let created;
        try {
            const ort = input.ort === undefined ? require('onnxruntime-node') : input.ort;
            if (!ort || !ort.InferenceSession || typeof ort.InferenceSession.create !== 'function' || typeof ort.Tensor !== 'function') unavailable();
            created = await ort.InferenceSession.create(modelFile.path, { executionProviders: ['cpu'] });
            const info = validateSession(created);
            if (disposed) {
                if (typeof created.release === 'function') await created.release();
                created = undefined;
                unavailable();
            }
            session = created; sessionInfo = info; tags = parsedTags;
        } catch (error) {
            if (created && typeof created.release === 'function') { try { await created.release(); } catch {} }
            if (error && error.message === 'PixAI inference unavailable') throw error;
            fail();
        }
    }

    async function initialize() {
        if (disposed) unavailable();
        if (session) return;
        if (!initializing) initializing = initializeInner().catch((error) => { initializing = undefined; throw error; });
        try { await initializing; } catch (error) {
            if (error && (error.message === 'PixAI inference failed' || error.message === 'PixAI inference unavailable')) unavailable();
            unavailable();
        }
    }

    return Object.freeze({
        async initialize() { await initialize(); },
        async run(image, options) {
            const started = performance.now();
            try {
                const runOptions = validateRunOptions(options);
                checkAbort(runOptions.signal);
                await initialize();
                checkAbort(runOptions.signal);
                const sharp = input.sharp === undefined ? require('sharp') : input.sharp;
                if (typeof sharp !== 'function') fail();
                const preprocessed = await preprocessImage(image, sharp, runOptions.signal);
                const ort = input.ort === undefined ? require('onnxruntime-node') : input.ort;
                const tensor = new ort.Tensor('float32', preprocessed.data, [1, 3, HEIGHT, WIDTH]);
                const inferenceStarted = performance.now();
                const outputs = await session.run({ [sessionInfo.inputName]: tensor });
                const inferenceMs = Math.min(60_000, Math.max(0, performance.now() - inferenceStarted));
                checkAbort(runOptions.signal);
                const output = outputs?.[sessionInfo.outputName];
                if (!output || output.type !== 'float32' || !(output.data instanceof Float32Array) || !Array.isArray(output.dims) || output.dims.length !== 2 || output.dims[0] !== 1 || output.dims[1] !== LABEL_COUNT || output.data.length !== LABEL_COUNT) fail();
                const postprocessStarted = performance.now();
                const qualified = [];
                for (let index = 0; index < LABEL_COUNT; index += 1) {
                    const score = output.data[index];
                    if (!Number.isFinite(score)) fail();
                    const tag = tags[index];
                    if (runOptions.categories.has(tag.category) && score >= runOptions.thresholds[tag.category]) qualified.push({ ...tag, score });
                }
                qualified.sort((left, right) => right.score - left.score || left.index - right.index);
                const truncated = qualified.length > runOptions.maxResults;
                const resultTags = qualified.slice(0, runOptions.maxResults);
                return Object.freeze({
                    modelProfileId: profile.id,
                    modelRevision: profile.revision,
                    modelSha256: model.sha256,
                    preprocessVersion: profile.preprocessing.version,
                    provider: 'node',
                    tags: Object.freeze(resultTags.map(Object.freeze)),
                    thresholds: Object.freeze({ general: runOptions.thresholds.general, character: runOptions.thresholds.character }),
                    truncated,
                    timings: Object.freeze({
                        decodeMs: preprocessed.decodeMs,
                        preprocessMs: preprocessed.preprocessMs,
                        inferenceMs,
                        postprocessMs: Math.min(60_000, Math.max(0, performance.now() - postprocessStarted)),
                        totalMs: Math.min(60_000, Math.max(0, performance.now() - started)),
                    }),
                    warnings: Object.freeze([]),
                });
            } catch (error) {
                if (error && error.message === 'PixAI inference aborted') aborted();
                if (disposed) unavailable();
                fail();
            }
        },
        async dispose() {
            if (disposed) return;
            disposed = true;
            if (initializing) { try { await initializing; } catch {} }
            if (session && typeof session.release === 'function') {
                const current = session; session = undefined;
                try { await current.release(); } catch { unavailable(); }
            }
        },
    });
}

module.exports = { createPluginModelInference };
