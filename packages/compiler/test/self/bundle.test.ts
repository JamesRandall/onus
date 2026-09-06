/**
 * `self/bundle.onus` is generated (docs/CHANGES.md item 180) from the
 * standard library, the JavaScript runtime and the C runtime; it must be
 * what `scripts/bundle.mjs` produces from the tree now, so that the compiler
 * built from `self/` carries the current library and runtimes.
 */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..', '..');
const tmpRoot = join(here, '..', '..', '.onus-tmp', 'self', 'bundle');

describe('the bundle the compiler carries (M15.5)', () => {
  it('self/bundle.onus is what scripts/bundle.mjs generates from the tree', () => {
    rmSync(tmpRoot, { recursive: true, force: true });
    mkdirSync(tmpRoot, { recursive: true });
    const out = join(tmpRoot, 'bundle.onus');
    const r = spawnSync(process.execPath, [join(repoRoot, 'scripts', 'bundle.mjs'), out], { encoding: 'utf8', cwd: repoRoot });
    expect(r.status, r.stderr).toBe(0);
    const generated = readFileSync(out, 'utf8');
    const committed = readFileSync(join(repoRoot, 'self', 'bundle.onus'), 'utf8');
    expect(generated.length).toBe(committed.length);
    expect(generated === committed, 'self/bundle.onus is stale: run `node scripts/bundle.mjs`').toBe(true);
  }, 120000);
});
