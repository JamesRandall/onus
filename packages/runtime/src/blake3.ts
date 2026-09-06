/**
 * BLAKE3 (the reference algorithm, https://github.com/BLAKE3-team/BLAKE3),
 * the default 32-byte hash over a whole input, in plain TypeScript so that
 * a generated program depends on nothing installed (docs/CHANGES.md item
 * 180). The native runtime carries the reference C implementation; the two
 * must agree on every input.
 */
const IV = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
const MSG_PERMUTATION = [2, 6, 3, 10, 7, 0, 4, 13, 1, 11, 12, 5, 9, 14, 15, 8];
const CHUNK_START = 1;
const CHUNK_END = 2;
const PARENT = 4;
const ROOT = 8;
const BLOCK_LEN = 64;
const CHUNK_LEN = 1024;

function rotr(x: number, n: number): number {
  return ((x >>> n) | (x << (32 - n))) >>> 0;
}

function g(s: Uint32Array, a: number, b: number, c: number, d: number, mx: number, my: number): void {
  s[a] = (((s[a] ?? 0) + (s[b] ?? 0)) >>> 0) + mx;
  s[d] = rotr(((s[d] ?? 0) ^ (s[a] ?? 0)) >>> 0, 16);
  s[c] = ((s[c] ?? 0) + (s[d] ?? 0)) >>> 0;
  s[b] = rotr(((s[b] ?? 0) ^ (s[c] ?? 0)) >>> 0, 12);
  s[a] = (((s[a] ?? 0) + (s[b] ?? 0)) >>> 0) + my;
  s[d] = rotr(((s[d] ?? 0) ^ (s[a] ?? 0)) >>> 0, 8);
  s[c] = ((s[c] ?? 0) + (s[d] ?? 0)) >>> 0;
  s[b] = rotr(((s[b] ?? 0) ^ (s[c] ?? 0)) >>> 0, 7);
}

function round(s: Uint32Array, m: Uint32Array): void {
  g(s, 0, 4, 8, 12, m[0] ?? 0, m[1] ?? 0);
  g(s, 1, 5, 9, 13, m[2] ?? 0, m[3] ?? 0);
  g(s, 2, 6, 10, 14, m[4] ?? 0, m[5] ?? 0);
  g(s, 3, 7, 11, 15, m[6] ?? 0, m[7] ?? 0);
  g(s, 0, 5, 10, 15, m[8] ?? 0, m[9] ?? 0);
  g(s, 1, 6, 11, 12, m[10] ?? 0, m[11] ?? 0);
  g(s, 2, 7, 8, 13, m[12] ?? 0, m[13] ?? 0);
  g(s, 3, 4, 9, 14, m[14] ?? 0, m[15] ?? 0);
}

/** The full 16-word compression output; a chaining value is its first 8 words. */
function compress(cv: Uint32Array, block: Uint32Array, counter: number, blockLen: number, flags: number): Uint32Array {
  const s = new Uint32Array(16);
  s.set(cv.subarray(0, 8), 0);
  s.set(IV.subarray(0, 4), 8);
  s[12] = counter >>> 0;
  s[13] = Math.floor(counter / 0x100000000) >>> 0;
  s[14] = blockLen;
  s[15] = flags;
  let m = Uint32Array.from(block);
  for (let r = 0; r < 7; r++) {
    round(s, m);
    if (r < 6) m = Uint32Array.from(MSG_PERMUTATION, (i) => m[i] ?? 0);
  }
  for (let i = 0; i < 8; i++) {
    s[i] = ((s[i] ?? 0) ^ (s[i + 8] ?? 0)) >>> 0;
    s[i + 8] = ((s[i + 8] ?? 0) ^ (cv[i] ?? 0)) >>> 0;
  }
  return s;
}

/** The 16 little-endian words of a block, zero-padded. */
function words(bytes: Uint8Array, start: number, len: number): Uint32Array {
  const out = new Uint32Array(16);
  for (let i = 0; i < len; i++) {
    const w = i >> 2;
    out[w] = ((out[w] ?? 0) | ((bytes[start + i] ?? 0) << (8 * (i & 3)))) >>> 0;
  }
  return out;
}

/** The compression output of chunk `index` holding `bytes[start..start+len)`; the last block carries `extra` flags. */
function chunk(bytes: Uint8Array, start: number, len: number, index: number, extra: number): Uint32Array {
  let cv = Uint32Array.from(IV);
  const blocks = Math.max(1, Math.ceil(len / BLOCK_LEN));
  let out: Uint32Array = new Uint32Array(16);
  for (let b = 0; b < blocks; b++) {
    const off = b * BLOCK_LEN;
    const blockLen = Math.min(BLOCK_LEN, len - off);
    let flags = 0;
    if (b === 0) flags |= CHUNK_START;
    if (b === blocks - 1) flags |= CHUNK_END | extra;
    out = compress(cv, words(bytes, start + off, blockLen), index, blockLen, flags);
    cv = Uint32Array.from(out.subarray(0, 8));
  }
  return out;
}

function parent(left: Uint32Array, right: Uint32Array, extra: number): Uint32Array {
  const block = new Uint32Array(16);
  block.set(left.subarray(0, 8), 0);
  block.set(right.subarray(0, 8), 8);
  return compress(IV, block, 0, BLOCK_LEN, PARENT | extra);
}

/** The 32-byte BLAKE3 hash of `input`. */
export function blake3(input: Uint8Array): Uint8Array {
  const chunks = Math.max(1, Math.ceil(input.length / CHUNK_LEN));
  let root: Uint32Array;
  if (chunks === 1) root = chunk(input, 0, input.length, 0, ROOT);
  else {
    // Every chunk but the last completes the subtrees its count's trailing zero bits say it does; the last chunk
    // is finalised on its own and then merged with what is left on the stack, the topmost merge being the root.
    const stack: Uint32Array[] = [];
    for (let t = 0; t < chunks - 1; t++) {
      let cv: Uint32Array = Uint32Array.from(chunk(input, t * CHUNK_LEN, CHUNK_LEN, t, 0).subarray(0, 8));
      let total = t + 1;
      while ((total & 1) === 0) {
        const left = stack.pop();
        if (left === undefined) break;
        cv = Uint32Array.from(parent(left, cv, 0).subarray(0, 8));
        total >>= 1;
      }
      stack.push(cv);
    }
    const last = (chunks - 1) * CHUNK_LEN;
    let out: Uint32Array = chunk(input, last, input.length - last, chunks - 1, 0);
    while (stack.length > 0) {
      const left = stack.pop();
      if (left === undefined) break;
      out = parent(left, Uint32Array.from(out.subarray(0, 8)), stack.length === 0 ? ROOT : 0);
    }
    root = out;
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 8; i++) {
    const w = root[i] ?? 0;
    out[4 * i] = w & 0xff;
    out[4 * i + 1] = (w >>> 8) & 0xff;
    out[4 * i + 2] = (w >>> 16) & 0xff;
    out[4 * i + 3] = (w >>> 24) & 0xff;
  }
  return out;
}

export function toHex(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}
