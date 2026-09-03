/** `std.typeinfo` intrinsics at runtime: the reflection a decoder needs (§3.8.1). */
import type { TypeInfo } from './values.js';

export function name(t: TypeInfo): string {
  return t.name;
}

export function fields(t: TypeInfo): readonly { readonly name: string; readonly type_name: string }[] {
  return t.fields;
}
