/**
 * A `numpy.allclose`-style Jest matcher for checking DSP output against golden
 * values.
 *
 * Passes when, element by element,
 *
 *     |actual - expected| <= atol + rtol * |expected|
 *
 * which is the same asymmetric tolerance NumPy applies. Golden fixtures hold
 * what NumPy / SciPy produced, so `expected` is the reference side by
 * construction and belongs on the right of the inequality.
 *
 * Import this module for its side effect in any test that uses the matcher:
 *
 *     import "./allclose";
 */

interface AllCloseOptions {
  /** Relative tolerance, applied to `|expected|`. Default `1e-9`. */
  rtol?: number;
  /** Absolute tolerance. Default `0`. */
  atol?: number;
}

function compare(
  actual: ArrayLike<number>,
  expected: ArrayLike<number>,
  rtol: number,
  atol: number
): { ok: boolean; detail: string } {
  if (actual.length !== expected.length) {
    return {
      ok: false,
      detail: `length ${actual.length} !== expected length ${expected.length}`,
    };
  }
  for (let i = 0; i < expected.length; i++) {
    const a = actual[i];
    const e = expected[i];
    if (Number.isNaN(a) !== Number.isNaN(e)) {
      return { ok: false, detail: `element ${i}: actual ${a}, expected ${e}` };
    }
    const diff = Math.abs(a - e);
    const tol = atol + rtol * Math.abs(e);
    if (!(diff <= tol)) {
      return {
        ok: false,
        detail:
          `element ${i}: actual ${a}, expected ${e}, ` +
          `|diff| ${diff.toExponential(3)} > tol ${tol.toExponential(3)} ` +
          `(rtol ${rtol}, atol ${atol})`,
      };
    }
  }
  return { ok: true, detail: `all ${expected.length} elements within tolerance` };
}

expect.extend({
  toBeAllClose(
    received: ArrayLike<number>,
    expected: ArrayLike<number>,
    options: AllCloseOptions = {}
  ) {
    const rtol = options.rtol ?? 1e-9;
    const atol = options.atol ?? 0;
    const { ok, detail } = compare(received, expected, rtol, atol);
    return {
      pass: ok,
      message: () =>
        ok
          ? `expected values NOT to be all-close, but ${detail}`
          : `expected values to be all-close: ${detail}`,
    };
  },
});

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace jest {
    interface Matchers<R> {
      toBeAllClose(expected: ArrayLike<number>, options?: AllCloseOptions): R;
    }
  }
}

export {};
