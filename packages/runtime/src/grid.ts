/**
 * `std.grid` intrinsics: a two-dimensional value with compile-time
 * dimensions (§3.5). Cells are a plain array in v0; mutation through `set`
 * happens in place because nothing else holds the value (§4.1).
 */
import { Panic } from './panic.js';

export class Grid<T> {
  constructor(
    readonly width: number,
    readonly height: number,
    readonly cells: T[],
  ) {}
}

const bounds = { kind: 'requires', text: '0 <= x and x < w and 0 <= y and y < h', at: 'std.grid', def: 'Grid' } as const;

export function filled<T>(value: T, width: number, height: number): Grid<T> {
  if (width <= 0 || height <= 0) throw new Panic({ kind: 'requires', text: 'width > 0 and height > 0', at: 'std.grid', def: 'filled' });
  return new Grid(width, height, Array.from({ length: width * height }, () => value));
}

/** Intrinsic convention: `const` type parameters (`w`, `h`) come first and are unused here. */
export function get<T>(w: number, h: number, grid: Grid<T>, x: number, y: number): T {
  void w;
  void h;
  if (x < 0 || x >= grid.width || y < 0 || y >= grid.height) throw new Panic(bounds, `(${x}, ${y}) in ${grid.width}x${grid.height}`);
  const v = grid.cells[y * grid.width + x];
  if (v === undefined) throw new Panic(bounds, `(${x}, ${y}) in ${grid.width}x${grid.height}`);
  return v;
}

/** `inout` convention: returns the result and the updated parameter. */
export function set<T>(w: number, h: number, grid: Grid<T>, x: number, y: number, value: T): [undefined, Grid<T>] {
  void w;
  void h;
  if (x < 0 || x >= grid.width || y < 0 || y >= grid.height) throw new Panic(bounds, `(${x}, ${y}) in ${grid.width}x${grid.height}`);
  grid.cells[y * grid.width + x] = value;
  return [undefined, grid];
}
