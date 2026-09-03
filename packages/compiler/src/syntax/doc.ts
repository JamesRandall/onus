/**
 * A small Wadler/Prettier-style document layout engine used by the canonical
 * printer (impl spec §3.2). The printer builds a `Doc`; `render` lays it out
 * against a line width. Layout is deterministic: the same Doc always renders
 * to the same text, so the canonical form is a pure function of the AST.
 *
 * Groups print flat when they fit in the remaining width and break otherwise.
 * A group that contains a hard line break always breaks.
 */

export type Doc =
  | string
  | { readonly k: 'concat'; readonly parts: readonly Doc[]; readonly hard: boolean }
  | { readonly k: 'group'; readonly doc: Doc; readonly hard: boolean }
  | { readonly k: 'indent'; readonly doc: Doc; readonly hard: boolean }
  | { readonly k: 'line'; readonly soft: boolean; readonly hard: boolean }
  | { readonly k: 'suffix'; readonly text: string; readonly hard: boolean };

/** True iff the doc contains a hard line break. Effects: none. */
function isHard(d: Doc): boolean {
  return typeof d === 'string' ? false : d.hard;
}

export function concat(...parts: Doc[]): Doc {
  return { k: 'concat', parts, hard: parts.some(isHard) };
}

export function group(doc: Doc): Doc {
  return { k: 'group', doc, hard: isHard(doc) };
}

export function indent(doc: Doc): Doc {
  return { k: 'indent', doc, hard: isHard(doc) };
}

/** A space when flat, a newline when broken. */
export const line: Doc = { k: 'line', soft: false, hard: false };
/** Nothing when flat, a newline when broken. */
export const softline: Doc = { k: 'line', soft: true, hard: false };
/** Always a newline; forces every enclosing group to break. */
export const hardline: Doc = { k: 'line', soft: false, hard: true };

/** Text deferred to the end of the current line (used for trailing comments). */
export function lineSuffix(text: string): Doc {
  return { k: 'suffix', text, hard: false };
}

/** Joins docs with a separator. Effects: none. */
export function join(sep: Doc, docs: readonly Doc[]): Doc {
  const parts: Doc[] = [];
  docs.forEach((d, i) => {
    if (i > 0) parts.push(sep);
    parts.push(d);
  });
  return concat(...parts);
}

type Mode = 'flat' | 'break';
interface Cmd {
  readonly ind: number;
  readonly mode: Mode;
  readonly doc: Doc;
}

/**
 * Whether `next` fits in `width` columns, measuring until the first line break
 * that would actually be emitted (continuing into `rest` when `next` runs out).
 * Effects: none.
 */
function fits(next: Cmd, rest: readonly Cmd[], width: number): boolean {
  let restIdx = rest.length;
  const cmds: Cmd[] = [next];
  while (width >= 0) {
    const cmd = cmds.pop();
    if (cmd === undefined) {
      if (restIdx === 0) return true;
      restIdx -= 1;
      const r = rest[restIdx];
      if (r === undefined) return true;
      cmds.push(r);
      continue;
    }
    const { mode, doc } = cmd;
    if (typeof doc === 'string') {
      width -= doc.length;
      continue;
    }
    switch (doc.k) {
      case 'concat':
        for (let i = doc.parts.length - 1; i >= 0; i--) {
          const p = doc.parts[i];
          if (p !== undefined) cmds.push({ ind: cmd.ind, mode, doc: p });
        }
        break;
      case 'indent':
        cmds.push({ ind: cmd.ind + 2, mode, doc: doc.doc });
        break;
      case 'group':
        cmds.push({ ind: cmd.ind, mode: doc.hard ? 'break' : mode, doc: doc.doc });
        break;
      case 'line':
        if (mode === 'break' || doc.hard) return true;
        if (!doc.soft) width -= 1;
        break;
      case 'suffix':
        break;
    }
  }
  return false;
}

/**
 * Lays out `doc` against `width` columns.
 * Postconditions: no line ends in whitespace; output ends without a trailing newline
 * unless the doc ends with one.
 * Effects: none.
 */
export function render(doc: Doc, width: number): string {
  const out: string[] = [];
  let pos = 0;
  const suffixes: string[] = [];
  const cmds: Cmd[] = [{ ind: 0, mode: 'break', doc }];

  const newline = (ind: number): void => {
    if (suffixes.length > 0) {
      out.push(suffixes.join(''));
      suffixes.length = 0;
    }
    // Never leave indentation on an otherwise empty line.
    while (out.length > 0 && /^ +$/.test(out[out.length - 1] ?? '')) out.pop();
    out.push('\n');
    if (ind > 0) out.push(' '.repeat(ind));
    pos = ind;
  };

  while (cmds.length > 0) {
    const cmd = cmds.pop();
    if (cmd === undefined) break;
    const { ind, mode, doc: d } = cmd;
    if (typeof d === 'string') {
      out.push(d);
      pos += d.length;
      continue;
    }
    switch (d.k) {
      case 'concat':
        for (let i = d.parts.length - 1; i >= 0; i--) {
          const p = d.parts[i];
          if (p !== undefined) cmds.push({ ind, mode, doc: p });
        }
        break;
      case 'indent':
        cmds.push({ ind: ind + 2, mode, doc: d.doc });
        break;
      case 'group': {
        if (mode === 'flat' && !d.hard) {
          cmds.push({ ind, mode: 'flat', doc: d.doc });
        } else {
          const flat: Cmd = { ind, mode: 'flat', doc: d.doc };
          if (!d.hard && fits(flat, cmds, width - pos)) cmds.push(flat);
          else cmds.push({ ind, mode: 'break', doc: d.doc });
        }
        break;
      }
      case 'line':
        if (mode === 'flat' && !d.hard) {
          if (!d.soft) {
            out.push(' ');
            pos += 1;
          }
        } else {
          newline(ind);
        }
        break;
      case 'suffix':
        suffixes.push(d.text);
        break;
    }
  }
  if (suffixes.length > 0) out.push(suffixes.join(''));
  return out.join('');
}
