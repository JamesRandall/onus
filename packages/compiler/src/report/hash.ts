/** Content hashes for reports (§2.2, §11.1, §13): BLAKE3 over UTF-8, rendered as `b3:<hex>`. */
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';

/** The `b3:` hash of `text`. Effects: none. */
export function b3(text: string): string {
  return `b3:${bytesToHex(blake3(new TextEncoder().encode(text)))}`;
}
