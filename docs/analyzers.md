# Analyzers

| Method | Class | Does |
|---|---|---|
| `WINDOWING` | `Windowing` | Buffers into fixed, optionally overlapping windows |
| `FILTERING` | `Filtering` | Butterworth (`scipy.signal.butter`) or windowed-sinc FIR (`firwin`) low/high/band/stop, stateful across packets |
| `NORMALIZATION` | `Normalization` | Min-max, z-score, fixed range, or a decaying running range |
| `CHANNEL_SELECTION` | `ChannelSelection` | Pick or average channels by index or label |
| `FFT` / `PSD` | `SpectrumAnalyzer` | Per-channel spectrum |
| `PULSE_EXTRACTION` | `PulseExtraction` | Camera skin colour to a pulse waveform (POS) |
| `BAND_POWER` | `BandPower` | Power in named frequency bands |
| `STATISTICAL_FEATURES` | `StatisticalFeatures` | Mean, std, RMS, min, max, range |
| `RMS` | `RMSAnalyzer` | Amplitude, linear or dBFS |
| `HEART_RATE` | `HeartRate` | BPM from a pulse waveform, plus HRV |
| `CONNECTIVITY` | `Correlation` | Correlation between two streams |
| `MATH` | `MathNode` | Arithmetic between two streams: add, subtract, multiply, divide, power; then optional absolute value, scale and offset |
| `STREAM_SELECTION` | `StreamSelection` | Passes some streams off a shared wire, drops the rest |
| `MERGE` | `Merge` | Joins several streams into one multi-channel stream |

Register your own with `registerAnalyzer(method, factory)`; built-in and custom
nodes execute through the same evaluator.

`HeartRate` detects beats with MSPTDfast v2 (Charlton et al., 2025), the
efficient form of MSPTD. MSPTD and qppg were the two best of fifteen
open-source PPG beat detectors benchmarked by Charlton et al. (2022). The port
matches the authors' MATLAB sample for sample. The rate is the median
inter-beat interval in the window. A beat within about half an interval of
the window's edges is not detected, so a 10 s window reports one or two fewer
intervals than it holds, but never a false one. The previous detector, the
adaptive threshold of Shin, Lee & Lee (2009), remains available as
`detector: "adaptive-threshold"`. The node's `spectral` strategy skips detection
entirely and takes the dominant frequency of the pulse band, which is steadier
on camera-derived rPPG but reports no variability. See [References](references.md).

`BandPower` reports absolute power by default: a Hamming-windowed PSD
integrated across each band, in µV² for EEG, as YASA, MNE and EEGLAB report
it. For **relative band power**, set `relative: true` and leave the other
defaults alone:

```ts
{ id: "bands", method: AnalysisMethod.BAND_POWER, parameters: { relative: true } }
```

Each band is then its share of the total power across the configured bands,
so the bands sum to 1. This agrees with YASA's `bandpower(relative=True)` to
within 0.04 on the channel average and 0.06 per channel. Three things to keep
in mind:

- **Keep `scaling: "psd"` and `aggregate: "sum"`.** With `"magnitude"` or
  `"mean"`, normalising gives a share of amplitude or of mean density, not of
  power, and alpha reads well below its true share.
- **The total is the sum of the bands you define.** Keep them contiguous and
  non-overlapping, as the defaults are (1–45 Hz), or a gap goes uncounted and
  an overlap is counted twice.
- **Channels.** With `perChannel: true`, each channel is normalised on its own.
  Without it, absolute power is averaged across channels first and the average
  is normalised, so louder channels weigh more.

## Working with the DSP directly

Everything under `analyzer/methods` is a pure function over plain arrays, usable
without any packet, receiver or pipeline:

```ts
import { spectrum, bandAverage, butter, sosfiltfilt } from "@mindhive_science/yq-data";

// Same call, same coefficients as scipy.signal.butter(4, [1, 40], "bandpass", fs=256, output="sos")
const sos = butter(4, [1, 40], { btype: "bandpass", fs: 256, output: "sos" });
const clean = sosfiltfilt(sos, signal);        // scipy.signal.sosfiltfilt
const spec = spectrum(clean, { samplingRate: 256, window: "hamming" });
const alpha = bandAverage(spec, 8, 12);
```

The DSP has no dependencies: the FFT behind every spectrum is a radix-2
transform in `analyzer/methods/fft.ts`.
