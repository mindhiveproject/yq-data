/**
 * Golden-value tests: BandPower.
 *
 * Fixture: `band_power.json` (see `ref_spectral.py`). Two questions:
 *
 *  1. Conformance -- does BandPower compute what it documents? Reference: the
 *     package's convention (periodogram + exact-edge trapezoid integration over
 *     [lo, hi]) evaluated with SciPy. Expected to match to float32 precision.
 *  2. Field standard -- does the number mean what an EEG researcher would take
 *     it to mean? Reference: YASA `bandpower` (Vallat & Walker, 2021), i.e.
 *     Welch PSD integrated over each band. Judged with a stated tolerance.
 */
import "./allclose";
import { BandPower, BandPowerParameters } from "../../../src";
import { fixture, inputs, packetFor } from "./harness";

interface OwnConvention extends Required<
  Pick<BandPowerParameters, "window" | "scaling" | "aggregate" | "relative">
> {
  channelAverage: number[];
  perChannel: number[][];
}

interface BandPowerDoc {
  cases: {
    signal: string;
    bands: Record<string, [number, number]>;
    ownConvention: OwnConvention[];
    integratedPsdPerChannel: number[][];
    yasa: {
      absolutePerChannel: number[][];
      relativePerChannel: number[][];
      relativeChannelAverage: number[];
    };
  }[];
}

const golden = fixture<BandPowerDoc>("band_power");

/** The BandPower parameters a fixture configuration describes. */
const params = ({ window, scaling, aggregate, relative }: OwnConvention) => ({
  window,
  scaling,
  aggregate,
  relative,
});

const mean = (rows: number[][]) =>
  rows[0].map((_, j) => rows.reduce((s, r) => s + r[j], 0) / rows.length);

/** BandPower perChannel output is band-major: index = band * channels + channel. */
const perChannelRows = (data: ArrayLike<number>, channels: number, bands: number) =>
  Array.from({ length: channels }, (_, c) =>
    Array.from({ length: bands }, (_, b) => data[b * channels + c])
  );

// Agreement bar against YASA's relative band power, in absolute fraction of
// total power. Short windows (2-4 s) leave only 6-16 bins per band, where
// YASA's inclusive edges and Simpson weighting legitimately move a band by a
// few percent; 0.04 is the measured spread between two correct pipelines.
const YASA_RELATIVE_ATOL = 0.04;
const YASA_RELATIVE_PER_CHANNEL_ATOL = 0.06;

// Absolute power, per band, relative to YASA's. Two Welch/periodogram
// pipelines that differ in window (Hamming vs Hann) and integration rule agree
// to a few percent on most bands: 6% is the measured spread. Alpha is the
// exception. Its narrow peak spans a few bins, where YASA's Simpson weights
// read 5-12% below the trapezoid rule on YASA's own PSD, and the package's
// trapezoid sum preserves power (Parseval). Alpha gets 20%.
const YASA_ABSOLUTE_RTOL = 0.06;
const YASA_ABSOLUTE_ALPHA_RTOL = 0.2;

describe.each(golden.cases)("golden: BandPower on $signal", (c) => {
  const packet = packetFor(c.signal);
  const channels = inputs[c.signal].channels.length;
  const bandCount = Object.keys(c.bands).length;
  const run = (p: BandPowerParameters) => new BandPower(p).analyze(packet)!;

  describe("conformance with its own documented convention", () => {
    it.each(c.ownConvention)(
      "$window / $scaling / $aggregate / relative=$relative, channel average",
      (cfg) => {
        const out = run(params(cfg));
        expect(Array.from(out.data)).toBeAllClose(cfg.channelAverage, { rtol: 1e-5 });
      }
    );

    it.each(c.ownConvention.filter((cfg) => !cfg.relative))(
      "$window / $scaling / $aggregate, perChannel",
      (cfg) => {
        const out = run({ ...params(cfg), perChannel: true });
        const rows = perChannelRows(out.data, channels, bandCount);
        expect(rows.flat()).toBeAllClose(cfg.perChannel.flat(), { rtol: 1e-5 });
      }
    );
  });

  describe("against the field standard (YASA bandpower)", () => {
    const yasaRelative = c.yasa.relativeChannelAverage;
    const yasaAbsolute = mean(c.yasa.absolutePerChannel);
    const bandNames = Object.keys(c.bands);

    // The default is absolute power (psd, integrated), so `relative: true` is
    // a share of power, as YASA computes it.
    it(`default config with relative: true agrees with YASA within ${YASA_RELATIVE_ATOL}`, () => {
      const out = run({ relative: true });
      expect(Array.from(out.data)).toBeAllClose(yasaRelative, {
        rtol: 0,
        atol: YASA_RELATIVE_ATOL,
      });
    });

    it(`hann + relative agrees with YASA within ${YASA_RELATIVE_ATOL}`, () => {
      const out = run({ window: "hann", relative: true });
      expect(Array.from(out.data)).toBeAllClose(yasaRelative, {
        rtol: 0,
        atol: YASA_RELATIVE_ATOL,
      });
    });

    // The default is absolute band power: the integral of the PSD, in units^2.
    it("default config is band power in units^2 (integral of the PSD)", () => {
      const out = run({});
      expect(Array.from(out.data)).toBeAllClose(mean(c.integratedPsdPerChannel), {
        rtol: 1e-4,
      });
    });

    // Band edges are integrated exactly (trapezoid, interpolated at lo and
    // hi). Snapping them to whole bins put delta +14% to +26% over YASA's,
    // because the spectrum falls steeply at the 1 Hz edge.
    it(`default config agrees with YASA absolute power (rtol ${YASA_ABSOLUTE_RTOL}, alpha ${YASA_ABSOLUTE_ALPHA_RTOL})`, () => {
      const out = Array.from(run({}).data);
      const alpha = bandNames.indexOf("Alpha");
      for (let b = 0; b < bandNames.length; b++) {
        expect([out[b]]).toBeAllClose([yasaAbsolute[b]], {
          rtol: b === alpha ? YASA_ABSOLUTE_ALPHA_RTOL : YASA_ABSOLUTE_RTOL,
        });
      }
    });

    // A band edge between bins contributes its exact share, so adjacent bands
    // partition the spectrum with no gap and no double count.
    it("contiguous bands sum to the power across their combined range", () => {
      const whole = run({ bands: { All: [1, 45] } }).data[0];
      const parts = run({}).data;
      expect([Array.from(parts).reduce((s, v) => s + v, 0)]).toBeAllClose([whole], {
        rtol: 1e-4,
      });
    });

    // perChannel + relative normalises each channel on its own, so one
    // channel's bands sum to 1, as YASA's per-channel relative power does.
    if (channels > 1) {
      it("perChannel + relative gives each channel's own band fractions", () => {
        const out = run({ relative: true, perChannel: true });
        const rows = perChannelRows(out.data, channels, bandCount);
        for (const row of rows) {
          expect([row.reduce((s, v) => s + v, 0)]).toBeAllClose([1], { rtol: 1e-5 });
        }
        // A single channel carries more of the alpha-peak Simpson effect than
        // the channel average does (measured 0.045), so it gets its own bar.
        expect(rows.flat()).toBeAllClose(c.yasa.relativePerChannel.flat(), {
          rtol: 0,
          atol: YASA_RELATIVE_PER_CHANNEL_ATOL,
        });
      });
    }
  });
});
