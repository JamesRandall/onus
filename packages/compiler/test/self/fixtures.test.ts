/**
 * The fixture runner in Onus (`self/fixtures.onus`, docs/CHANGES.md item
 * 198; impl spec §10): built by stage0 (`bootstrap/`) with the compiler its
 * command-line cases run (item 199), it runs every fixture directory's
 * `fixtures.json` through `scripts/fixtures.sh` and must pass the same
 * suite vitest runs here — the bridge until M15.7 retires vitest over the
 * TypeScript library. Skipped with a notice when `bootstrap/` is absent.
 */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..', '..');
const stage0 = join(repoRoot, 'bootstrap', 'run_cli.js');
const out = join(here, '..', '..', '.onus-tmp', 'self', 'fixtures');

describe.skipIf(!existsSync(stage0))('the fixture runner in Onus', () => {
  it('passes the whole fixture suite', () => {
    rmSync(out, { recursive: true, force: true });
    mkdirSync(out, { recursive: true });
    // The runner and, beside it, the compiler its command-line cases run.
    for (const entry of ['self/fixtures.onus', 'self/cli.onus']) {
      const build = spawnSync(process.execPath, [stage0, 'build', entry, '--out', out, '--root', 'self', '--stdlib', 'packages/stdlib', '--budget', '3000'], { cwd: repoRoot, encoding: 'utf8' });
      expect(build.status, build.stdout + build.stderr).toBe(0);
    }
    const run = spawnSync('bash', [join(repoRoot, 'scripts', 'fixtures.sh')], { cwd: repoRoot, encoding: 'utf8', env: { ...process.env, ONUS_FIXTURES: join(out, 'run_fixtures.js') } });
    const failures = run.stdout.split('\n').filter((l) => l.startsWith('FAIL '));
    expect(failures, run.stderr).toEqual([]);
    expect(run.status, run.stdout.split('\n').slice(-3).join('\n') + run.stderr).toBe(0);
    expect(run.stdout).toMatch(/\n\d+ passed, 0 failed, \d+ skipped\n$/);
  }, 1800000);
});

if (!existsSync(stage0)) {
  it('notice: bootstrap/ is absent, the fixture runner is not run', () => {
    process.stderr.write('onus tests: bootstrap/run_cli.js not found; the fixture runner in Onus is skipped\n');
  });
}
