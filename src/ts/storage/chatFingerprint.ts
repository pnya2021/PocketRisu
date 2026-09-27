// Message fingerprints for chat delta sync. MUST stay byte-for-byte in step
// with server/node/chatFingerprint.cjs (a unit test compares the two).
//
// A fingerprint is a 64-bit hash of a canonical rendering of one message:
// object keys sorted, undefined/null object values dropped (msgpack and the
// client disagree on which one an absent field becomes), binary as hex. Two
// sides agreeing on a prefix fingerprint means the first k messages are the
// same content, so only the rest needs to cross the wire. Any disagreement
// (a legacy message without chatId, a field one side normalizes) only costs a
// full transfer — never a wrong merge.

export function canon(value: unknown): string {
    if (value === null || value === undefined) return 'null';
    const type = typeof value;
    if (type === 'string') return JSON.stringify(value);
    if (type === 'number') return Number.isFinite(value as number) ? JSON.stringify(value) : 'null';
    if (type === 'boolean') return value ? 'true' : 'false';
    if (type === 'bigint') return `"${(value as bigint).toString()}n"`;
    if (Array.isArray(value)) {
        let out = '[';
        for (let i = 0; i < value.length; i++) out += (i ? ',' : '') + canon(value[i]);
        return out + ']';
    }
    if (ArrayBuffer.isView(value)) {
        const view = value as ArrayBufferView;
        const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
        let hex = '';
        for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, '0');
        return `"b:${hex}"`;
    }
    if (type === 'object') {
        const record = value as Record<string, unknown>;
        const keys = Object.keys(record).sort();
        let out = '{';
        let first = true;
        for (const key of keys) {
            const v = record[key];
            if (v === undefined || v === null || typeof v === 'function') continue;
            out += (first ? '' : ',') + JSON.stringify(key) + ':' + canon(v);
            first = false;
        }
        return out + '}';
    }
    return 'null';
}

export function hash64(str: string): string {
    let h1 = 0xdeadbeef ^ str.length;
    let h2 = 0x41c6ce57 ^ str.length;
    for (let i = 0; i < str.length; i++) {
        const ch = str.charCodeAt(i);
        h1 = Math.imul(h1 ^ ch, 2654435761);
        h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0');
}

export function messageFingerprint(message: unknown): string {
    return hash64(canon(message));
}

export function messageFingerprints(messages: readonly unknown[]): string[] {
    const out = new Array(messages.length);
    for (let i = 0; i < messages.length; i++) out[i] = messageFingerprint(messages[i]);
    return out;
}

// Fingerprint of the first `count` messages (count included, so a shorter
// prefix can never collide with a longer one).
export function prefixFingerprint(fingerprints: readonly string[], count: number): string {
    return hash64(`${count}|` + fingerprints.slice(0, count).join(''));
}

