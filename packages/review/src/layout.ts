/**
 * Graph layout for the path view (§15.1): layered top-down from the entry,
 * as authority flows. This is the one computation the review tool performs,
 * and it is layout only.
 */
import type { GraphEdge, GraphNode } from './types.js';

export const NODE_W = 236;
export const NODE_H = 76;
const H_GAP = 36;
const V_GAP = 84;
const MARGIN = 32;

export interface Placed {
  readonly id: string;
  readonly layer: number;
  readonly x: number;
  readonly y: number;
}

export interface Layout {
  readonly placed: ReadonlyMap<string, Placed>;
  readonly width: number;
  readonly height: number;
}

/**
 * Places nodes in layers by breadth-first distance from `entry` over the
 * edges; nodes no edge reaches go in a final layer. Effects: none.
 */
export function layoutGraph(nodes: readonly GraphNode[], edges: readonly GraphEdge[], entry: string, extraIds: readonly { id: string; after: string }[] = []): Layout {
  const out = new Map<string, string[]>();
  for (const e of edges) {
    const list = out.get(e.from) ?? [];
    if (!list.includes(e.to)) list.push(e.to);
    out.set(e.from, list);
  }
  const layerOf = new Map<string, number>();
  const queue: string[] = [entry];
  layerOf.set(entry, 0);
  while (queue.length > 0) {
    const id = queue.shift();
    if (id === undefined) break;
    const layer = layerOf.get(id) ?? 0;
    for (const next of out.get(id) ?? []) {
      if (layerOf.has(next)) continue;
      layerOf.set(next, layer + 1);
      queue.push(next);
    }
  }
  let deepest = Math.max(0, ...layerOf.values());
  for (const n of nodes) {
    if (!layerOf.has(n.id)) layerOf.set(n.id, deepest + 1);
  }
  deepest = Math.max(0, ...layerOf.values());
  for (const x of extraIds) layerOf.set(x.id, (layerOf.get(x.after) ?? deepest) + 1);
  const layers = new Map<number, string[]>();
  const order = [...nodes.map((n) => n.id), ...extraIds.map((x) => x.id)];
  for (const id of order) {
    const l = layerOf.get(id) ?? 0;
    const list = layers.get(l) ?? [];
    list.push(id);
    layers.set(l, list);
  }
  const widest = Math.max(1, ...[...layers.values()].map((l) => l.length));
  const width = MARGIN * 2 + widest * NODE_W + (widest - 1) * H_GAP;
  const placed = new Map<string, Placed>();
  let height = MARGIN;
  for (const [layer, ids] of [...layers.entries()].sort((a, b) => a[0] - b[0])) {
    const rowWidth = ids.length * NODE_W + (ids.length - 1) * H_GAP;
    const x0 = (width - rowWidth) / 2;
    const y = MARGIN + layer * (NODE_H + V_GAP);
    ids.forEach((id, i) => placed.set(id, { id, layer, x: x0 + i * (NODE_W + H_GAP), y }));
    height = Math.max(height, y + NODE_H + MARGIN);
  }
  return { placed, width, height };
}
