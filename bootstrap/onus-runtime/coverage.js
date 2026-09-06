/**
 * Obligation coverage (language spec §20.5): when `ONUS_COVERAGE_DIR` is set,
 * every runtime check records a hit by its obligation's location, and the
 * process writes them on exit. `onus test` merges the files into
 * `.onus/ledger/coverage.json`, which the reports read.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { threadId } from 'node:worker_threads';
const dir = process.env['ONUS_COVERAGE_DIR'] ?? null;
const hits = new Map();
/** Records that the check at `at` (an obligation's `file:line:col`) was reached. Effects: updates the in-memory table. */
export function hit(at) {
    if (dir === null)
        return;
    hits.set(at, (hits.get(at) ?? 0) + 1);
}
/**
 * Writes the hits so far to a file named for this process and thread; the
 * generated test file calls it after its tests, since test runners end their
 * workers without running exit handlers. Effects: writes the file system.
 */
export function flush() {
    if (dir === null)
        return;
    try {
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, `${process.pid}-${threadId}.json`), JSON.stringify(Object.fromEntries(hits)));
    }
    catch {
        // Coverage is best effort.
    }
}
if (dir !== null)
    process.on('exit', flush);
//# sourceMappingURL=coverage.js.map