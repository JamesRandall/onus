/**
 * Capabilities at runtime (language spec §8; impl spec §5): ordinary
 * objects whose guarantees are static. The base class only makes forging
 * inconvenient: construction is by the runtime's roots and attenuation, or
 * through `fake` in generated test modules, which the compiler gates with a
 * token it emits only there.
 */
export const FAKE_TOKEN: unique symbol = Symbol('onus.fake');

export class Capability {
  protected constructor(readonly kind: string) {}

  /** Test doubles (§8.4). `token` must be the compiler-emitted token. */
  static __fake<B extends object>(kind: string, behaviour: B, token: symbol): Capability & B {
    if (token !== FAKE_TOKEN) throw new Error('fake capabilities are constructed only by generated test modules');
    return Object.assign(new Capability(kind), behaviour);
  }
}
