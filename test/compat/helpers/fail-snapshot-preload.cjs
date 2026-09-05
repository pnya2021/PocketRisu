// Test-only fault injection, loaded into the server via NODE_OPTIONS=--require.
// While a `fail-snapshot` file exists in the server's cwd, every
// pluginStorage.snapshotTo() throws — simulating a snapshot transaction that
// fails mid-way (R4: the backup cooldown must not advance on failure).
const path = require('node:path');
const fs = require('node:fs');
const store = require('../../../server/node/plugin-storage-store.cjs');

const original = store.snapshotTo;
store.snapshotTo = (...args) => {
    if (fs.existsSync(path.join(process.cwd(), 'fail-snapshot'))) {
        throw new Error('injected snapshotTo failure');
    }
    return original(...args);
};
