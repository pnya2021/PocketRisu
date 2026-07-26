'use strict';

const { createHash } = require('crypto');
const dns = require('dns/promises');
const https = require('https');
const net = require('net');
const {
    MAX_MODEL_ARTIFACT_CHUNK_BYTES,
} = require('./pluginModelStore.cjs');
const {
    getPixaiProfile,
} = require('./pluginModelRegistry.cjs');

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const XET_HOST = 'us.aws.cdn.hf.co';
const XET_PATH_PREFIX = '/xet-bridge-us/';
const XET_QUERY_KEYS = new Set([
    'Expires',
    'Key-Pair-Id',
    'Policy',
    'Signature',
    'X-Amz-Algorithm',
    'X-Amz-Credential',
    'X-Amz-Date',
    'X-Amz-Expires',
    'X-Amz-Security-Token',
    'X-Amz-Signature',
    'X-Amz-SignedHeaders',
    'X-Xet-Cas-Uid',
    'response-content-disposition',
    'response-content-type',
    'x-id',
]);
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DIGEST = /^[a-f0-9]{64}$/;
const MAX_ETAG_BYTES = 4_096;
const MAX_HEADER_BYTES = 128 * 1_024;
const MAX_DNS_ANSWERS = 64;
const DNS_LOOKUP_TIMEOUT_MS = 15_000;
const NETWORK_IDLE_TIMEOUT_MS = 60_000;
const MAX_OBSERVERS = 64;
const MAX_NDJSON_BYTES = 4_096;

class ModelDownloadError extends Error {
    constructor(code, message, keepPartial = false) {
        super(message);
        this.name = 'ModelDownloadError';
        this.code = code;
        this.keepPartial = keepPartial;
    }
}

function failure(code, message, keepPartial = false) {
    return new ModelDownloadError(code, message, keepPartial);
}

function isAbort(signal) {
    return signal.aborted;
}

function throwIfAborted(signal) {
    if (isAbort(signal)) throw failure('ABORTED', 'Model download aborted', true);
}

function safeError(error, fallback = 'STORAGE_ERROR') {
    if (error instanceof ModelDownloadError) return error;
    return failure(fallback, fallback === 'NETWORK_ERROR'
        ? 'Model download network request failed'
        : 'Model artifact storage failed');
}

function validatePrincipal(value) {
    if (typeof value !== 'string' || !UUID_V4.test(value)) {
        throw failure('INVALID_ARGUMENT', 'Invalid plugin principal');
    }
    return value.toLowerCase();
}

function hasTraversal(value) {
    const pathStart = value.indexOf('/', 'https://'.length);
    const remainder = pathStart < 0 ? '' : value.slice(pathStart).split(/[?#]/, 1)[0];
    if (remainder.includes('\\') || /%5c/i.test(remainder)) return true;
    return remainder.split('/').some((segment) => {
        let decoded = segment;
        try {
            for (let depth = 0; depth < 2; depth += 1) {
                decoded = decodeURIComponent(decoded);
                if (
                    decoded === '.' ||
                    decoded === '..' ||
                    decoded.includes('/') ||
                    decoded.includes('\\')
                ) return true;
            }
            return false;
        } catch {
            return true;
        }
    });
}

function parseCanonicalHttps(value) {
    if (
        typeof value !== 'string' ||
        value.length === 0 ||
        value.length > 8_192 ||
        /[\r\n]/.test(value) ||
        hasTraversal(value)
    ) {
        throw failure('NETWORK_ERROR', 'Model artifact URL rejected');
    }
    let parsed;
    try {
        parsed = new URL(value);
    } catch {
        throw failure('NETWORK_ERROR', 'Model artifact URL rejected');
    }
    if (
        parsed.protocol !== 'https:' ||
        parsed.username ||
        parsed.password ||
        parsed.hash ||
        parsed.port ||
        parsed.href !== value
    ) {
        throw failure('NETWORK_ERROR', 'Model artifact URL rejected');
    }
    return parsed;
}

function validateInitialUrl(artifact) {
    const parsed = parseCanonicalHttps(artifact.url);
    if (
        parsed.hostname !== 'huggingface.co' ||
        parsed.search ||
        !parsed.pathname.startsWith('/deepghs/pixai-tagger-v0.9-onnx/resolve/')
    ) {
        throw failure('NETWORK_ERROR', 'Model artifact source rejected');
    }
    return parsed;
}

function validateRedirect(value) {
    const parsed = parseCanonicalHttps(value);
    if (
        parsed.hostname !== XET_HOST ||
        !parsed.pathname.startsWith(XET_PATH_PREFIX) ||
        parsed.pathname.length === XET_PATH_PREFIX.length
    ) {
        throw failure('NETWORK_ERROR', 'Model artifact redirect rejected');
    }
    const seen = new Set();
    for (const [key, queryValue] of parsed.searchParams) {
        if (!XET_QUERY_KEYS.has(key) || !queryValue || seen.has(key)) {
            throw failure('NETWORK_ERROR', 'Model artifact redirect rejected');
        }
        seen.add(key);
    }
    return parsed;
}

function forbiddenIpv4(address) {
    const parts = address.split('.').map(Number);
    if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
        return true;
    }
    const [a, b, c] = parts;
    return (
        a === 0 ||
        a === 10 ||
        a === 127 ||
        (a === 100 && b >= 64 && b <= 127) ||
        (a === 169 && b === 254) ||
        (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && (b === 0 || b === 168 || (b === 88 && c === 99))) ||
        (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
        (a === 203 && b === 0 && c === 113) ||
        a >= 224
    );
}

function ipv6Segments(address) {
    let value = address.toLowerCase();
    if (value.includes('%')) return undefined;
    const lastColon = value.lastIndexOf(':');
    if (value.includes('.')) {
        if (lastColon < 0) return undefined;
        const ipv4 = value.slice(lastColon + 1);
        if (net.isIP(ipv4) !== 4) return undefined;
        const octets = ipv4.split('.').map(Number);
        value = `${value.slice(0, lastColon)}:${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
    }
    const halves = value.split('::');
    if (halves.length > 2) return undefined;
    const left = halves[0] ? halves[0].split(':') : [];
    const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
    const missing = 8 - left.length - right.length;
    if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) {
        return undefined;
    }
    const raw = [...left, ...Array(Math.max(0, missing)).fill('0'), ...right];
    if (raw.length !== 8 || raw.some((part) => !/^[0-9a-f]{1,4}$/.test(part))) return undefined;
    return raw.map((part) => Number.parseInt(part, 16));
}

function forbiddenIpv6(address) {
    const segments = ipv6Segments(address);
    if (!segments) return true;
    const all = (start, end, value = 0) => segments.slice(start, end).every((part) => part === value);
    const embedded = `${segments[6] >> 8}.${segments[6] & 255}.${segments[7] >> 8}.${segments[7] & 255}`;
    const mapped = all(0, 5) && segments[5] === 0xffff;
    const compatible = all(0, 6);
    const nat64 = segments[0] === 0x64 && segments[1] === 0xff9b && all(2, 6);
    return (
        all(0, 8) ||
        (all(0, 7) && segments[7] === 1) ||
        (segments[0] & 0xff00) === 0xff00 ||
        mapped ||
        compatible ||
        (segments[0] & 0xfe00) === 0xfc00 ||
        (segments[0] & 0xffc0) === 0xfe80 ||
        (segments[0] & 0xffc0) === 0xfec0 ||
        (segments[0] === 0x2001 && segments[1] === 0x0db8) ||
        (segments[0] === 0x2001 && segments[1] === 0) ||
        (segments[0] === 0x2001 && segments[1] === 2 && segments[2] === 0) ||
        segments[0] === 0x2002 ||
        (segments[0] === 0x100 && all(1, 4)) ||
        (segments[0] === 0x2001 && (segments[1] & 0xfff0) === 0x10) ||
        (segments[0] === 0x64 && segments[1] === 0xff9b && segments[2] === 1) ||
        (nat64 && forbiddenIpv4(embedded))
    );
}

function validateDnsAnswers(value) {
    if (!Array.isArray(value) || value.length === 0 || value.length > MAX_DNS_ANSWERS) {
        throw failure('NETWORK_ERROR', 'Model artifact DNS rejected');
    }
    const unique = new Map();
    for (const entry of value) {
        if (!entry || typeof entry !== 'object') {
            throw failure('NETWORK_ERROR', 'Model artifact DNS rejected');
        }
        const address = entry.address;
        const family = entry.family;
        if (
            typeof address !== 'string' ||
            (family !== 4 && family !== 6) ||
            net.isIP(address) !== family ||
            (family === 4 ? forbiddenIpv4(address) : forbiddenIpv6(address))
        ) {
            throw failure('NETWORK_ERROR', 'Model artifact DNS rejected');
        }
        unique.set(`${family}:${address}`, Object.freeze({ address, family }));
    }
    return Object.freeze([...unique.values()]);
}

function createPinnedLookup(hostname, addresses) {
    return (requestedHost, options, callback) => {
        const normalized = typeof requestedHost === 'string'
            ? requestedHost.toLowerCase().replace(/\.$/, '')
            : '';
        if (normalized !== hostname) {
            callback(new Error('Pinned DNS hostname mismatch'));
            return;
        }
        const settings = typeof options === 'object' && options !== null ? options : {};
        const family = typeof options === 'number' ? options : settings.family;
        const candidates = family === 4 || family === 6
            ? addresses.filter((entry) => entry.family === family)
            : addresses;
        if (candidates.length === 0) {
            callback(new Error('Pinned DNS family unavailable'));
            return;
        }
        if (settings.all === true) callback(null, candidates.map((entry) => ({ ...entry })));
        else callback(null, candidates[0].address, candidates[0].family);
    };
}

function headerValues(response, wanted) {
    const normalized = wanted.toLowerCase();
    let total = 0;
    const values = [];
    if (Array.isArray(response.rawHeaders) && response.rawHeaders.length > 0) {
        if (response.rawHeaders.length % 2 !== 0) {
            throw failure('NETWORK_ERROR', 'Model artifact response headers rejected');
        }
        for (let index = 0; index < response.rawHeaders.length; index += 2) {
            const name = response.rawHeaders[index];
            const value = response.rawHeaders[index + 1];
            if (typeof name !== 'string' || typeof value !== 'string') {
                throw failure('NETWORK_ERROR', 'Model artifact response headers rejected');
            }
            total += Buffer.byteLength(name) + Buffer.byteLength(value);
            if (total > MAX_HEADER_BYTES) {
                throw failure('NETWORK_ERROR', 'Model artifact response headers rejected');
            }
            if (name.toLowerCase() === normalized) values.push(value);
        }
    } else {
        const raw = response.headers?.[normalized];
        if (Array.isArray(raw)) values.push(...raw);
        else if (typeof raw === 'string') values.push(raw);
    }
    if (values.length > 1) throw failure('NETWORK_ERROR', 'Duplicate model artifact response header');
    const value = values[0];
    if (
        value !== undefined &&
        (value.length === 0 || Buffer.byteLength(value) > MAX_ETAG_BYTES || /[\r\n]/.test(value))
    ) {
        throw failure('NETWORK_ERROR', 'Model artifact response header rejected');
    }
    return value;
}

function parseLength(value) {
    if (value === undefined) return undefined;
    if (!/^(0|[1-9]\d*)$/.test(value)) {
        throw failure('INTEGRITY_ERROR', 'Model artifact length rejected');
    }
    const result = Number(value);
    if (!Number.isSafeInteger(result)) {
        throw failure('INTEGRITY_ERROR', 'Model artifact length rejected');
    }
    return result;
}

function validContentRange(value, offset, total) {
    if (typeof value !== 'string') return false;
    const match = /^bytes (0|[1-9]\d*)-(0|[1-9]\d*)\/(0|[1-9]\d*)$/.exec(value);
    if (!match) return false;
    return Number(match[1]) === offset &&
        Number(match[2]) === total - 1 &&
        Number(match[3]) === total;
}

function resolvePinnedAddresses(input) {
    return new Promise((resolve, reject) => {
        let settled = false;
        let timer;
        const cleanup = () => {
            if (timer !== undefined) clearTimeout(timer);
            input.signal.removeEventListener('abort', abort);
        };
        const finish = (callback, value) => {
            if (settled) return;
            settled = true;
            cleanup();
            callback(value);
        };
        const abort = () => finish(
            reject,
            failure('ABORTED', 'Model download aborted', true),
        );
        input.signal.addEventListener('abort', abort, { once: true });
        if (input.signal.aborted) {
            abort();
            return;
        }
        timer = setTimeout(() => finish(
            reject,
            failure('NETWORK_ERROR', 'Model artifact DNS timed out', true),
        ), input.lookupTimeoutMs);
        timer.unref?.();

        let pending;
        try {
            pending = input.lookup(input.url.hostname, { all: true, verbatim: true });
        } catch {
            finish(reject, failure('NETWORK_ERROR', 'Model download network request failed', true));
            return;
        }
        Promise.resolve(pending).then((answers) => {
            if (settled) return;
            try {
                finish(resolve, validateDnsAnswers(answers));
            } catch (error) {
                finish(reject, safeError(error, 'NETWORK_ERROR'));
            }
        }, () => finish(
            reject,
            failure('NETWORK_ERROR', 'Model download network request failed', true),
        ));
    });
}

async function openPinnedResponse(input) {
    const addresses = await resolvePinnedAddresses(input);
    return new Promise((resolve, reject) => {

        let outgoing;
        let response;
        let settled = false;
        const abort = () => {
            const error = failure('ABORTED', 'Model download aborted', true);
            response?.destroy(error);
            outgoing?.destroy(error);
        };
        input.signal.addEventListener('abort', abort, { once: true });
        if (input.signal.aborted) {
            input.signal.removeEventListener('abort', abort);
            reject(failure('ABORTED', 'Model download aborted', true));
            return;
        }
        try {
            outgoing = input.request({
                protocol: 'https:',
                hostname: input.url.hostname,
                port: 443,
                method: 'GET',
                path: `${input.url.pathname}${input.url.search}`,
                servername: input.url.hostname,
                rejectUnauthorized: true,
                agent: false,
                maxHeaderSize: MAX_HEADER_BYTES,
                lookup: createPinnedLookup(input.url.hostname, addresses),
                headers: {
                    Host: input.url.hostname,
                    'Accept-Encoding': 'identity',
                    ...input.headers,
                },
            }, (incoming) => {
                response = incoming;
                if (settled) {
                    incoming.destroy();
                    return;
                }
                settled = true;
                resolve({
                    response: incoming,
                    cleanup() {
                        input.signal.removeEventListener('abort', abort);
                    },
                });
            });
            outgoing.once('error', (error) => {
                if (settled) return;
                settled = true;
                input.signal.removeEventListener('abort', abort);
                reject(isAbort(input.signal)
                    ? failure('ABORTED', 'Model download aborted', true)
                    : failure('NETWORK_ERROR', 'Model download network request failed', true));
            });
            outgoing.setTimeout?.(NETWORK_IDLE_TIMEOUT_MS, () => {
                outgoing.destroy(failure('NETWORK_ERROR', 'Model download network request timed out', true));
            });
            outgoing.end();
        } catch {
            input.signal.removeEventListener('abort', abort);
            reject(failure('NETWORK_ERROR', 'Model download network request failed', true));
        }
    });
}

async function destroyResponse(response) {
    try {
        response.destroy();
    } catch {
        // Best-effort network cleanup never replaces the primary error.
    }
}

async function hashPartial(store, artifact, signal) {
    const hash = createHash('sha256');
    let bytes = 0;
    try {
        for await (const chunk of store.readPartial(artifact.name, {
            chunkSize: MAX_MODEL_ARTIFACT_CHUNK_BYTES,
        })) {
            throwIfAborted(signal);
            if (!(chunk instanceof Uint8Array) || chunk.byteLength === 0) {
                throw failure('STORAGE_ERROR', 'Model partial reader returned invalid bytes');
            }
            bytes += chunk.byteLength;
            if (bytes > artifact.bytes) {
                throw failure('INTEGRITY_ERROR', 'Model partial exceeds registered size');
            }
            hash.update(chunk);
        }
    } catch (error) {
        throw safeError(error);
    }
    return { hash, bytes };
}

async function safeRemove(store, name) {
    try {
        await store.remove(name);
    } catch {
        // Cleanup cannot replace the primary stable failure.
    }
}

async function streamResponse(input) {
    const writer = input.writer;
    let total = input.offset;
    let complete = false;
    try {
        const iterator = input.response[Symbol.asyncIterator]();
        while (true) {
            let next;
            try {
                next = await iterator.next();
            } catch {
                throw failure('NETWORK_ERROR', 'Model download network request failed', true);
            }
            if (next.done) break;
            const value = next.value;
            throwIfAborted(input.signal);
            if (!(value instanceof Uint8Array)) {
                throw failure('INTEGRITY_ERROR', 'Model artifact stream returned non-byte data');
            }
            let cursor = 0;
            while (cursor < value.byteLength) {
                const length = Math.min(MAX_MODEL_ARTIFACT_CHUNK_BYTES, value.byteLength - cursor);
                if (total + length > input.artifact.bytes) {
                    throw failure('INTEGRITY_ERROR', 'Model artifact exceeded registered size');
                }
                const chunk = value.subarray(cursor, cursor + length);
                input.hash.update(chunk);
                await writer.write(chunk);
                total += length;
                cursor += length;
                input.progress('downloading', total);
            }
        }
        if (total !== input.artifact.bytes) {
            throw failure('INTEGRITY_ERROR', 'Model artifact ended before registered size');
        }
        input.progress('verifying', total);
        const digest = input.hash.digest('hex');
        if (digest !== input.artifact.sha256) {
            throw failure('INTEGRITY_ERROR', 'Model artifact SHA-256 verification failed');
        }
        throwIfAborted(input.signal);
        input.progress('committing', total);
        await writer.commit(digest);
        if (isAbort(input.signal)) {
            await safeRemove(input.store, input.artifact.name);
            throw failure('ABORTED', 'Model download aborted', true);
        }
        complete = true;
        return total;
    } catch (error) {
        const stable = isAbort(input.signal)
            ? failure('ABORTED', 'Model download aborted', true)
            : safeError(error, error instanceof ModelDownloadError ? error.code : 'STORAGE_ERROR');
        const keepPartial = (stable.code === 'ABORTED' || stable.code === 'NETWORK_ERROR') &&
            Boolean(input.etag);
        await writer.abort({ keepPartial }).catch(() => undefined);
        if (!keepPartial) await safeRemove(input.store, input.artifact.name);
        throw stable;
    } finally {
        if (!complete) await destroyResponse(input.response);
    }
}

async function downloadArtifact(input) {
    const { artifact, store, signal } = input;
    let state;
    try {
        state = await store.stat(artifact.name);
    } catch (error) {
        throw safeError(error);
    }
    if (state.state === 'verified') {
        if (state.bytes !== artifact.bytes) {
            throw failure('INTEGRITY_ERROR', 'Verified model artifact size is invalid');
        }
        return artifact.bytes;
    }
    if (state.bytes > artifact.bytes) {
        await safeRemove(store, artifact.name);
        state = { state: 'absent', bytes: 0 };
    }

    let offset = state.state === 'partial' ? state.bytes : 0;
    let etag = state.state === 'partial' ? state.etag : undefined;
    if (
        offset > 0 &&
        (typeof etag !== 'string' || !etag || Buffer.byteLength(etag) > MAX_ETAG_BYTES || /[\r\n]/.test(etag))
    ) {
        await safeRemove(store, artifact.name);
        offset = 0;
        etag = undefined;
    }

    let hash = createHash('sha256');
    if (offset > 0) {
        const partial = await hashPartial(store, artifact, signal);
        if (partial.bytes !== offset) {
            await safeRemove(store, artifact.name);
            offset = 0;
            etag = undefined;
        } else {
            hash = partial.hash;
        }
    }

    if (offset === artifact.bytes) {
        input.progress('verifying', offset);
        const digest = hash.digest('hex');
        if (digest !== artifact.sha256) {
            await safeRemove(store, artifact.name);
            throw failure('INTEGRITY_ERROR', 'Model partial SHA-256 verification failed');
        }
        let writer;
        try {
            writer = await store.beginWrite(artifact.name, { etag });
            if (writer.offset !== offset) {
                throw failure('STORAGE_ERROR', 'Model partial changed before commit');
            }
            throwIfAborted(signal);
            input.progress('committing', offset);
            await writer.commit(digest);
            return artifact.bytes;
        } catch (error) {
            await writer?.abort({ keepPartial: true }).catch(() => undefined);
            throw safeError(error);
        }
    }

    let restarted = false;
    while (true) {
        throwIfAborted(signal);
        const headers = {};
        if (offset > 0) {
            headers.Range = `bytes=${offset}-`;
            headers['If-Range'] = etag;
        }
        let url = validateInitialUrl(artifact);
        let redirects = 0;
        let opened;
        while (true) {
            opened = await openPinnedResponse({
                url,
                headers,
                signal,
                lookup: input.lookup,
                lookupTimeoutMs: input.lookupTimeoutMs,
                request: input.request,
            });
            const response = opened.response;
            const status = response.statusCode;
            if (!REDIRECT_STATUSES.has(status)) break;
            let location;
            try {
                location = headerValues(response, 'location');
                if (!location || redirects >= 1) {
                    throw failure('NETWORK_ERROR', 'Model artifact redirect rejected');
                }
                url = validateRedirect(location);
                redirects += 1;
            } catch (error) {
                opened.cleanup();
                await destroyResponse(response);
                if (offset > 0) await safeRemove(store, artifact.name);
                throw safeError(error, 'NETWORK_ERROR');
            }
            opened.cleanup();
            await destroyResponse(response);
        }

        const response = opened.response;
        const status = response.statusCode;
        let responseEtag;
        try {
            const encoding = headerValues(response, 'content-encoding');
            if (encoding !== undefined && encoding.toLowerCase() !== 'identity') {
                throw failure('NETWORK_ERROR', 'Model artifact encoding rejected');
            }
            responseEtag = headerValues(response, 'etag');
            const contentLength = parseLength(headerValues(response, 'content-length'));
            if (offset > 0 && status === 206) {
                const valid = responseEtag === etag &&
                    validContentRange(headerValues(response, 'content-range'), offset, artifact.bytes) &&
                    (contentLength === undefined || contentLength === artifact.bytes - offset);
                if (!valid) {
                    opened.cleanup();
                    await destroyResponse(response);
                    if (restarted) {
                        await safeRemove(store, artifact.name);
                        throw failure('NETWORK_ERROR', 'Model resume response rejected');
                    }
                    await safeRemove(store, artifact.name);
                    offset = 0;
                    etag = undefined;
                    hash = createHash('sha256');
                    restarted = true;
                    continue;
                }
            } else if (status === 200) {
                if (contentLength !== undefined && contentLength !== artifact.bytes) {
                    throw failure('INTEGRITY_ERROR', 'Model artifact declared length is invalid');
                }
                if (offset > 0) {
                    await safeRemove(store, artifact.name);
                    offset = 0;
                    etag = undefined;
                    hash = createHash('sha256');
                    restarted = true;
                }
            } else {
                throw failure('NETWORK_ERROR', 'Model artifact response status rejected', true);
            }
        } catch (error) {
            opened.cleanup();
            await destroyResponse(response);
            const stable = safeError(error, 'NETWORK_ERROR');
            if (!stable.keepPartial) await safeRemove(store, artifact.name);
            throw stable;
        }

        const writeEtag = responseEtag ?? etag;
        let writer;
        try {
            writer = await store.beginWrite(artifact.name, {
                ...(writeEtag === undefined ? {} : { etag: writeEtag }),
                restart: offset === 0,
            });
            if (writer.offset !== offset) {
                throw failure('STORAGE_ERROR', 'Model partial changed before download');
            }
        } catch (error) {
            opened.cleanup();
            await destroyResponse(response);
            await writer?.abort({ keepPartial: true }).catch(() => undefined);
            throw safeError(error);
        }

        try {
            return await streamResponse({
                response,
                writer,
                store,
                hash,
                offset,
                etag: writeEtag,
                artifact,
                signal,
                progress: input.progress,
            });
        } finally {
            opened.cleanup();
        }
    }
}

function createPluginModelDownloadService(options) {
    if (!options || typeof options !== 'object' || !options.store) {
        throw failure('INVALID_ARGUMENT', 'Model download service options rejected');
    }
    const registry = options.registry ?? { getProfile: getPixaiProfile };
    const store = options.store;
    const lookup = options.lookup ?? dns.lookup;
    const lookupTimeoutMs = options.lookupTimeoutMs ?? DNS_LOOKUP_TIMEOUT_MS;
    const request = options.request ?? https.request;
    if (
        !Number.isSafeInteger(lookupTimeoutMs) ||
        lookupTimeoutMs <= 0 ||
        lookupTimeoutMs > NETWORK_IDLE_TIMEOUT_MS
    ) {
        throw failure('INVALID_ARGUMENT', 'Model download service options rejected');
    }
    let active;

    function profileFor(profileId) {
        if (typeof profileId !== 'string') {
            throw failure('NOT_FOUND', 'Unknown model profile');
        }
        let profile;
        try {
            profile = registry.getProfile(profileId);
        } catch {
            throw failure('NOT_FOUND', 'Unknown model profile');
        }
        if (
            !profile ||
            profile.id !== profileId ||
            typeof profile.revision !== 'string' ||
            !Number.isSafeInteger(profile.totalBytes) ||
            profile.totalBytes <= 0 ||
            !Array.isArray(profile.artifacts) ||
            profile.artifacts.length === 0 ||
            profile.artifacts.some((artifact) => (
                !artifact ||
                artifact.profileId !== profileId ||
                artifact.revision !== profile.revision ||
                typeof artifact.name !== 'string' ||
                !Number.isSafeInteger(artifact.bytes) ||
                artifact.bytes <= 0 ||
                !DIGEST.test(artifact.sha256) ||
                typeof artifact.url !== 'string'
            )) ||
            profile.artifacts.reduce((sum, artifact) => sum + artifact.bytes, 0) !== profile.totalBytes
        ) {
            throw failure('NOT_FOUND', 'Unknown model profile');
        }
        return profile;
    }

    function notify(observer, progress) {
        if (!observer) return;
        try {
            void Promise.resolve(observer({ ...progress })).catch(() => undefined);
        } catch {
            // Progress is advisory and cannot affect the transfer.
        }
    }

    function publish(operation, progress) {
        operation.progress = Object.freeze({ ...progress });
        for (const lease of operation.leases.values()) {
            for (const observer of lease.observers) notify(observer, operation.progress);
        }
    }

    async function executeProfile(operation) {
        const { profile, controller } = operation;
        throwIfAborted(controller.signal);
        let states;
        let estimate;
        try {
            [states, estimate] = await Promise.all([
                Promise.all(profile.artifacts.map((artifact) => store.stat(artifact.name))),
                store.estimate(),
            ]);
        } catch (error) {
            throw safeError(error);
        }
        const remaining = profile.artifacts.reduce((sum, artifact, index) => (
            sum + Math.max(0, artifact.bytes - (states[index].state === 'verified' ? artifact.bytes : states[index].bytes))
        ), 0);
        if (
            Number.isSafeInteger(estimate.usageBytes) &&
            Number.isSafeInteger(estimate.quotaBytes) &&
            estimate.quotaBytes - estimate.usageBytes < remaining
        ) {
            throw failure('STORAGE_QUOTA', 'Insufficient model artifact storage quota');
        }

        let completedBytes = 0;
        for (let index = 0; index < profile.artifacts.length; index += 1) {
            const artifact = profile.artifacts[index];
            const progress = (phase, artifactBytes) => publish(operation, {
                profileId: profile.id,
                artifact: artifact.name,
                phase,
                artifactLoadedBytes: artifactBytes,
                artifactTotalBytes: artifact.bytes,
                loadedBytes: completedBytes + artifactBytes,
                totalBytes: profile.totalBytes,
            });
            try {
                await downloadArtifact({
                    artifact,
                    store,
                    lookup,
                    lookupTimeoutMs,
                    request,
                    signal: controller.signal,
                    progress,
                });
            } catch (error) {
                const stable = safeError(error);
                if (!stable.keepPartial) await safeRemove(store, artifact.name);
                throw stable;
            }
            completedBytes += artifact.bytes;
        }
        return { state: 'verified', bytes: profile.totalBytes };
    }

    function startOperation(profile) {
        const operation = {
            profile,
            controller: new AbortController(),
            leases: new Map(),
            progress: undefined,
        };
        active = operation;
        queueMicrotask(async () => {
            try {
                const result = await executeProfile(operation);
                for (const lease of operation.leases.values()) lease.resolve(result);
            } catch (error) {
                const stable = isAbort(operation.controller.signal)
                    ? failure('ABORTED', 'Model download aborted', true)
                    : safeError(error);
                for (const lease of operation.leases.values()) lease.reject(stable);
            } finally {
                operation.leases.clear();
                if (active === operation) active = undefined;
            }
        });
        return operation;
    }

    function createLease(operation, principalId) {
        let resolve;
        let reject;
        const promise = new Promise((accept, decline) => {
            resolve = accept;
            reject = decline;
        });
        const lease = { principalId, promise, resolve, reject, observers: new Set() };
        operation.leases.set(principalId, lease);
        return lease;
    }

    const service = {
        async status(profileId) {
            const profile = profileFor(profileId);
            let states;
            let estimate;
            try {
                [states, estimate] = await Promise.all([
                    Promise.all(profile.artifacts.map((artifact) => store.stat(artifact.name))),
                    store.estimate(),
                ]);
            } catch (error) {
                throw safeError(error);
            }
            const artifacts = profile.artifacts.map((artifact, index) => Object.freeze({
                name: artifact.name,
                sha256: artifact.sha256,
                state: states[index].state,
                storedBytes: states[index].bytes,
                expectedBytes: artifact.bytes,
            }));
            const storedBytes = artifacts.reduce((sum, artifact) => sum + artifact.storedBytes, 0);
            const state = artifacts.every((artifact) => artifact.state === 'verified')
                ? 'verified'
                : artifacts.every((artifact) => artifact.state === 'absent')
                    ? 'absent'
                    : 'partial';
            return Object.freeze({
                profileId: profile.id,
                revision: profile.revision,
                state,
                storedBytes,
                totalBytes: profile.totalBytes,
                artifacts: Object.freeze(artifacts),
                storage: Object.freeze({
                    kind: 'node',
                    persistent: estimate.persistent === true,
                    resumable: true,
                    ...(Number.isSafeInteger(estimate.usageBytes) ? { usageBytes: estimate.usageBytes } : {}),
                    ...(Number.isSafeInteger(estimate.quotaBytes) ? { quotaBytes: estimate.quotaBytes } : {}),
                }),
                ...(active?.profile.id === profile.id && active.progress
                    ? { active: Object.freeze({ ...active.progress }) }
                    : {}),
            });
        },

        download(profileId, principalValue, observer) {
            const profile = profileFor(profileId);
            const principalId = validatePrincipal(principalValue);
            if (observer !== undefined && typeof observer !== 'function') {
                throw failure('INVALID_ARGUMENT', 'Invalid progress observer');
            }
            const joined = Boolean(active);
            const operation = active ?? startOperation(profile);
            if (operation.profile.id !== profile.id) {
                throw failure('ACTIVE_DOWNLOAD', 'Another model download is active');
            }
            let lease = operation.leases.get(principalId);
            const samePrincipal = Boolean(lease);
            if (observer) {
                const observerCount = [...operation.leases.values()]
                    .reduce((sum, value) => sum + value.observers.size, 0);
                if (observerCount >= MAX_OBSERVERS) {
                    throw failure('ACTIVE_DOWNLOAD', 'Too many model progress observers');
                }
            }
            if (!lease) lease = createLease(operation, principalId);
            if (observer) {
                lease.observers.add(observer);
                if (operation.progress) notify(observer, operation.progress);
            }
            let unsubscribed = false;
            return Object.freeze({
                joined: joined || samePrincipal,
                promise: lease.promise,
                unsubscribe() {
                    if (unsubscribed) return;
                    unsubscribed = true;
                    if (observer) lease.observers.delete(observer);
                },
            });
        },

        cancel(profileId, principalValue) {
            const profile = profileFor(profileId);
            const principalId = validatePrincipal(principalValue);
            if (!active || active.profile.id !== profile.id) return false;
            const lease = active.leases.get(principalId);
            if (!lease) return false;
            active.leases.delete(principalId);
            lease.observers.clear();
            lease.reject(failure('ABORTED', 'Model download aborted', true));
            if (active.leases.size === 0) active.controller.abort();
            return true;
        },

        async remove(profileId, includePartialValue = true) {
            const profile = profileFor(profileId);
            if (typeof includePartialValue !== 'boolean') {
                throw failure('INVALID_ARGUMENT', 'Invalid model removal options');
            }
            if (active?.profile.id === profile.id) {
                throw failure('ACTIVE_DOWNLOAD', 'Model download is active');
            }
            let purgedBytes = 0;
            try {
                for (const artifact of profile.artifacts) {
                    const state = await store.stat(artifact.name);
                    if (state.state === 'partial' && !includePartialValue) continue;
                    purgedBytes += state.bytes;
                    await store.remove(artifact.name);
                }
            } catch (error) {
                throw safeError(error);
            }
            return Object.freeze({ purgedBytes });
        },
    };
    return Object.freeze(service);
}

function routeStatus(error) {
    switch (error?.code) {
        case 'NOT_FOUND': return 404;
        case 'INVALID_ARGUMENT': return 400;
        case 'ACTIVE_DOWNLOAD': return 409;
        case 'STORAGE_QUOTA': return 507;
        case 'NETWORK_ERROR': return 502;
        default: return 500;
    }
}

function routeError(error) {
    const stable = error instanceof ModelDownloadError ? error : safeError(error);
    return { code: stable.code, message: stable.message };
}

function registerPluginModelRoutes(options) {
    const { app, service, checkAuth, checkActiveSession } = options;

    async function authorize(req, res, mutating) {
        if (!await checkAuth(req, res)) return false;
        if (mutating && !checkActiveSession(req, res)) return false;
        return true;
    }

    function principalFrom(req) {
        return validatePrincipal(req.headers?.['x-risu-plugin-principal-id']);
    }

    function requireEmptyBody(req) {
        const length = req.headers?.['content-length'];
        const transfer = req.headers?.['transfer-encoding'];
        if ((length !== undefined && length !== '0') || transfer !== undefined) {
            throw failure('INVALID_ARGUMENT', 'Model download request body is forbidden');
        }
    }

    function removeIncludePartial(req) {
        let bodyDescriptor;
        try {
            bodyDescriptor = Object.getOwnPropertyDescriptor(req, 'body');
        } catch {
            throw failure('INVALID_ARGUMENT', 'Invalid model removal options');
        }
        if (!bodyDescriptor || ('value' in bodyDescriptor && bodyDescriptor.value === undefined)) {
            const length = req.headers?.['content-length'];
            const transfer = req.headers?.['transfer-encoding'];
            if ((length !== undefined && length !== '0') || transfer !== undefined) {
                throw failure('INVALID_ARGUMENT', 'Invalid model removal options');
            }
            return true;
        }
        if (!('value' in bodyDescriptor)) {
            throw failure('INVALID_ARGUMENT', 'Invalid model removal options');
        }
        const body = bodyDescriptor.value;
        if (body === null || typeof body !== 'object' || Array.isArray(body)) {
            throw failure('INVALID_ARGUMENT', 'Invalid model removal options');
        }
        let prototype;
        let descriptors;
        try {
            prototype = Object.getPrototypeOf(body);
            descriptors = Object.getOwnPropertyDescriptors(body);
        } catch {
            throw failure('INVALID_ARGUMENT', 'Invalid model removal options');
        }
        if (prototype !== Object.prototype && prototype !== null) {
            throw failure('INVALID_ARGUMENT', 'Invalid model removal options');
        }
        const keys = Reflect.ownKeys(descriptors);
        const includePartial = descriptors.includePartial;
        if (
            keys.length !== 1 ||
            keys[0] !== 'includePartial' ||
            !includePartial ||
            !('value' in includePartial) ||
            typeof includePartial.value !== 'boolean'
        ) {
            throw failure('INVALID_ARGUMENT', 'Invalid model removal options');
        }
        return includePartial.value;
    }

    app.get('/api/plugin-models/:profileId/status', async (req, res) => {
        if (!await authorize(req, res, false)) return;
        try {
            res.setHeader?.('Cache-Control', 'no-store');
            res.json(await service.status(req.params.profileId));
        } catch (error) {
            res.status(routeStatus(error)).json({ error: routeError(error) });
        }
    });

    app.post('/api/plugin-models/:profileId/download', async (req, res) => {
        if (!await authorize(req, res, true)) return;
        let handle;
        let closed = false;
        let ready = false;
        let blocked = false;
        let latest;
        const encode = (value) => {
            const line = `${JSON.stringify(value)}\n`;
            if (Buffer.byteLength(line) > MAX_NDJSON_BYTES) {
                return `${JSON.stringify({ type: 'error', code: 'STORAGE_ERROR', message: 'Model progress record rejected' })}\n`;
            }
            return line;
        };
        const writeProgress = (progress) => {
            const record = { type: 'progress', ...progress };
            if (!ready) {
                latest = record;
                return;
            }
            if (closed || blocked) {
                latest = record;
                return;
            }
            blocked = res.write(encode(record)) === false;
            if (blocked) latest = undefined;
        };
        const onDrain = () => {
            blocked = false;
            if (latest && !closed) {
                const value = latest;
                latest = undefined;
                writeProgress(value.type === 'progress' ? Object.fromEntries(
                    Object.entries(value).filter(([key]) => key !== 'type'),
                ) : value);
            }
        };
        const onClose = () => {
            closed = true;
            handle?.unsubscribe();
        };
        res.on?.('drain', onDrain);
        res.once?.('close', onClose);
        try {
            requireEmptyBody(req);
            const principalId = principalFrom(req);
            handle = service.download(req.params.profileId, principalId, writeProgress);
            res.writeHead(200, {
                'Content-Type': 'application/x-ndjson',
                'Cache-Control': 'no-store',
                'X-Accel-Buffering': 'no',
                'X-Content-Type-Options': 'nosniff',
            });
            res.write(encode({ type: 'accepted', joined: handle.joined, profileId: req.params.profileId }));
            ready = true;
            if (latest) {
                const value = latest;
                latest = undefined;
                writeProgress(Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'type')));
            }
            try {
                const result = await handle.promise;
                if (!closed) res.end(encode({ type: 'done', ...result }));
            } catch (error) {
                if (!closed) res.end(encode({ type: 'error', ...routeError(error) }));
            }
        } catch (error) {
            handle?.unsubscribe();
            if (!res.headersSent && !ready) {
                res.status(routeStatus(error)).json({ error: routeError(error) });
            } else if (!closed) {
                res.end(encode({ type: 'error', ...routeError(error) }));
            }
        } finally {
            res.removeListener?.('drain', onDrain);
        }
    });

    app.delete('/api/plugin-models/:profileId/download', async (req, res) => {
        if (!await authorize(req, res, true)) return;
        try {
            requireEmptyBody(req);
            const principalId = principalFrom(req);
            res.setHeader?.('Cache-Control', 'no-store');
            res.json({ cancelled: service.cancel(req.params.profileId, principalId) });
        } catch (error) {
            res.status(routeStatus(error)).json({ error: routeError(error) });
        }
    });

    app.delete('/api/plugin-models/:profileId', async (req, res) => {
        if (!await authorize(req, res, true)) return;
        try {
            principalFrom(req);
            const includePartial = removeIncludePartial(req);
            res.setHeader?.('Cache-Control', 'no-store');
            res.json(await service.remove(req.params.profileId, includePartial));
        } catch (error) {
            res.status(routeStatus(error)).json({ error: routeError(error) });
        }
    });
}

module.exports = {
    createPluginModelDownloadService,
    registerPluginModelRoutes,
};
