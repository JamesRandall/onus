/** `std.hash` intrinsics: BLAKE3 over UTF-8, as lowercase hex. */
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';

export function blake3_hex(t: string): string {
  return bytesToHex(blake3(new TextEncoder().encode(t)));
}
