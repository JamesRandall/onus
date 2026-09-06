/**
 * The runtime's own BLAKE3 (docs/CHANGES.md item 180) against the reference
 * implementation the compiler depends on, over the lengths that exercise
 * every branch of the algorithm: an empty input, a partial block, block
 * boundaries, a chunk boundary, several chunks, and enough chunks for the
 * tree to merge at every level.
 */
import { describe, expect, it } from 'vitest';
import { blake3 as reference } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { blake3, toHex } from '../../../runtime/dist/blake3.js';

function input(n: number, seed: number): Uint8Array {
  const out = new Uint8Array(n);
  let x = seed >>> 0;
  for (let i = 0; i < n; i++) {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0;
    out[i] = (x >>> 16) & 0xff;
  }
  return out;
}

describe('the runtime BLAKE3 (item 180)', () => {
  it('matches the known vectors', () => {
    expect(toHex(blake3(new Uint8Array(0)))).toBe('af1349b9f5f9a1a6a0404dea36dcc9499bcb25c9adc112b7cc9a93cae41f3262');
    expect(toHex(blake3(new TextEncoder().encode('abc')))).toBe('6437b3ac38465133ffb63b75273a8db548c558465d79db03fd359c6cd5bd9d85');
  });

  it('agrees with the reference implementation at every structural boundary', () => {
    const lengths = [0, 1, 3, 31, 63, 64, 65, 127, 128, 129, 1023, 1024, 1025, 2047, 2048, 2049, 3072, 4096, 4097, 5000, 8191, 8192, 8193, 16384, 65536, 100000, 131073];
    for (const n of lengths) {
      const bytes = input(n, n + 7);
      expect(toHex(blake3(bytes)), `length ${n}`).toBe(bytesToHex(reference(bytes)));
    }
  });
});
