/**
 * Golden-value tests: filter design, the difference-equation engine, the
 * streaming Filtering node and zero-phase filtering, against SciPy.
 *
 * Fixtures: `filter_design.json`, `lfilter.json`, `filter_streaming.json`,
 * `filtfilt.json` (see `ref_filter.py`).
 *
 * Design is compared by magnitude response |H(f)|, not by coefficients:
 * section ordering and pairing may legitimately differ. Band filters of
 * package order K are compared with `scipy.signal.butter(K // 2, ...)`, which
 * has the same number of poles (SciPy doubles the order of band designs).
 *
 * `[divergence]` tests use `divergence` (= `it.failing`); see README.md.
 */
import "./allclose";
import {
  Biquad,
  FilterKind,
  Filtering,
  designFilter,
  filtfilt,
  filtfiltCascade,
  lfilter,
} from "../../../src";
import {
  cascadeMagnitude,
  channelsOf,
  divergence,
  fixture,
  inputs,
  maxAbsDiff,
  packetStream,
  recorder,
  rmsOf,
  toDb,
} from "./harness";

interface DesignCase {
  id: string;
  kind: FilterKind;
  cutoff: number | [number, number];
  samplingRate: number;
  order: number;
  why: string;
  frequencies: number[];
  magnitude: number[];
}

const design = fixture<{ cases: DesignCase[] }>("filter_design");
const lf = fixture<{
  cases: { id: string; signal: string; b: number[]; a: number[]; output: number[] }[];
}>("lfilter");
const streaming = fixture<{
  cases: {
    id: string;
    signal: string;
    kind: FilterKind;
    cutoff: number | [number, number];
    order: number;
    packetSize: number;
    output: number[][];
  }[];
}>("filter_streaming");
const ff = fixture<{
  cases: {
    id: string;
    signal: string;
    b: number[];
    a: number[];
    scipy: number[];
    zeroInitOddPad: number[];
  }[];
  sosCases: { id: string; signal: string; sections: Biquad[]; scipy: number[] }[];
}>("filtfilt");

const rec = recorder("filter");
afterAll(() => rec.flush());

const responseOf = (c: DesignCase) =>
  cascadeMagnitude(
    designFilter({
      kind: c.kind,
      cutoff: c.cutoff,
      samplingRate: c.samplingRate,
      order: c.order,
    }),
    c.frequencies,
    c.samplingRate
  );

const byId = (id: string) => design.cases.find((c) => c.id === id)!;

describe("golden: Butterworth design vs scipy.signal.butter", () => {
  const even = design.cases.filter(
    (c) => (c.kind === "lowpass" || c.kind === "highpass") && c.order % 2 === 0
  );
  const band = design.cases.filter((c) => c.kind === "bandpass" || c.kind === "bandstop");

  it.each(even)("$id ($why)", (c) => {
    const actual = responseOf(c);
    rec.record(`design:${c.id}`, actual);
    // RBJ biquads with Butterworth pole-pair Qs are the bilinear transform of
    // the analog prototype, prewarped at the cutoff -- exactly what butter()
    // does. Measured agreement is ~1e-15 (1e-12 for the 0.5 Hz high-pass).
    expect(actual).toBeAllClose(c.magnitude, { rtol: 0, atol: 1e-10 });
  });

  it("odd order is rounded up: order 3 realises butter(4)", () => {
    // Documented convention (FilteringParameters.order): an order is realised
    // as round(order / 2) biquads, so 3 -> 4th order, 5 -> 6th.
    const actual = responseOf(byId("lowpass_40_256_o3"));
    expect(actual).toBeAllClose(byId("lowpass_40_256_o4").magnitude, { rtol: 0, atol: 1e-10 });
  });

  describe.each(band)("$id ($why)", (c) => {
    const actual = responseOf(c);
    rec.record(`design:${c.id}`, actual);
    const edges = c.cutoff as [number, number];
    const at = (f: number) => actual[c.frequencies.indexOf(f)];

    // A Butterworth band filter is -3.01 dB at both cutoffs by definition.
    // designFilter realises a band filter as identical RBJ band biquads at
    // the geometric centre, so the edges sit at -3 dB *per section*: -6 dB
    // for the default order 4, and the passband sags between them.
    // Divergence D1.
    divergence("[divergence] -3.01 dB at both cutoff frequencies", () => {
      expect([toDb(at(edges[0])), toDb(at(edges[1]))]).toBeAllClose([-3.0103, -3.0103], {
        rtol: 0,
        atol: 0.1,
      });
    });

    divergence("[divergence] magnitude response matches scipy within 0.1 dB above -20 dB", () => {
      const keep = c.magnitude.map((m) => m > 0.1);
      const pkgDb = actual.filter((_, i) => keep[i]).map(toDb);
      const refDb = c.magnitude.filter((_, i) => keep[i]).map(toDb);
      expect(pkgDb).toBeAllClose(refDb, { rtol: 0, atol: 0.1 });
    });
  });
});

describe("golden: lfilter vs scipy.signal.lfilter", () => {
  describe.each(lf.cases)("$id on $signal", (c) => {
    const x = Float32Array.from(inputs[c.signal].channels[0]);
    const y = lfilter(c.b, c.a, x);
    rec.record(`lfilter:${c.id}`, y);

    it("matches to float32 precision of the output scale", () => {
      // The engine stores y[n] in a Float32Array and feeds it back, so the
      // recursion runs at float32 width. Measured: 8e-8 (FIR), 8e-7 (10 Hz
      // biquad), 3e-5 of output RMS for the 0.5 Hz high-pass on a 5000 uV
      // offset -- poles near z = 1 amplify float32 rounding. 1e-4 of RMS
      // bounds all three; in absolute terms the worst case is 0.01 uV.
      const tol = 1e-4 * rmsOf(c.output);
      expect(maxAbsDiff(y, c.output)).toBeLessThan(tol);
    });
  });
});

describe("golden: Filtering node, streamed in device-sized packets", () => {
  const run = (c: (typeof streaming.cases)[number]) => {
    const node = new Filtering({ kind: c.kind, cutoff: c.cutoff, order: c.order });
    const count = inputs[c.signal].channels.length;
    const out: number[][] = Array.from({ length: count }, () => []);
    for (const packet of packetStream(c.signal, c.packetSize)) {
      channelsOf(node.analyze(packet)!.data, count).forEach((ch, i) => out[i].push(...ch));
    }
    return out;
  };

  const matched = streaming.cases.filter((c) => c.kind !== "bandpass");
  it.each(matched)("$id: state carries across $packetSize-sample packets", (c) => {
    const out = run(c);
    rec.record(`stream:${c.id}`, out);
    out.forEach((ch, i) => {
      // Same float32 budget as lfilter above: chunking adds nothing, which is
      // the point -- 640 packet boundaries and no discontinuity at any.
      expect(maxAbsDiff(ch, c.output[i])).toBeLessThan(1e-4 * rmsOf(c.output[i]));
    });
  });

  // The default Filtering node (bandpass [1, 40], order 4) inherits the band
  // design gap. Divergence D1.
  const banded = streaming.cases.filter((c) => c.kind === "bandpass");
  divergence.each(banded)(
    "[divergence] $id: default bandpass output matches a Butterworth bandpass",
    (c) => {
      const out = run(c);
      rec.record(`stream:${c.id}`, out);
      out.forEach((ch, i) =>
        expect(maxAbsDiff(ch, c.output[i])).toBeLessThan(1e-2 * rmsOf(c.output[i]))
      );
    }
  );
});

describe("golden: zero-phase filtering vs scipy.signal.filtfilt", () => {
  const EDGE = 64; // samples treated as "edge"; 1 s at 64 Hz

  describe.each(ff.cases)("$id", (c) => {
    const x = Float32Array.from(inputs[c.signal].channels[0]);
    const y = filtfilt(c.b, c.a, x);
    rec.record(`filtfilt:${c.id}`, y);
    const scale = rmsOf(c.scipy);

    it("reproduces its documented convention (odd padding, zero initial state)", () => {
      // float32 arithmetic on a start-up transient as large as the input's
      // offset (1.2e5 for the raw-sensor case): 1e-6 of that offset.
      expect(maxAbsDiff(y, c.zeroInitOddPad)).toBeLessThan(1e-6 * Math.max(...x.map(Math.abs)));
    });

    it("interior matches scipy.signal.filtfilt", () => {
      expect(maxAbsDiff(y, c.scipy, EDGE, x.length - EDGE)).toBeLessThan(1e-5 * scale);
    });

    // filter.ts says odd padding keeps "the filter's transient out of the
    // result", but with 3*order samples of padding and a zero initial state it
    // does not: SciPy also seeds each pass with the step-response steady
    // state (lfilter_zi; cf. Gustafsson 1996). Divergence D6.
    divergence("[divergence] edges match scipy.signal.filtfilt", () => {
      expect(maxAbsDiff(y, c.scipy)).toBeLessThan(1e-5 * scale);
    });
  });

  describe.each(ff.sosCases)("$id (cascade)", (c) => {
    const x = Float32Array.from(inputs[c.signal].channels[0]);
    const y = filtfiltCascade(c.sections, x);
    rec.record(`sosfiltfilt:${c.id}`, y);
    const scale = rmsOf(c.scipy);

    it("interior matches scipy.signal.sosfiltfilt", () => {
      // Zero-phase passes of LTI sections commute, so filtering section by
      // section equals filtering the cascade -- away from the edges.
      expect(maxAbsDiff(y, c.scipy, 2 * EDGE, x.length - 2 * EDGE)).toBeLessThan(1e-5 * scale);
    });

    divergence("[divergence] edges match scipy.signal.sosfiltfilt", () => {
      expect(maxAbsDiff(y, c.scipy)).toBeLessThan(1e-5 * scale);
    });
  });
});
