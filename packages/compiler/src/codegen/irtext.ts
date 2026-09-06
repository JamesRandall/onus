/**
 * A text rendering of the target-neutral form (`ir.ts`), for `onus build
 * --emit ir` and the fixture set that pins the lowering (impl spec §6).
 * Never consumed by a backend: emitters read the form itself.
 */
import type { ResolveTables } from '../resolve/defs.js';
import { typeToString, type Type } from '../types/type.js';
import type { IrBlock, IrExpr, IrModule, IrStmt } from './ir.js';

/** Renders a lowered module. Effects: none. */
export function printIr(ir: IrModule, t: ResolveTables): string {
  const out: string[] = [`module ${ir.module.name}`];
  const ty = (x: Type): string => typeToString(x, t);
  const params = (ps: readonly { name: string; type: Type; inout: boolean }[]): string => ps.map((p) => `${p.inout ? 'inout ' : ''}${p.name}: ${ty(p.type)}`).join(', ');
  for (const item of ir.items) {
    switch (item.k) {
      case 'fn': {
        const extra = [...item.dictParams.map((d) => `dict ${d.name}`), ...item.constParams.map((c) => `const ${c.name}: ${ty(c.type)}`)];
        out.push(`fn ${item.name}(${[...extra, params(item.params)].filter((s) => s !== '').join(', ')}) -> ${ty(item.ret)}${item.earlyReturn ? ' early-return' : ''}`);
        if (item.intrinsic !== null) out.push(`  intrinsic ${item.intrinsic.ns}.${item.intrinsic.name}`);
        if (item.entry.length > 0) out.push('  entry:', ...block(item.entry, '    '));
        if (item.body !== null) out.push('  body:', ...block(item.body, '    '));
        break;
      }
      case 'const':
        out.push(`const ${item.def.name}: ${ty(item.type)} = ${expr(item.value)}`);
        break;
      case 'impl':
        out.push(`impl ${item.iface.name}[${ty(item.target)}] dict ${item.dictName} { ${item.entries.map((e) => `${e.name}: ${e.fn.name}`).join(', ')} }`);
        for (const f of item.fns) {
          out.push(`fn ${f.name}(${params(f.params)}) -> ${ty(f.ret)}`);
          if (f.entry.length > 0) out.push('  entry:', ...block(f.entry, '    '));
          if (f.body !== null) out.push('  body:', ...block(f.body, '    '));
        }
        break;
      case 'record':
        out.push(`record ${item.def.name} { ${item.fields.map((f) => `${f.name}: ${ty(f.type)}`).join(', ')} }`);
        break;
      case 'union':
        out.push(`union ${item.def.name} = ${item.variants.map((v) => `${v.def.name}(${v.fields.map((f) => `${f.name}: ${ty(f.type)}`).join(', ')})`).join(' | ')}`);
        break;
      case 'alias':
      case 'intrinsic-type':
      case 'interface':
      case 'capability':
        out.push(`${item.k} ${item.def.name}`);
        break;
    }
  }
  if (ir.tests !== null) {
    for (const e of ir.tests.examples) out.push(`example ${e.name}:`, ...block(e.body, '  '));
    for (const p of ir.tests.properties) out.push(`${p.label}(${p.params.map((x) => x.name).join(', ')}):`, ...block(p.body, '  '));
  }
  for (const v of ir.verifies) out.push(`verify ${v.name} for ${v.def} (${v.params.map((p) => p.name).join(', ')}):`, ...block(v.body, '  '));
  if (ir.main !== null) out.push(`main roots { ${Object.entries(ir.main.roots).map(([k, v]) => `${k}: ${v}`).join(', ')} } args ${ir.main.args}${ir.main.status ? ' status' : ''}`);
  return `${out.join('\n')}\n`;

  function block(b: IrBlock, indent: string): string[] {
    return b.flatMap((s) => stmt(s).map((l) => `${indent}${l}`));
  }

  function stmt(s: IrStmt): string[] {
    switch (s.k) {
      case 'let':
        return [`${s.mutable ? 'var' : 'let'} ${s.name}: ${ty(s.type)} = ${expr(s.value)}`];
      case 'assign':
        return [`${s.name} = ${expr(s.value)}`];
      case 'return':
        return [`return ${expr(s.value)}`];
      case 'if':
        return [`if ${expr(s.cond)}:`, ...block(s.then, '  '), ...(s.else === null ? [] : ['else:', ...block(s.else, '  ')])];
      case 'match':
        return [
          `match ${s.tmp} = ${expr(s.scrutinee)}:`,
          ...s.arms.flatMap((a) => [`  arm ${a.test === null ? 'always' : expr(a.test)}${a.guard === null ? '' : ` when ${expr(a.guard)}`}${a.bindings.length > 0 ? ` bind ${a.bindings.map((b) => `${b.name} = ${expr(b.value)}`).join(', ')}` : ''}:`, ...block(a.body, '    ')]),
        ];
      case 'loop':
        return [`loop ${expr(s.cond)}:`, ...block(s.body, '  ')];
      case 'for-range':
        return [`for ${s.name} in ${expr(s.lo)} ..< ${expr(s.hi)}:`, ...block(s.body, '  ')];
      case 'for-each':
        return [`for ${s.name}: ${ty(s.type)} in ${expr(s.list)}:`, ...block(s.body, '  ')];
      case 'check':
        return [`check ${expr(s.cond)} [${s.ob.kind} ${s.ob.text} @ ${s.ob.def}]`];
      case 'assert':
        return [`assert ${expr(s.cond)}`];
      case 'expr':
        return [expr(s.expr)];
      case 'call-inout':
        return [`${s.result === null ? '' : `${s.result.name} = `}${expr(s.call)} inout ${s.targets.map((x) => x.name).join(', ')}`];
      case 'unreachable':
        return ['unreachable'];
      case 'comment':
        return [`-- ${s.text}`];
      case 'reject':
        return [`reject ${s.column} unless ${expr(s.cond)}`];
    }
  }

  function expr(e: IrExpr): string {
    switch (e.k) {
      case 'int':
        return e.v.toString();
      case 'float':
        return String(e.v);
      case 'text':
        return JSON.stringify(e.v);
      case 'bool':
        return String(e.v);
      case 'unit':
        return 'unit';
      case 'local':
        return e.name;
      case 'global':
        return `global ${e.def.name}`;
      case 'fnref':
        return `fnref ${e.name}`;
      case 'call': {
        const target = e.target.k === 'fn' ? e.target.name : `${expr(e.target.dict)}.${e.target.name}`;
        const targs = e.targs.length === 0 ? '' : `[${e.targs.map((a) => (a.k === 'type' ? ty(a.type) : a.k === 'const' ? `const ${a.value.k}` : 'effects')).join(', ')}]`;
        const decode = e.decoder === undefined ? '' : ` decode(${e.decoder.fields.map((f) => `${f.name}: ${f.kind}`).join(', ')}${e.decoder.checks.length > 0 ? `; ${e.decoder.checks.flatMap(stmt).join('; ')}` : ''})`;
        return `${target}${targs}(${[...e.dicts.map((d) => `dict ${expr(d)}`), ...e.consts.map((c) => `const ${expr(c)}`), ...e.args.map(expr)].join(', ')})${decode}`;
      }
      case 'call-value':
        return `${expr(e.callee)}(${e.args.map(expr).join(', ')})`;
      case 'record':
        return `${e.def.name} { ${e.fields.map((f) => `${f.name}: ${expr(f.value)}`).join(', ')} }`;
      case 'variant':
        return `${e.def.name}(${e.fields.map((f) => `${f.name}: ${expr(f.value)}`).join(', ')})`;
      case 'update':
        return `{ ${expr(e.base)} with ${e.fields.map((f) => `${f.name}: ${expr(f.value)}`).join(', ')} }`;
      case 'field':
        return `${expr(e.object)}.${e.name}`;
      case 'list':
        return `[${e.elems.map(expr).join(', ')}]`;
      case 'concat':
        return `(${expr(e.left)} ++ ${expr(e.right)})`;
      case 'intop':
        return `(${expr(e.left)} ${e.op}${e.ob === null ? '' : '?'} ${expr(e.right)})`;
      case 'floatop':
        return `(${expr(e.left)} ${e.op}. ${expr(e.right)})`;
      case 'neg':
        return `(-${e.ob === null ? '' : '?'}${expr(e.operand)})`;
      case 'cmp':
        return `(${expr(e.left)} ${e.op} ${expr(e.right)})`;
      case 'eq':
        return `(${expr(e.left)} ${e.negate ? '!=' : '=='}${e.prim ? '' : 'deep'} ${expr(e.right)})`;
      case 'not':
        return `not ${expr(e.operand)}`;
      case 'and':
        return `(${e.operands.map(expr).join(' and ')})`;
      case 'or':
        return `(${e.operands.map(expr).join(' or ')})`;
      case 'implies':
        return `(${expr(e.left)} implies ${expr(e.right)})`;
      case 'is-variant':
        return `(${expr(e.subject)} is ${e.variant.name})`;
      case 'try':
        return `try${e.raw ? '-raw' : ''} ${expr(e.operand)}${e.else === null ? '' : ` else ${e.else.name ?? '_'}: ${expr(e.else.value)}`}`;
      case 'recover':
        return `recover { ... ${expr(e.value)} }`;
      case 'quantifier':
        return `${e.quant} ${e.name}: ${expr(e.body)}`;
      case 'closure':
        return `fn(${e.params.map((p) => p.name).join(', ')}) { ... }`;
      case 'fake':
        return `fake ${e.kind}`;
      case 'checked':
        return `checked(${expr(e.value)} as ${e.it}; ${e.checks.flatMap(stmt).join('; ')})`;
      case 'typeinfo':
        return `typeinfo ${e.name}`;
      case 'const':
        return `const ${e.value.k}`;
      case 'value':
        return `value ${e.value.k}`;
      case 'dict':
        return `dict ${e.name}`;
      case 'dict-param':
        return e.name;
      case 'snapshot':
        return `snapshot ${expr(e.value)}`;
    }
  }
}
