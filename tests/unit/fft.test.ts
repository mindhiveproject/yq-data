/**
 * The radix-2 FFT behind `spectrum()`, checked against a definition-level DFT.
 *
 * The golden suite already holds `spectrum()` to SciPy on realistic signals;
 * this isolates the transform itself, at every power-of-two length, so a
 * mistake in the bit-reversal or the twiddle table shows up here by name
 * rather than as a drifting band power.
 */
import { spectrum, nextPowerOfTwo, padToPowerOfTwo } from "../../src";

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296 - 0.5;
  };
}

/** |X[k]| by the definition, in float64, for k < n/2. */
function dftMagnitude(x: ArrayLike<number>): number[] {
  const n = x.length;
  const out: number[] = [];
  for (let k = 0; k < Math.floor(n / 2); k++) {
    let re = 0;
    let im = 0;
    for (let t = 0; t < n; t++) {
      const angle = (-2 * Math.PI * k * t) / n;
      re += x[t] * Math.cos(angle);
      im += x[t] * Math.sin(angle);
    }
    out.push(Math.hypot(re, im));
  }
  return out;
}

describe("spectrum() transform", () => {
  // Rectangular window, no detrend: `spectrum` reduces to 2|X[k]|/N (|X[0]|/N at DC).
  describe.each([2, 4, 8, 16, 32, 64, 128, 256, 512, 1024])("length %i", (n) => {
    it("matches the DFT definition", () => {
      const rand = lcg(n);
      const x = Float32Array.from({ length: n }, () => rand());
      const spec = spectrum(x, {
        samplingRate: 1,
        window: "rectangular",
        detrend: false,
        scaling: "magnitude",
      });

      const expected = dftMagnitude(x);
      expect(spec.values.length).toBe(n / 2);
      for (let k = 0; k < n / 2; k++) {
        const scale = k === 0 ? 1 / n : 2 / n;
        // float32 output: about seven digits.
        expect(spec.values[k]).toBeCloseTo(expected[k] * scale, 6);
      }
    });
  });

  it("puts a pure tone in exactly one bin, at its amplitude", () => {
    const n = 512;
    const fs = 256;
    const bin = 40;
    const x = Float32Array.from(
      { length: n },
      (_, t) => 3 * Math.cos((2 * Math.PI * bin * t) / n + 0.7)
    );
    const spec = spectrum(x, {
      samplingRate: fs,
      window: "rectangular",
      detrend: false,
      scaling: "magnitude",
    });

    expect(spec.values[bin]).toBeCloseTo(3, 5);
    expect(spec.frequencies[bin]).toBeCloseTo((bin * fs) / n, 5);
    for (let k = 0; k < spec.values.length; k++) {
      if (k !== bin) expect(spec.values[k]).toBeLessThan(1e-5);
    }
  });

  it("conserves energy (Parseval)", () => {
    const n = 1024;
    const rand = lcg(99);
    const x = Float32Array.from({ length: n }, () => rand());
    const spec = spectrum(x, {
      samplingRate: n, // so the density integrates to power with df = 1 Hz
      window: "rectangular",
      detrend: false,
      scaling: "psd",
    });

    let timeEnergy = 0;
    for (const v of x) timeEnergy += v * v;
    // One-sided PSD in units²/Hz at fs = n, summed over bins with df = 1.
    let spectral = 0;
    for (let k = 0; k < spec.values.length; k++) spectral += spec.values[k];
    // The Nyquist bin is not returned, so allow its share of the energy.
    expect(spectral / (timeEnergy / n)).toBeGreaterThan(0.99);
    expect(spectral / (timeEnergy / n)).toBeLessThan(1.01);
  });

  it("zero-pads a non-power-of-two signal to the next power of two", () => {
    expect(nextPowerOfTwo(300)).toBe(512);
    expect(padToPowerOfTwo(new Float32Array(300)).length).toBe(512);

    const x = Float32Array.from({ length: 300 }, (_, t) => Math.sin(t / 5));
    const spec = spectrum(x, { samplingRate: 100 });
    expect(spec.fftLength).toBe(512);
    expect(spec.values.length).toBe(256);
  });

  it("is repeatable and does not share state between calls of different length", () => {
    const rand = lcg(5);
    const a = Float32Array.from({ length: 256 }, () => rand());
    const b = Float32Array.from({ length: 1024 }, () => rand());
    const options = { samplingRate: 256 } as const;

    const first = spectrum(a, options).values;
    spectrum(b, options);
    const again = spectrum(a, options).values;
    expect(Array.from(again)).toEqual(Array.from(first));
  });

  it("handles degenerate input without NaN", () => {
    for (const n of [0, 1, 2, 3]) {
      const spec = spectrum(new Float32Array(n).fill(1), { samplingRate: 256 });
      for (const v of spec.values) expect(Number.isFinite(v)).toBe(true);
    }
  });
});
