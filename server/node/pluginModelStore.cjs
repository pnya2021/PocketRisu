'use strict';

const defaultFs = require('fs/promises');
const path = require('path');
const {
    PIXAI_PROFILE_ID,
    getPixaiProfile,
} = require('./pluginModelRegistry.cjs');

const MAX_MODEL_ARTIFACT_CHUNK_BYTES = 1_048_576;
const MAX_METADATA_BYTES = 16_384;
const MAX_ETAG_BYTES = 4_096;
const MAX_REVISION_BYTES = 128;
const MAX_ARTIFACTS = 32;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const LOGICAL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const REVISION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function fail(message) {
    throw new Error(message);
}

function snapshotRecord(value, requiredKeys, optionalKeys, label) {
    if (
        value === null ||
        typeof value !== 'object' ||
        Array.isArray(value) ||
        (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
    ) {
        fail(`${label} must be plain data`);
    }
    const allowed = new Set([...requiredKeys, ...optionalKeys]);
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== 'string' || !allowed.has(key))) {
        fail(`${label} has an unknown field`);
    }
    for (const key of requiredKeys) {
        if (!keys.includes(key)) fail(`${label} is missing ${key}`);
    }
    const result = Object.create(null);
    for (const key of keys) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
            fail(`${label} must contain data fields only`);
        }
        result[key] = descriptor.value;
    }
    return result;
}

function snapshotDenseArray(value, maximum, label) {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
        fail(`${label} must be a plain array`);
    }
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
    if (
        !lengthDescriptor ||
        !('value' in lengthDescriptor) ||
        !Number.isSafeInteger(lengthDescriptor.value) ||
        lengthDescriptor.value < 1 ||
        lengthDescriptor.value > maximum
    ) {
        fail(`${label} has an invalid length`);
    }
    const length = lengthDescriptor.value;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== length + 1 || keys[keys.length - 1] !== 'length') {
        fail(`${label} must be dense`);
    }
    const result = [];
    for (let index = 0; index < length; index += 1) {
        const key = String(index);
        if (keys[index] !== key) fail(`${label} must be dense`);
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
            fail(`${label} must contain data entries only`);
        }
        result.push(descriptor.value);
    }
    return result;
}

function validateRevision(value) {
    if (
        typeof value !== 'string' ||
        Buffer.byteLength(value, 'utf8') > MAX_REVISION_BYTES ||
        !REVISION_PATTERN.test(value)
    ) {
        fail('Model manifest revision is invalid');
    }
    return value;
}

function validateDigest(value) {
    if (typeof value !== 'string' || !DIGEST_PATTERN.test(value)) {
        fail('Model artifact digest is invalid');
    }
    return value;
}

function validateArtifact(value, index) {
    const artifact = snapshotRecord(
        value,
        ['name', 'bytes', 'sha256'],
        [],
        `Model manifest artifact ${index}`,
    );
    if (typeof artifact.name !== 'string' || !LOGICAL_NAME_PATTERN.test(artifact.name)) {
        fail('Model artifact name is invalid');
    }
    if (!Number.isSafeInteger(artifact.bytes) || artifact.bytes <= 0) {
        fail('Model artifact length is invalid');
    }
    return Object.freeze({
        name: artifact.name,
        bytes: artifact.bytes,
        sha256: validateDigest(artifact.sha256),
    });
}

function fixedManifest() {
    const profile = getPixaiProfile(PIXAI_PROFILE_ID);
    return {
        revision: profile.revision,
        artifacts: profile.artifacts.map((artifact) => ({
            name: artifact.name,
            bytes: artifact.bytes,
            sha256: artifact.sha256,
        })),
    };
}

function validateManifest(value) {
    const manifest = snapshotRecord(
        value,
        ['revision', 'artifacts'],
        [],
        'Model manifest',
    );
    const revision = validateRevision(manifest.revision);
    const artifacts = snapshotDenseArray(
        manifest.artifacts,
        MAX_ARTIFACTS,
        'Model manifest artifacts',
    ).map(validateArtifact);
    const names = new Set();
    const digests = new Set();
    for (const artifact of artifacts) {
        if (names.has(artifact.name)) fail('Model manifest artifact name is duplicated');
        if (digests.has(artifact.sha256)) fail('Model manifest artifact digest is duplicated');
        names.add(artifact.name);
        digests.add(artifact.sha256);
    }
    return Object.freeze({ revision, artifacts: Object.freeze(artifacts) });
}

function validateRoot(value) {
    if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0')) {
        fail('Model artifact root must be an absolute path');
    }
    return path.resolve(value);
}

function isNotFound(error) {
    return Boolean(error && typeof error === 'object' && error.code === 'ENOENT');
}

function numberProduct(left, right) {
    const a = typeof left === 'bigint' ? left : BigInt(left);
    const b = typeof right === 'bigint' ? right : BigInt(right);
    const value = a * b;
    return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : undefined;
}

function validateChunkSize(value) {
    if (
        !Number.isSafeInteger(value) ||
        value <= 0 ||
        value > MAX_MODEL_ARTIFACT_CHUNK_BYTES
    ) {
        fail('Model artifact read chunk size is invalid');
    }
    return value;
}

function validateBeginOptions(value) {
    if (value === undefined) return { etag: undefined, restart: false };
    const options = snapshotRecord(
        value,
        [],
        ['etag', 'restart'],
        'Model artifact write options',
    );
    if (options.etag !== undefined) {
        if (
            typeof options.etag !== 'string' ||
            options.etag.length === 0 ||
            Buffer.byteLength(options.etag, 'utf8') > MAX_ETAG_BYTES ||
            /[\r\n]/.test(options.etag)
        ) {
            fail('Model artifact ETag is invalid');
        }
    }
    if (options.restart !== undefined && typeof options.restart !== 'boolean') {
        fail('Model artifact restart flag is invalid');
    }
    return { etag: options.etag, restart: options.restart === true };
}

function validateAbortOptions(value) {
    const options = snapshotRecord(
        value,
        ['keepPartial'],
        [],
        'Model artifact abort options',
    );
    if (typeof options.keepPartial !== 'boolean') {
        fail('Model artifact keepPartial flag is invalid');
    }
    return options.keepPartial;
}

function createPluginModelStore(options) {
    const input = snapshotRecord(
        options,
        ['root'],
        ['manifest', 'fs'],
        'Model artifact store options',
    );
    const manifest = validateManifest(input.manifest === undefined ? fixedManifest() : input.manifest);
    const root = validateRoot(input.root);
    const io = input.fs === undefined ? defaultFs : input.fs;
    if (io === null || typeof io !== 'object') fail('Model artifact filesystem is invalid');

    const artifacts = new Map(manifest.artifacts.map((artifact) => [artifact.name, artifact]));
    const active = new Set();
    let rootReady;

    async function rootIdentity() {
        const info = await io.lstat(root);
        if (info.isSymbolicLink() || !info.isDirectory()) {
            fail('Model artifact root must not be a symbolic link');
        }
        const real = path.resolve(await io.realpath(root));
        const expected = process.platform === 'win32' ? root.toLowerCase() : root;
        const actual = process.platform === 'win32' ? real.toLowerCase() : real;
        if (actual !== expected) fail('Model artifact root must not resolve through a link');
        return { device: info.dev, inode: info.ino };
    }

    function artifactFor(value) {
        if (typeof value !== 'string') fail('Unknown model artifact');
        const artifact = artifacts.get(value);
        if (!artifact) fail('Unknown model artifact');
        return artifact;
    }

    function pathsFor(artifact) {
        const prefix = path.join(root, artifact.sha256);
        const paths = {
            partial: `${prefix}.partial`,
            data: `${prefix}.data`,
            metadata: `${prefix}.json`,
        };
        for (const value of Object.values(paths)) {
            if (path.dirname(value) !== root) fail('Model artifact path escaped its root');
        }
        return paths;
    }

    async function ensureRoot() {
        if (!rootReady) {
            rootReady = (async () => {
                await io.mkdir(root, { recursive: true });
                return rootIdentity();
            })();
        }
        const expected = await rootReady;
        const current = await rootIdentity();
        if (current.device !== expected.device || current.inode !== expected.inode) {
            fail('Model artifact root identity changed');
        }
    }

    async function safeFileStat(file) {
        await ensureRoot();
        let info;
        try {
            info = await io.lstat(file);
        } catch (error) {
            if (isNotFound(error)) return undefined;
            throw error;
        }
        if (info.isSymbolicLink()) fail('Model artifact symbolic links are not allowed');
        if (!info.isFile()) fail('Model artifact path is not a regular file');
        if (!Number.isSafeInteger(info.size) || info.size < 0) {
            fail('Model artifact file size is invalid');
        }
        return info;
    }

    async function safeUnlink(file) {
        const info = await safeFileStat(file);
        if (!info) return;
        try {
            await ensureRoot();
            await io.unlink(file);
        } catch (error) {
            if (!isNotFound(error)) throw error;
        }
    }

    function parseMetadata(value, artifact) {
        let parsed;
        try {
            parsed = JSON.parse(value);
        } catch {
            return undefined;
        }
        let metadata;
        try {
            metadata = snapshotRecord(
                parsed,
                ['version', 'digest', 'expectedBytes', 'revision', 'state'],
                ['etag'],
                'Model artifact metadata',
            );
        } catch {
            return undefined;
        }
        if (
            metadata.version !== 1 ||
            metadata.digest !== artifact.sha256 ||
            !Number.isSafeInteger(metadata.expectedBytes) ||
            metadata.expectedBytes <= 0 ||
            typeof metadata.revision !== 'string' ||
            (metadata.state !== 'partial' && metadata.state !== 'verified') ||
            (metadata.etag !== undefined && (
                typeof metadata.etag !== 'string' ||
                Buffer.byteLength(metadata.etag, 'utf8') > MAX_ETAG_BYTES
            ))
        ) {
            return undefined;
        }
        return metadata;
    }

    async function readMetadata(artifact, paths) {
        const info = await safeFileStat(paths.metadata);
        if (!info) return undefined;
        if (info.size > MAX_METADATA_BYTES) return undefined;
        await ensureRoot();
        const handle = await io.open(paths.metadata, 'r');
        try {
            const opened = await handle.stat();
            if (!opened.isFile() || opened.size !== info.size || opened.size > MAX_METADATA_BYTES) {
                return undefined;
            }
            const buffer = Buffer.alloc(MAX_METADATA_BYTES + 1);
            const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, 0);
            if (bytesRead !== opened.size || bytesRead > MAX_METADATA_BYTES) return undefined;
            return parseMetadata(buffer.subarray(0, bytesRead).toString('utf8'), artifact);
        } finally {
            await handle.close();
        }
    }

    async function writeMetadata(artifact, paths, state, etag) {
        const existing = await safeFileStat(paths.metadata);
        if (existing && existing.size > MAX_METADATA_BYTES) {
            await safeUnlink(paths.metadata);
        }
        const value = JSON.stringify({
            version: 1,
            digest: artifact.sha256,
            expectedBytes: artifact.bytes,
            revision: manifest.revision,
            state,
            ...(etag === undefined ? {} : { etag }),
        });
        if (Buffer.byteLength(value, 'utf8') > MAX_METADATA_BYTES) {
            fail('Model artifact metadata exceeds its limit');
        }
        await ensureRoot();
        await io.writeFile(paths.metadata, value, {
            encoding: 'utf8',
            flag: 'w',
            mode: 0o600,
        });
    }

    async function inspect(artifact) {
        await ensureRoot();
        const paths = pathsFor(artifact);
        const [partial, data, metadata] = await Promise.all([
            safeFileStat(paths.partial),
            safeFileStat(paths.data),
            readMetadata(artifact, paths),
        ]);
        return { paths, partial, data, metadata };
    }

    function metadataMatches(metadata, artifact, etag, state) {
        return Boolean(
            metadata &&
            metadata.state === state &&
            metadata.digest === artifact.sha256 &&
            metadata.expectedBytes === artifact.bytes &&
            metadata.revision === manifest.revision &&
            metadata.etag === etag
        );
    }

    async function statusFor(artifact) {
        const current = await inspect(artifact);
        if (
            metadataMatches(
                current.metadata,
                artifact,
                current.metadata?.etag,
                'verified',
            ) &&
            current.data &&
            current.data.size === artifact.bytes &&
            !current.partial
        ) {
            return {
                status: {
                    state: 'verified',
                    bytes: artifact.bytes,
                    ...(current.metadata.etag === undefined ? {} : { etag: current.metadata.etag }),
                },
                current,
            };
        }
        const file = current.partial ?? current.data;
        if (file) {
            if (current.partial && current.partial.size > artifact.bytes) {
                fail('Model artifact file size exceeds the manifest length');
            }
            return {
                status: {
                    state: 'partial',
                    bytes: file.size,
                    ...(current.metadata?.state === 'partial' && current.metadata.etag !== undefined
                        ? { etag: current.metadata.etag }
                        : {}),
                },
                current,
            };
        }
        return { status: { state: 'absent', bytes: 0 }, current };
    }

    async function discard(paths) {
        await safeUnlink(paths.partial);
        await safeUnlink(paths.data);
        await safeUnlink(paths.metadata);
    }

    async function *readChunks(file, chunkSize, expectedBytes, maximumBytes) {
        const before = await safeFileStat(file);
        if (!before) fail('Model artifact file is absent');
        if (expectedBytes !== undefined && before.size !== expectedBytes) {
            fail('Model artifact file size does not match verified metadata');
        }
        if (maximumBytes !== undefined && before.size > maximumBytes) {
            fail('Model artifact file size exceeds the manifest length');
        }
        await ensureRoot();
        const handle = await io.open(file, 'r');
        let offset = 0;
        try {
            const opened = await handle.stat();
            if (!opened.isFile() || opened.size !== before.size) {
                fail('Model artifact file changed before reading');
            }
            if (maximumBytes !== undefined && opened.size > maximumBytes) {
                fail('Model artifact file size exceeds the manifest length');
            }
            while (offset < opened.size) {
                const length = Math.min(chunkSize, opened.size - offset);
                const buffer = Buffer.alloc(length);
                const { bytesRead } = await handle.read(buffer, 0, length, offset);
                if (bytesRead !== length) fail('Model artifact file ended during reading');
                offset += bytesRead;
                yield new Uint8Array(buffer);
            }
            const after = await handle.stat();
            if (after.size !== opened.size) fail('Model artifact file changed during reading');
            if (maximumBytes !== undefined && after.size > maximumBytes) {
                fail('Model artifact file size exceeds the manifest length');
            }
        } finally {
            await handle.close();
        }
    }

    return Object.freeze({
        kind: 'node',
        supportsResume: true,

        async estimate() {
            await ensureRoot();
            if (typeof io.statfs !== 'function') return { persistent: true };
            const value = await io.statfs(root);
            const quotaBytes = numberProduct(value.blocks, value.bsize);
            const availableBytes = numberProduct(value.bavail, value.bsize);
            if (quotaBytes === undefined || availableBytes === undefined) {
                return { persistent: true };
            }
            return {
                usageBytes: Math.max(0, quotaBytes - availableBytes),
                quotaBytes,
                persistent: true,
            };
        },

        async stat(name) {
            const artifact = artifactFor(name);
            return (await statusFor(artifact)).status;
        },

        async beginWrite(name, optionsValue) {
            const artifact = artifactFor(name);
            const options = validateBeginOptions(optionsValue);
            await ensureRoot();
            if (active.has(artifact.sha256)) fail('Model artifact already has an active writer');
            let { status, current } = await statusFor(artifact);
            if (status.state === 'verified' && !options.restart) {
                fail('Model artifact is already verified');
            }

            let offset = 0;
            let resumable =
                !options.restart &&
                metadataMatches(current.metadata, artifact, options.etag, 'partial') &&
                status.state === 'partial' &&
                status.bytes <= artifact.bytes;

            if (resumable && !current.partial && current.data) {
                try {
                    await ensureRoot();
                    await io.rename(current.paths.data, current.paths.partial);
                } catch {
                    resumable = false;
                }
            }
            if (!resumable) {
                await discard(current.paths);
                current = (await inspect(artifact));
            } else {
                offset = status.bytes;
            }

            const paths = current.paths;
            await ensureRoot();
            const handle = await io.open(paths.partial, resumable ? 'a' : 'w');
            let closed = false;
            let aborted = false;
            let committed = false;
            try {
                await writeMetadata(artifact, paths, 'partial', options.etag);
            } catch (error) {
                await handle.close().catch(() => undefined);
                throw error;
            }
            active.add(artifact.sha256);

            async function closeOnce() {
                if (closed) return;
                closed = true;
                await handle.close();
            }

            async function finishActive() {
                active.delete(artifact.sha256);
            }

            return Object.freeze({
                offset,

                async write(chunk) {
                    if (closed || aborted) fail('Model artifact writer is closed');
                    if (!(chunk instanceof Uint8Array) || chunk.byteLength === 0) {
                        fail('Model artifact chunk must be non-empty bytes');
                    }
                    if (chunk.byteLength > MAX_MODEL_ARTIFACT_CHUNK_BYTES) {
                        fail('Model artifact chunk exceeds the maximum chunk size');
                    }
                    if (offset + chunk.byteLength > artifact.bytes) {
                        fail('Model artifact aggregate length exceeds the manifest');
                    }
                    const bytes = Buffer.from(
                        chunk.buffer,
                        chunk.byteOffset,
                        chunk.byteLength,
                    );
                    let written = 0;
                    while (written < bytes.byteLength) {
                        const result = await handle.write(
                            bytes,
                            written,
                            bytes.byteLength - written,
                            null,
                        );
                        if (!result || !Number.isSafeInteger(result.bytesWritten) || result.bytesWritten <= 0) {
                            fail('Model artifact write made no progress');
                        }
                        written += result.bytesWritten;
                    }
                    offset += bytes.byteLength;
                },

                async commit(digestValue) {
                    if (closed || aborted) fail('Model artifact writer is closed');
                    const digest = validateDigest(digestValue);
                    if (digest !== artifact.sha256) fail('Verified model artifact digest does not match the manifest');
                    if (offset !== artifact.bytes) fail('Model artifact length does not match the manifest');

                    let primary;
                    try {
                        await handle.sync();
                        await closeOnce();
                        await ensureRoot();
                        await io.rename(paths.partial, paths.data);
                        try {
                            await writeMetadata(artifact, paths, 'verified', options.etag);
                            committed = true;
                        } catch (error) {
                            primary = error;
                            try {
                                await ensureRoot();
                                await io.rename(paths.data, paths.partial);
                            } catch {
                                // A data file with partial metadata is never advertised as verified.
                            }
                            await writeMetadata(artifact, paths, 'partial', options.etag)
                                .catch(() => undefined);
                            throw primary;
                        }
                    } catch (error) {
                        primary = primary ?? error;
                        await closeOnce().catch(() => undefined);
                        throw primary;
                    } finally {
                        await finishActive();
                    }
                },

                async abort(abortOptions) {
                    if (aborted || committed) return;
                    const keepPartial = validateAbortOptions(abortOptions);
                    aborted = true;
                    let primary;
                    try {
                        await closeOnce();
                    } catch (error) {
                        primary = error;
                    }
                    try {
                        if (keepPartial) {
                            await writeMetadata(artifact, paths, 'partial', options.etag);
                        } else {
                            await discard(paths);
                        }
                    } catch (error) {
                        primary = primary ?? error;
                    } finally {
                        await finishActive();
                    }
                    if (primary) throw primary;
                },
            });
        },

        async *readPartial(name, options) {
            const artifact = artifactFor(name);
            const input = snapshotRecord(
                options,
                ['chunkSize'],
                [],
                'Model artifact read options',
            );
            const chunkSize = validateChunkSize(input.chunkSize);
            const { status, current } = await statusFor(artifact);
            if (status.state !== 'partial') fail('Model artifact partial data is absent');
            const file = current.partial ? current.paths.partial : current.paths.data;
            yield* readChunks(file, chunkSize, undefined, artifact.bytes);
        },

        async openVerified(name) {
            const artifact = artifactFor(name);
            const { status, current } = await statusFor(artifact);
            if (status.state !== 'verified') fail('Model artifact is not verified');
            return Object.freeze({
                size: artifact.bytes,
                chunks(options) {
                    const input = snapshotRecord(
                        options,
                        ['chunkSize'],
                        [],
                        'Model artifact read options',
                    );
                    return readChunks(
                        current.paths.data,
                        validateChunkSize(input.chunkSize),
                        artifact.bytes,
                    );
                },
            });
        },

        async openVerifiedFile(name) {
            const artifact = artifactFor(name);
            const { status, current } = await statusFor(artifact);
            if (status.state !== 'verified') fail('Model artifact is not verified');
            const dataPath = current.paths.data;
            if (path.dirname(dataPath) !== root || !current.data || current.data.size !== artifact.bytes) {
                fail('Model artifact is not verified');
            }
            return Object.freeze({ path: dataPath, size: artifact.bytes });
        },

        async remove(name) {
            const artifact = artifactFor(name);
            await ensureRoot();
            if (active.has(artifact.sha256)) fail('Model artifact has an active writer');
            await discard(pathsFor(artifact));
        },
    });
}

module.exports = {
    MAX_MODEL_ARTIFACT_CHUNK_BYTES,
    createPluginModelStore,
};
