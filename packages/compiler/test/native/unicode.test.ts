/**
 * The native runtime's Unicode tables (docs/CHANGES.md item 175; spec
 * §19.1) against the JavaScript host, which on this Node carries ICU's
 * Unicode 16.0 data: default case conversion per code point over the cased
 * blocks, `trim`, Final_Sigma and SpecialCasing over whole texts, and
 * grapheme cluster segmentation (UAX #29) over the sequences that exercise
 * every rule. Skipped when `clang` is not on PATH.
 */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Context } from '../../src/context.js';
import { buildNative, findClang } from '../../src/codegen/native-build.js';
import { runPipeline } from '../../src/driver.js';
import { toText } from '../../src/report/diagnostic.js';
import { STDLIB_ROOT } from '../harness.js';

const here = dirname(fileURLToPath(import.meta.url));
const tmpRoot = join(here, '..', '..', '.onus-tmp', 'native');
const clang = findClang();

/** The cased and whitespace blocks: Latin, Greek, Cyrillic, Armenian, Georgian, Cherokee, the extended blocks, and the supplementary cased scripts. */
const RANGES: readonly (readonly [number, number])[] = [
  [0, 0x3000],
  [0xa640, 0xa800],
  [0xab30, 0xabc0],
  [0xfb00, 0xfb20],
  [0xfe00, 0xfe70],
  [0xff00, 0x10000],
  [0x10400, 0x10600],
  [0x10c80, 0x10d00],
  [0x10d50, 0x10d90],
  [0x118a0, 0x11900],
  [0x16e40, 0x16e80],
  [0x1e900, 0x1e950],
];

const TEXTS = [
  'ΟΔΥΣΣΕΥΣ',
  'ΣΑΣ Σ',
  'aΣ.',
  'Σ',
  'ς',
  'Straße',
  'ǅ ǆ Ǆ',
  'İstanbul',
  'ﬃ',
  'ŉ',
  'ΐ',
  'é',
  'a\r\nb',
  '🇬🇧🇫🇷🇩',
  '👨‍👩‍👧‍👦',
  '👍🏽',
  '1️⃣',
  '❤️',
  '🏳️‍🌈',
  '각',
  '각ᆨ',
  'क्ष',
  'क्‍ष',
  'कक्',
  'กำ',
  '؀١',
  'กิ้ก',
  'x‍y',
  '\u{1f468}‍\u{1f469}‍\u{1f467}',
  'ab̀́c',
  '\u2028\u2029',
];

function fresh(name: string): string {
  const dir = join(tmpRoot, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return dir;
}

function checked(entry: string): Context {
  const ctx = new Context({ stdlib: STDLIB_ROOT, verify: { budgetMs: 500, cacheDir: join(here, '..', '..', '.onus-tmp', 'cache'), z3Path: null }, log: () => undefined });
  ctx.addFile(entry, readFileSync(entry, 'utf8'));
  runPipeline(ctx, 'paths');
  const diags = ctx.sink.all().map((d) => toText(ctx, d));
  if (diags.length > 0) throw new Error(`check of ${entry} failed:\n${diags.join('\n')}`);
  return ctx;
}

function codePoints(s: string): string {
  return [...s].map((c) => String(c.codePointAt(0))).join(' ');
}

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

function clusters(s: string): string {
  return [...segmenter.segment(s)].map((seg) => codePoints(seg.segment)).join('|');
}

function graphemeLength(s: string): number {
  return [...segmenter.segment(s)].length;
}

describe.skipIf(clang === null)('native Unicode tables (§19.1)', () => {
  const out = fresh('unicode-probe');
  const ctx = checked(join(here, 'unicode_probe.onus'));
  const native = buildNative(ctx, { outDir: out });
  const diags = ctx.sink.all().map((d) => toText(ctx, d));

  it('builds the probe natively', () => {
    expect(diags).toEqual([]);
    expect(native.exe).not.toBeNull();
  });

  it('agrees with the host on case conversion and trim for every code point of the cased blocks', () => {
    if (native.exe === null) throw new Error('no probe');
    const mismatches: string[] = [];
    let count = 0;
    for (const [from, to] of RANGES) {
      const r = spawnSync(native.exe, ['cases', String(from), String(to)], { encoding: 'utf8', maxBuffer: 1 << 26 });
      expect(r.stderr).toBe('');
      expect(r.status).toBe(0);
      for (const line of r.stdout.split('\n')) {
        if (line === '') continue;
        const [cpText, lower, upper, trimmed] = line.split('\t');
        const cp = Number(cpText);
        const s = String.fromCodePoint(cp);
        const expected = `${cp}\t${codePoints(s.toLowerCase())}\t${codePoints(s.toUpperCase())}\t${graphemeLength(s.trim())}`;
        if (`${cpText}\t${lower}\t${upper}\t${trimmed}` !== expected) mismatches.push(`native ${line} host ${expected}`);
        count += 1;
      }
    }
    expect(count).toBeGreaterThan(10000);
    expect(mismatches.slice(0, 20)).toEqual([]);
  }, 120000);

  it('agrees with the host on Final_Sigma, SpecialCasing and grapheme clusters over whole texts', () => {
    if (native.exe === null) throw new Error('no probe');
    const r = spawnSync(native.exe, ['texts', ...TEXTS], { encoding: 'utf8' });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    const lines = r.stdout.split('\n').filter((l) => l !== '');
    expect(lines.length).toBe(TEXTS.length);
    const expected = TEXTS.map((t) => `${codePoints(t.toLowerCase())}\t${codePoints(t.toUpperCase())}\t${clusters(t)}`);
    expect(lines).toEqual(expected);
  }, 60000);
});
