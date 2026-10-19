/**
 * Golden-value tests: descriptive statistics, normalization, detrending and
 * correlation against NumPy / SciPy.
 *
 * Fixture: `stats.json` (see `ref_stats.py` for the exact reference calls).
 *
 * Tests named `[divergence] ...` use `divergence` (= `it.failing`): each asserts the
 * reference behaviour and is *expected to fail* today, documenting a measured
 * gap. If one starts passing, Jest reports it -- the gap was closed, so drop
 * the `.failing`. Each names its divergence ID (D1-D10), tracked in the
 * Open Gaps list of the package spec; see README.md.
 */
import "./allclose";
import {
  Correlation,
  Normalization,
  StatisticalFeatures,
  correlation,
  detrend,
  maximum,
  mean,
  median,
  minMaxNormalize,
  minimum,
  polyfit,
  standardDeviation,
  variance,
  zScore,
} from "../../../src";
import {
  channelsOf,
  divergence,
  fixture,
  inputs,
  maxAbs,
  packetFor,
  recorder,
} from "./harness";

interface StatsDoc {
  descriptive: {
    signal: string;
    mean: number[];
    varPopulation: number[];
    varSample: number[];
    stdPopulation: number[];
    stdSample: number[];
    min: number[];
    max: number[];
    median: number[];
    fromFloat32: Record<"mean" | "std" | "rms" | "min" | "max", number[]>;
  }[];
  normalizers: { signal: string; zscore: number[][]; minmax: number[][] }[];
  polyfit: { signal: string; degree: number; coefficients: number[] }[];
  detrend: {
    signal: string;
    samples: number;
    constant: number[];
    linear: number[];
    poly6?: number[];
  }[];
  correlation: {
    a: string;
    b: string;
    matrix: number[][];
    matrixFromFloat32: number[][];
    unequal: { a: string; b: string; overlap: number; paired: number[] };
  };
}

const golden = fixture<StatsDoc>("stats");
const rec = recorder("stats");
afterAll(() => rec.flush());

const f32 = (x: number[]) => Float32Array.from(x);

describe("golden: descriptive statistics vs NumPy", () => {
  describe.each(golden.descriptive)("$signal", (c) => {
    const chans = inputs[c.signal].channels;
    // Absolute floor scaled to the signal: a zero-mean sine has a mean of
    // ~1e-17, where a relative tolerance alone is meaningless.
    const scale = Math.max(...chans.map((ch) => maxAbs(ch)));
    const tight = { rtol: 1e-12, atol: 1e-12 * scale };

    it("mean / min / max / median", () => {
      expect(chans.map(mean)).toBeAllClose(c.mean, tight);
      expect(chans.map(minimum)).toBeAllClose(c.min, { rtol: 0 });
      expect(chans.map(maximum)).toBeAllClose(c.max, { rtol: 0 });
      expect(chans.map(median)).toBeAllClose(c.median, { rtol: 0 });
    });

    it("variance and standard deviation, both ddof conventions", () => {
      const vtol = { rtol: 1e-11, atol: 1e-12 * scale * scale };
      expect(chans.map((x) => variance(x))).toBeAllClose(c.varPopulation, vtol);
      expect(chans.map((x) => variance(x, true))).toBeAllClose(c.varSample, vtol);
      expect(chans.map((x) => standardDeviation(x))).toBeAllClose(c.stdPopulation, tight);
      expect(chans.map((x) => standardDeviation(x, true))).toBeAllClose(c.stdSample, tight);
    });

    it("StatisticalFeatures over the float32 packet", () => {
      const out = new StatisticalFeatures({
        features: ["mean", "std", "rms", "min", "max"],
      }).analyze(packetFor(c.signal));
      expect(out).not.toBeNull();
      const values = Array.from(out!.data);
      const expected: number[] = [];
      for (let ch = 0; ch < chans.length; ch++) {
        for (const k of ["mean", "std", "rms", "min", "max"] as const) {
          expected.push(c.fromFloat32[k][ch]);
        }
      }
      // Float32Array output: ~6 significant digits of the value, with an
      // absolute floor relative to the signal for near-zero means.
      expect(values).toBeAllClose(expected, { rtol: 1e-6, atol: 1e-6 * scale });
    });
  });
});

describe("golden: normalization vs SciPy", () => {
  describe.each(golden.normalizers)("$signal", (c) => {
    const chans = inputs[c.signal].channels;

    it("zScore matches scipy.stats.zscore(ddof=0)", () => {
      chans.forEach((ch, i) =>
        expect(Array.from(zScore(f32(ch)))).toBeAllClose(c.zscore[i], { rtol: 1e-5, atol: 1e-6 })
      );
    });

    it("minMaxNormalize matches (x - min) / (max - min)", () => {
      chans.forEach((ch, i) =>
        expect(Array.from(minMaxNormalize(f32(ch)))).toBeAllClose(c.minmax[i], {
          rtol: 1e-6,
          atol: 1e-7,
        })
      );
    });

    it("Normalization node, zscore and minmax modes", () => {
      const packet = packetFor(c.signal);
      const z = new Normalization({ mode: "zscore" }).analyze(packet)!;
      const m = new Normalization({ mode: "minmax" }).analyze(packet)!;
      channelsOf(z.data, chans.length).forEach((ch, i) =>
        expect(ch).toBeAllClose(c.zscore[i], { rtol: 1e-5, atol: 1e-6 })
      );
      channelsOf(m.data, chans.length).forEach((ch, i) =>
        expect(ch).toBeAllClose(c.minmax[i], { rtol: 1e-6, atol: 1e-7 })
      );
    });
  });
});

describe("golden: polynomial fit vs numpy.polynomial", () => {
  it.each(golden.polyfit)("$signal degree $degree", (c) => {
    const y = inputs[c.signal].channels[0];
    const t = y.map((_, i) => i / inputs[c.signal].fs);
    const coefficients = polyfit(t, y, c.degree);
    rec.record(`polyfit:${c.signal}:${c.degree}`, coefficients);
    // Normal equations square the condition number of the Vandermonde system,
    // so low degrees are fine but precision is lost relative to NumPy's
    // scaled lstsq; 1e-7 relative still pins the coefficients.
    expect(coefficients).toBeAllClose(c.coefficients, {
      rtol: 1e-7,
      atol: 1e-9 * maxAbs(c.coefficients),
    });
  });
});

describe("golden: detrend vs scipy.signal.detrend", () => {
  describe.each(golden.detrend)("$signal ($samples samples)", (c) => {
    const sig = inputs[c.signal];
    const x = f32(sig.channels[0].slice(0, c.samples));
    // float32 output on inputs with large offsets: the residual cannot be
    // more precise than float32 ulp of the *input* (e.g. ~5e-4 at 5000 uV).
    const atol = 4 * maxAbs(x) * 2 ** -23;

    it("degree 0 removes the mean (type='constant')", () => {
      expect(Array.from(detrend(x, 0))).toBeAllClose(c.constant, { rtol: 1e-6, atol });
    });

    it("degree 1 removes the least-squares line (type='linear')", () => {
      expect(Array.from(detrend(x, 1, sig.fs))).toBeAllClose(c.linear, { rtol: 1e-5, atol });
    });

    if (c.poly6) {
      const poly6 = c.poly6;
      it("degree 6 (HeartRate default) matches numpy Polynomial.fit", () => {
        // Normal equations are the textbook way to lose precision on a
        // degree-6 Vandermonde system, but with partial pivoting in float64
        // the measured error is ~1e-7 of the residual RMS -- float32 output
        // rounding, not the solve. 1e-5 leaves headroom.
        const sd = Math.sqrt(poly6.reduce((s, v) => s + v * v, 0) / poly6.length);
        const actual = Array.from(detrend(x, 6, sig.fs));
        rec.record(`poly6:${c.signal}:${c.samples}`, actual);
        expect(actual).toBeAllClose(poly6, { rtol: 0, atol: 1e-5 * sd });
      });
    }
  });
});

describe("golden: Pearson correlation vs scipy.stats.pearsonr", () => {
  const { a, b, matrix, matrixFromFloat32, unequal } = golden.correlation;
  const A = inputs[a].channels;
  const B = inputs[b].channels;

  it("pure correlation() over float64", () => {
    const actual = A.map((x) => B.map((y) => correlation(x, y)));
    expect(actual.flat()).toBeAllClose(matrix.flat(), { rtol: 1e-12, atol: 1e-14 });
  });

  it("Correlation node, matrix / paired / mean modes", () => {
    const packets = { a: packetFor(a), b: packetFor(b) };
    const m = new Correlation({ mode: "matrix" }).analyze(packets)!;
    const p = new Correlation({ mode: "paired" }).analyze(packets)!;
    const avg = new Correlation({ mode: "mean" }).analyze(packets)!;
    const tol = { rtol: 1e-6, atol: 1e-7 };
    expect(Array.from(m.data)).toBeAllClose(matrixFromFloat32.flat(), tol);
    expect(Array.from(p.data)).toBeAllClose(
      [matrixFromFloat32[0][0], matrixFromFloat32[1][1]],
      tol
    );
    expect(Array.from(avg.data)).toBeAllClose(
      [(matrixFromFloat32[0][0] + matrixFromFloat32[1][1]) / 2],
      tol
    );
  });

  // The node documents "computed over the shorter of the two windows", but
  // stats.ts `correlation` takes each mean over the *whole* array before
  // summing over the overlap. Divergence D8.
  divergence("[divergence] unequal window lengths: r over the overlap", () => {
    const out = new Correlation({ mode: "paired" }).analyze({
      a: packetFor(unequal.a),
      b: packetFor(unequal.b),
    })!;
    rec.record("correlation:unequal", Array.from(out.data));
    expect(Array.from(out.data)).toBeAllClose(unequal.paired, { rtol: 1e-5, atol: 1e-6 });
  });
});
