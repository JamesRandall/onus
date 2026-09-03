/**
 * Structural equality of AST values ignoring spans (impl spec §3.2: the
 * round-trip properties compare trees, not positions).
 */

/**
 * Deep equality over plain objects, arrays, bigints and primitives, skipping
 * every `span` key.
 * Effects: none.
 */
export function equalIgnoringSpans(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!equalIgnoringSpans(a[i], b[i])) return false;
    }
    return true;
  }
  if (isRecord(a) && isRecord(b)) {
    const ka = Object.keys(a).filter((k) => k !== 'span').sort();
    const kb = Object.keys(b).filter((k) => k !== 'span').sort();
    if (ka.length !== kb.length) return false;
    for (let i = 0; i < ka.length; i++) {
      const k = ka[i];
      if (k === undefined || k !== kb[i]) return false;
      if (!equalIgnoringSpans(a[k], b[k])) return false;
    }
    return true;
  }
  return false;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/**
 * The first key path at which two values differ (ignoring spans), for test
 * failure messages; null when equal.
 * Effects: none.
 */
export function firstDifference(a: unknown, b: unknown, path = '$'): string | null {
  if (a === b) return null;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return `${path}.length (${a.length} vs ${b.length})`;
    for (let i = 0; i < a.length; i++) {
      const d = firstDifference(a[i], b[i], `${path}[${i}]`);
      if (d !== null) return d;
    }
    return null;
  }
  if (isRecord(a) && isRecord(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)].filter((k) => k !== 'span'));
    for (const k of keys) {
      const d = firstDifference(a[k], b[k], `${path}.${k}`);
      if (d !== null) return d;
    }
    return null;
  }
  return `${path} (${String(a)} vs ${String(b)})`;
}
