/** `std.hash` intrinsics: BLAKE3 over UTF-8, as lowercase hex (docs/CHANGES.md item 180: the runtime's own implementation, no dependency). */
import { blake3, toHex } from './blake3.js';
export function blake3_hex(t) {
    return toHex(blake3(new TextEncoder().encode(t)));
}
//# sourceMappingURL=hash.js.map