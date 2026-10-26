/**
 * Golden-value tests: window functions, the spectrum primitive and the
 * Spectrum node against SciPy.
 *
 * Fixtures: `window.json`, `spectrum.json` (see `ref_stats.py`,
 * `ref_spectral.py`). The spectrum references are `scipy.signal.periodogram`
 * called with exactly the package's documented convention -- symmetric
 * window, mean removed, zero-padded to a power of two -- so these are
 * conformance tests: the package should match to float32 precision.
 */
import "./allclose";
import {
  SpectrumAnalyzer,
  WindowType,
  getWindow,
  spectrum,
  windowPower,
} from "../../../src";
import { fixture, inputs, maxAbs, packetFor } from "./harness";

interface WindowDoc {
  cases: {
    type: WindowType;
    length: number;
    symmetric: number[];
    periodic: number[];
    power: number;
  }[];
}

interface SpectrumCase {
  signal: string;
  window: WindowType;
  detrend: boolean;
  fftLength: number;
  resolution: number;
  frequencies: number[];
  magnitude: number[][];
  psd: number[][];
  nyquistPsd: number[];
}

interface SpectrumDoc {
  cases: SpectrumCase[];
  amplitude: {
    signal: string;
    trueAmplitude: number;
    bin: number;
    windows: Record<string, { heinzelAmplitudeAtBin: number; coherentGain: number }>;
  };
}

const windows = fixture<WindowDoc>("window");
const golden = fixture<SpectrumDoc>("spectrum");

describe("golden: window functions vs scipy.signal.windows (sym=True)", () => {
  const regular = windows.cases.filter((c) => c.length > 1);

  it.each(regular)("$type, N = $length", (c) => {
    // Float32Array storage: ~7 significant digits. Blackman's endpoints are
    // 0 in exact arithmetic and -1.4e-17 in SciPy, hence the atol.
    expect(Array.from(getWindow(c.type, c.length))).toBeAllClose(c.symmetric, {
      rtol: 1e-6,
      atol: 1e-7,
    });
    expect([windowPower(c.type, c.length)]).toBeAllClose([c.power], { rtol: 1e-6 });
  });

  // A one-sample window is degenerate, but SciPy (and NumPy) define it as
  // [1.0]. Was divergence D10 (the cosine formula at phase 0 gave 0.08 for
  // Hamming and 0 for Hann/Blackman).
  it("N = 1 is the identity window, as in SciPy", () => {
    for (const c of windows.cases.filter((w) => w.length === 1)) {
      expect(Array.from(getWindow(c.type, 1))).toBeAllClose(c.symmetric, { rtol: 1e-6 });
    }
  });
});

describe("golden: spectrum() vs scipy.signal.periodogram", () => {
  describe.each(golden.cases)("$signal / $window / detrend=$detrend", (c) => {
    const sig = inputs[c.signal];
    const run = (ch: number[], scaling: "psd" | "magnitude") =>
      spectrum(Float32Array.from(ch), {
        samplingRate: sig.fs,
        window: c.window,
        detrend: c.detrend,
        scaling,
      });

    it("bin layout: fftLength, resolution, frequencies (nfft/2 bins, no Nyquist)", () => {
      const s = run(sig.channels[0], "psd");
      expect(s.fftLength).toBe(c.fftLength);
      expect([s.resolution]).toBeAllClose([c.resolution], { rtol: 1e-12 });
      expect(Array.from(s.frequencies)).toBeAllClose(c.frequencies, { rtol: 1e-6, atol: 1e-9 });
      // Convention: SciPy / numpy.fft.rfft return nfft/2 + 1 one-sided bins;
      // the package stops at nfft/2 - 1, dropping the Nyquist bin.
      expect(s.values.length).toBe(c.fftLength / 2);
    });

    it("psd scaling equals the periodogram (density)", () => {
      sig.channels.forEach((ch, i) => {
        const s = run(ch, "psd");
        // Measured agreement is within 6e-8 of the peak bin (float32 output
        // rounding, not the transform). The atol is relative
        // to the peak because leakage-floor bins carry float32 noise that is
        // large relative to themselves but negligible on the spectrum's scale.
        expect(Array.from(s.values)).toBeAllClose(c.psd[i], {
          rtol: 1e-5,
          atol: 1e-6 * maxAbs(c.psd[i]),
        });
      });
    });

    it("magnitude scaling equals 2|X|/sum(w), as documented", () => {
      sig.channels.forEach((ch, i) => {
        const s = run(ch, "magnitude");
        expect(Array.from(s.values)).toBeAllClose(c.magnitude[i], {
          rtol: 1e-5,
          atol: 1e-6 * maxAbs(c.magnitude[i]),
        });
      });
    });
  });
});

describe("golden: amplitude spectrum recovers sinusoid amplitude (Heinzel 2002)", () => {
  const { signal, trueAmplitude, bin } = golden.amplitude;
  const x = Float32Array.from(inputs[signal].channels[0]);
  const read = (window: WindowType) =>
    spectrum(x, { samplingRate: inputs[signal].fs, window, scaling: "magnitude" }).values[bin];

  it("rectangular window: 2|X|/N reads the amplitude exactly", () => {
    expect([read("rectangular")]).toBeAllClose([trueAmplitude], { rtol: 1e-6 });
  });

  // Normalizing by sum(w) rather than by nfft is what makes this hold for a
  // tapered window. Was divergence D3: dividing by nfft read every bin low by
  // the coherent gain (0.54 Hamming, 0.5 Hann), and by len/nfft more when
  // zero padded.
  for (const window of ["hamming", "hann"] as const) {
    it(`${window} window: magnitude reads the true amplitude`, () => {
      const value = read(window);
      expect([value]).toBeAllClose([trueAmplitude], { rtol: 1e-3 });
    });
  }
});

describe("golden: Spectrum node", () => {
  const c = golden.cases.find(
    (k) => k.signal === "eeg_muse_4s" && k.window === "hamming" && k.detrend
  )!;
  const channels = inputs[c.signal].channels.length;

  it("interleaved multi-channel psd, trimmed at maxFrequency", () => {
    const maxFrequency = 45;
    const out = new SpectrumAnalyzer({ scaling: "psd", maxFrequency }).analyze(
      packetFor(c.signal)
    )!;
    const bins = Math.ceil(maxFrequency / c.resolution);
    expect(out.metadata.additionalMetadata?.bins).toBe(bins);
    expect(out.metadata.additionalMetadata?.frequencies).toBeAllClose(
      c.frequencies.slice(0, bins),
      { rtol: 1e-6, atol: 1e-9 }
    );
    for (let ch = 0; ch < channels; ch++) {
      const series = Array.from({ length: bins }, (_, k) => out.data[k * channels + ch]);
      expect(series).toBeAllClose(c.psd[ch].slice(0, bins), {
        rtol: 1e-5,
        atol: 1e-6 * maxAbs(c.psd[ch]),
      });
    }
  });
});
