/**
 * A pass that throws is a compiler bug and surfaces as E0999 with the stack
 * in `context`, never as a crash (CLAUDE.md, impl spec §11).
 */
import { describe, expect, it } from 'vitest';
import { Context } from '../../src/context.js';
import { runPipeline } from '../../src/driver.js';

describe('internal errors', () => {
  it('become E0999 diagnostics', () => {
    const ctx = new Context();
    ctx.addFile('x.onus', 'module x\n');
    runPipeline(ctx, 'canonical', {
      canonical: () => {
        throw new Error('boom');
      },
    });
    const codes = ctx.sink.all().map((d) => d.code);
    expect(codes).toEqual(['E0999']);
    expect(ctx.sink.all()[0]?.context.join('\n')).toContain('boom');
  });
});
