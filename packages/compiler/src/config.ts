/**
 * Repository settings (`onus.json` at the project root): the test target and
 * environment (§20.6). There is no other configuration file.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface TestSettings {
  /** The `test module` file that constructs capabilities for `verify` blocks, relative to the root. */
  readonly env: string | null;
  readonly target: string;
  /** A passing verification older than this no longer satisfies `policy verified_assumptions_only`. */
  readonly maxAssumptionAgeDays: number;
}

export interface OnusConfig {
  readonly test: TestSettings;
}

export const DEFAULT_CONFIG: OnusConfig = { test: { env: null, target: 'local', maxAssumptionAgeDays: 7 } };

/** Reads `<root>/onus.json`, falling back to defaults for anything absent. Effects: reads a file. */
export function readConfig(root: string): OnusConfig {
  const path = join(root, 'onus.json');
  if (!existsSync(path)) return DEFAULT_CONFIG;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return DEFAULT_CONFIG;
  }
  const test = typeof parsed === 'object' && parsed !== null && 'test' in parsed && typeof parsed.test === 'object' && parsed.test !== null ? parsed.test : {};
  const str = (k: string): string | null => (k in test && typeof (test as Record<string, unknown>)[k] === 'string' ? String((test as Record<string, unknown>)[k]) : null);
  const num = (k: string): number | null => (k in test && typeof (test as Record<string, unknown>)[k] === 'number' ? Number((test as Record<string, unknown>)[k]) : null);
  return {
    test: {
      env: str('env'),
      target: str('target') ?? DEFAULT_CONFIG.test.target,
      maxAssumptionAgeDays: num('max_assumption_age_days') ?? DEFAULT_CONFIG.test.maxAssumptionAgeDays,
    },
  };
}
