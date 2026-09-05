/**
 * Environment files: `.env` then `.env.local` in each given directory, in
 * order, `KEY=value` per line. A variable already present in the process
 * environment wins over the files, and an earlier file over a later one.
 * Keys are read here so they never appear on a command line.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Parses the `KEY=value` lines of an env file; `#` comments, blank lines and `export ` prefixes are allowed, and quotes around a value are stripped. Effects: none. */
export function parseEnv(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (m === null) continue;
    const key = m[1] ?? '';
    let value = (m[2] ?? '').trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    out.set(key, value);
  }
  return out;
}

/** Loads `.env` and `.env.local` from each directory into `process.env` without overriding what is set. Returns the files read. Effects: reads files; mutates `process.env`. */
export function loadEnvFiles(dirs: readonly string[]): string[] {
  const read: string[] = [];
  for (const dir of dirs) {
    for (const name of ['.env', '.env.local']) {
      const path = join(dir, name);
      let text: string;
      try {
        text = readFileSync(path, 'utf8');
      } catch {
        continue;
      }
      read.push(path);
      for (const [k, v] of parseEnv(text)) if (process.env[k] === undefined) process.env[k] = v;
    }
  }
  return read;
}
