/**
 * A failed runtime obligation (language spec §10.2). Thrown by intrinsics
 * whose `requires` clause a caller violated; unwound by `recover`.
 */
export class Panic extends Error {
  constructor(
    readonly obligation: string,
    readonly detail: string,
  ) {
    super(`${obligation}: ${detail}`);
    this.name = 'Panic';
  }
}
