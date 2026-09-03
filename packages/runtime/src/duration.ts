/** `std.duration` intrinsics. A Duration is a non-negative count of nanoseconds. */
export function nanos(d: number): number {
  return d;
}

export function of_millis(ms: number): number {
  return ms * 1_000_000;
}
