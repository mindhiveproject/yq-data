/**
 * mathjs exposes per-function dependency collections at runtime — they are the
 * documented way to build a tree-shakeable instance — but its bundled types
 * only declare the fully-instantiated `math` object. Declaring the one
 * collection this package uses keeps `analyzer/methods/fft.ts` type-safe
 * without importing all of mathjs.
 */
// The import makes this file a module, so the block below *augments* mathjs's
// types rather than replacing them with an ambient declaration.
import "mathjs";

declare module "mathjs" {
  export const fftDependencies: FactoryFunctionMap;
}
