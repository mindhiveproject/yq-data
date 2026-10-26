# Golden-value suite

Checks that the package's DSP produces the **same numbers** as the reference
libraries the field already trusts, and says so precisely where it does not.

- **Conformance** references are NumPy / SciPy called with exactly the
  convention the package documents. These must match to float precision.
- **Field-standard** references are the pipelines researchers actually use:
  YASA for EEG band power, NeuroKit2 for PPG beats and HRV, and for beat
  detection the original MATLAB of the detectors the field benchmarks
  (MSPTDfast and qppgfast from the ppg-beats toolbox, run under GNU Octave).
  For camera rPPG, POS from the two toolboxes the field uses, pyVHR and
  rPPG-Toolbox, run from the authors' Python.
  Synthetic signals carry their own **ground truth** (true beat locations,
  true rate). A real PPG recording is labelled from the ECG recorded with it.
  These are judged against stated, justified tolerances.

**Results** live in two places. The tests are the live record: run
`npm run golden` to see every case by name. The history of divergences from the
references (D1–D10, all closed) and the documented conventions (C1–C6) is in
the *Open Gaps* section of the package spec in Notion, under *Golden-value
divergences*. Comments in the tests say "Was D8" and so on where a gap was
closed. The literature and libraries the references come
from are listed under [References](#references) below.

The reference values are computed **offline in Python** and committed as JSON.
Jest never runs Python: it loads the fixtures and compares. Nothing here ships
in the npm package. `package.json` publishes `dist/` only, so this whole
directory is repo-only.

## Layout

| File | Role |
| --- | --- |
| `inputs.py` | The signal registry: every input defined once, with ground truth where synthetic. |
| `generate.py` | Runs every reference, writes the fixtures. |
| `ref_common.py` | Shared helpers: versions, float32 rounding, compact JSON. |
| `ref_stats.py` | Statistics, normalization, polyfit/detrend, correlation, windows. |
| `ref_spectral.py` | Periodogram, amplitude spectrum, band power (own convention + YASA). |
| `ref_filter.py` | Butterworth responses and coefficients, `firwin`, window functions, `lfilter`/`sosfilt` (with initial state), `filtfilt`/`sosfiltfilt` over every pad type. |
| `ref_cardiac.py` | HRV definitions (NeuroKit2), the ppg-beats MATLAB detectors (MSPTDfast v2, qppgfast) under Octave, NeuroKit2's MSPTDfast port and PPG pipeline, ECG reference beats for the real recording. |
| `ref_rppg.py` | POS (Wang et al., 2017) as the paper's Algorithm 1 in NumPy, pyVHR's `cpu_POS`, and rPPG-Toolbox's `POS_WANG` with its FFT heart rate, over synthetic camera skin colour with known beats. |
| `octave/` | `run_detectors.m`, the batch driver `ref_cardiac.py` calls, and a `downsample.m` shim for Octave. The toolbox files themselves are downloaded, not committed. |
| `fixtures/_inputs.json` | The signals, serialised. **Generated, do not hand-edit.** |
| `fixtures/<family>.json` | Reference values, one file per method family. |
| `harness.ts` | Fixture loading, packet building, and small reference-side helpers. |
| `allclose.ts` | `toBeAllClose`, a `numpy.allclose`-style Jest matcher. |
| `*.test.ts` | The golden tests. Picked up by the normal `npm test`. |

## Running the tests

Nothing special — the fixtures are committed:

```bash
npm test            # everything
npm run golden      # just this suite, one line per case
```

## Regenerating the fixtures

Only needed when a signal changes, a method's reference call changes, or you
bump the Python libraries.

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r tests/unit/golden/requirements.txt
python tests/unit/golden/generate.py
```

To rebuild one family only, name it — `python tests/unit/golden/generate.py
filter` (or `spectral`, `stats`, `cardiac`, `rppg`, `rms`). That also needs only that
family's libraries (the filter fixtures need just NumPy and SciPy, not YASA or
NeuroKit2) and leaves `_inputs.json` alone.

The `cardiac` group also needs **GNU Octave** 7 or later on `PATH`
(`brew install octave`; tested with 11.3) and network access the first time.
`ref_cardiac.py` downloads the ppg-beats reference detectors at a pinned
commit, and `inputs.py` downloads NeuroKit2's real recording at a pinned commit.
Both go into `.cache/` (git-ignored) and are hash-checked. The detectors are
not committed because qppgfast is BSD-3/GPL-2 and its helpers are GPL-3.
Because `inputs.py` reads the recording, every run needs it once.

The `rppg` group also needs network access the first time. `ref_rppg.py`
downloads pyVHR's `methods.py` and three rPPG-Toolbox files at pinned commits
into `.cache/`, hash-checked, and runs only the named functions from them (the
modules import cupy, torch and OpenCV at top level, which the references do not
need). They are not committed: pyVHR is GPL-3, and rPPG-Toolbox is under the
Responsible AI License.

Then review the JSON diff and commit it. Each fixture records the exact
library versions it was produced with under `generatedBy`. Generation is
deterministic: two runs produce byte-identical fixtures.

## Adding a method

1. Pick the reference call and its exact parameters (NumPy / SciPy, or a
   field-standard pipeline such as YASA or NeuroKit2) and write down the
   convention it fixes: scaling, `ddof`, one- vs two-sided, window, detrend
   default. Put it in the method's doc comment and the reference's comment.
2. Add or reuse a signal in `inputs.py`. Give it its own seeded generator so
   existing signals don't change.
3. Compute the reference in the matching `ref_*.py` (or a new one) and
   register the fixture in `generate.py`.
4. Regenerate and commit the fixture.
5. Add `<method>.test.ts` using `harness.ts` (`fixture`, `inputs`,
   `packetFor`): `describe.each` over the cases, with one tolerance per
   assertion and a comment saying *why* that value.
6. Start the tolerance loose (`rtol 1e-3`), then tighten. If it won't tighten,
   you've found a convention mismatch. Document it rather than widening the
   tolerance to hide it. If it is a real gap, record it in the spec's Open
   Gaps list with the next D-number, and either fix it or leave the test out
   until it is fixed.

## Tolerance notes

- **Pure `methods/` functions** operate in float64. Against NumPy the only
  difference is summation order; `rtol` around `1e-11` is realistic.
- **Analyzer classes** receive a `Float32Array` and emit one. The reference is
  computed over float32-rounded input and the comparison can assert about six
  significant digits (`rtol 1e-6`), no more.
- The package's radix-2 FFT against SciPy's pocketfft: the periodogram agrees
  to within 6e-8 of the peak bin, which is float32 rounding of the output, so
  spectral tests use `rtol 1e-5` with an absolute floor relative to the peak.
  (`tests/unit/fft.test.ts` checks the transform itself against a direct DFT at
  every power-of-two length.)
- IIR filters recurse in float32 (`lfilter` stores y in a `Float32Array`).
  Filter tests bound the error relative to output RMS instead of using `rtol`
  per sample.
- Field-standard comparisons (YASA, ground truth) are not float tolerances.
  Each bar is justified in a comment next to the assertion.

## Requirements

- **Node / Jest**: already covered by the repo's `devDependencies`; the tests
  run under the existing `jest.config.ts`.
- **Python** (regeneration only): 3.12, `numpy` 2.1, `scipy` 1.14,
  `neurokit2` 0.2.13, `yasa` 0.7.0, pinned in
  `requirements.txt`. YASA pulls in MNE. Nothing calls MNE directly, because
  YASA's `bandpower` is the EEG reference. The fixtures record the versions
  that actually made them (`generatedBy`). Regenerate a group with those
  versions so its diff shows only what you changed.
- **GNU Octave** (cardiac regeneration only): 7 or later, for `jsondecode`.
- NumPy/SciPy pins are compatible-release (`~=`). NeuroKit2 and YASA are
  pinned exactly, because their algorithms (peak detection, Welch defaults)
  feed fixture values directly.

## References

Where each reference is used is noted in the matching `ref_*.py` and test.

**Libraries used as references**

- Virtanen, P. et al. (2020). SciPy 1.0: fundamental algorithms for scientific
  computing in Python. *Nat Methods* 17:261–272.
  doi:10.1038/s41592-019-0686-2. Used for the conformance references:
  periodogram, windows, `butter`, `lfilter`, `sosfilt`, `filtfilt`,
  `pearsonr`, `detrend`.
- Vallat, R. & Walker, M.P. (2021). An open-source, high-performance tool for
  automated sleep staging. *eLife* 10:e70092. doi:10.7554/eLife.70092. YASA's
  `bandpower` (Welch PSD + Simpson integration) is the EEG band-power
  reference.
- Makowski, D. et al. (2021). NeuroKit2: A Python toolbox for
  neurophysiological signal processing. *Behav Res Methods* 53:1689–1696.
  doi:10.3758/s13428-020-01516-y. Used for `hrv_time` (HRV definitions) and
  `ppg_process` (the reference PPG pipeline).

**Spectral estimation**

- Harris, F.J. (1978). On the use of windows for harmonic analysis with the
  discrete Fourier transform. *Proc IEEE* 66(1):51–83.
  doi:10.1109/PROC.1978.10837. Symmetric vs periodic windows (C1).
- Heinzel, G., Rüdiger, A. & Schilling, R. (2002). *Spectrum and spectral
  density estimation by the Discrete Fourier transform (DFT), including a
  comprehensive list of window functions and some new flat-top windows.*
  Max-Planck-Institut für Gravitationsphysik.
  https://holometer.fnal.gov/GH_FFT.pdf. Amplitude vs density normalisation
  (D3, D4).
- Welch, P. (1967). The use of fast Fourier transform for the estimation of
  power spectra. *IEEE Trans Audio Electroacoust* 15(2):70–73.
  doi:10.1109/TAU.1967.1161901.

**Filtering**

- Butterworth, S. (1930). On the theory of filter amplifiers. *Wireless
  Engineer* 7:536–541. The maximally flat response `butter` realises; SciPy's
  `buttap` → `lp2*_zpk` → `bilinear_zpk` → `zpk2sos` is the design path ported
  (D1, closed).
- Harris, F.J. (1978). On the use of windows for harmonic analysis with the
  discrete Fourier transform. *Proc IEEE* 66:51–83. doi:10.1109/PROC.1978.10837.
  The window catalogue behind `firwin`'s `window` option.
- Kaiser, J.F. (1974). Nonrecursive digital filter design using the I0-sinh
  window function. *Proc IEEE Int Symp Circuits Syst*, 20–23. `kaiserord`.
- Bristow-Johnson, R. *Audio EQ Cookbook.* W3C Working Group Note.
  https://www.w3.org/TR/audio-eq-cookbook/. The biquad formulas
  `designBiquad` uses; it is not a SciPy design and nothing golden-tested
  depends on it.
- Gustafsson, F. (1996). Determining the initial states in forward-backward
  filtering. *IEEE Trans Signal Process* 44:988–992. Steady-state initial
  conditions for `filtfilt` (D6).
- Widmann, A., Schröger, E. & Maess, B. (2015). Digital filter design for
  electrophysiological data – a practical approach. *J Neurosci Methods*
  250:34–46. doi:10.1016/j.jneumeth.2014.08.002.

**Cardiac**

- Task Force of the ESC and NASPE (1996). Heart rate variability: standards of
  measurement, physiological interpretation and clinical use. *Circulation*
  93(5):1043–1065. doi:10.1161/01.CIR.93.5.1043. SDNN and RMSSD on
  normal-to-normal intervals (D7).
- Shin, H.S., Lee, C. & Lee, M. (2009). Adaptive threshold method for the peak
  detection of photoplethysmographic waveform. *Comput Biol Med*
  39(12):1145–1152. doi:10.1016/j.compbiomed.2009.10.006. The package's
  previous detector, still `detector: "adaptive-threshold"`; "ATM" in
  Charlton et al. (2022).
- Bishop, S.M. & Ercole, A. (2018). Multi-scale peak and trough detection
  optimised for periodic and quasi-periodic neuroscience data. *Acta
  Neurochir Suppl* 126:189–195. doi:10.1007/978-3-319-65798-1_39. MSPTD.
- Charlton, P.H., Mant, J. & Kyriacou, P.A. (2025). The MSPTDfast
  photoplethysmography beat detection algorithm: design, benchmarking, and
  open-source distribution. *Physiol Meas* 46:035002.
  doi:10.1088/1361-6579/adb89e. The package's detector, ported from
  `msptdfastv2_beat_detector.m` (ppg-beats, MIT) and checked against it
  sample for sample.
- Vest, A.N. et al. (2018). An open source benchmarked toolbox for
  cardiovascular waveform and interval analysis. *Physiol Meas*
  39(10):105004. doi:10.1088/1361-6579/aae021. `qppg_fast`, the source of
  ppg-beats' qppgfast; after Zong, W. et al. (2003), An open-source algorithm
  to detect onset of arterial blood pressure pulses, *Comput Cardiol*
  30:259–262, doi:10.1109/CIC.2003.1291140.
- Elgendi, M. et al. (2013). Systolic peak detection in acceleration
  photoplethysmograms measured from emergency responders in tropical
  conditions. *PLoS ONE* 8(10):e76585. doi:10.1371/journal.pone.0076585.
  NeuroKit2's default PPG detector.
- Charlton, P.H. et al. (2022). Detecting beats in the photoplethysmogram:
  benchmarking open-source algorithms. *Physiol Meas* 43(8):085007.
  doi:10.1088/1361-6579/ac826d. How the detector was chosen (MSPTD and qppg
  best of fifteen), beat-detection scoring (±150 ms, F1, ECG-PPG lag
  alignment) and the 10% heart-rate error bar.
- Lipponen, J.A. & Tarvainen, M.P. (2019). A robust algorithm for heart rate
  variability time series artefact correction using novel beat
  classification. *J Med Eng Technol.* NN-interval cleaning, the usual
  remedy for the false beats behind D7 (closed by switching detector).
- Tang, Q. et al. (2020). Synthetic photoplethysmogram generation using two
  Gaussian functions. *Sci Rep* 10:13883. doi:10.1038/s41598-020-69076-x.
  The pulse model for the synthetic PPG in `inputs.py`.

**Camera pulse (rPPG)**

- Wang, W., den Brinker, A.C., Stuijk, S. & de Haan, G. (2017). Algorithmic
  principles of remote PPG. *IEEE Trans Biomed Eng* 64(7):1479–1491.
  doi:10.1109/TBME.2016.2609282. POS; Algorithm 1 is the definition reference.
- de Haan, G. & van Leest, A. (2014). Improved motion robustness of remote-PPG
  by using the blood volume pulse signature. *Physiol Meas* 35(9):1913–1926.
  doi:10.1088/0967-3334/35/9/1913. The per-channel pulse strengths of the
  synthetic skin colour in `inputs.py`.
- Verkruysse, W., Svaasand, L.O. & Nelson, J.S. (2008). Remote
  plethysmographic imaging using ambient light. *Opt Express*
  16(26):21434–21445. doi:10.1364/OE.16.021434. The green-channel baseline.
- Boccignone, G. et al. (2022). pyVHR: a Python framework for remote
  photoplethysmography. *PeerJ Comput Sci* 8:e929. doi:10.7717/peerj-cs.929.
  `cpu_POS`.
- Liu, X. et al. (2023). rPPG-Toolbox: Deep Remote PPG Toolbox. *NeurIPS
  Datasets and Benchmarks*. arXiv:2210.00716. `POS_WANG` and
  `_calculate_fft_hr`.

**Other**

- AES17-2020. *AES standard method for digital audio engineering —
  Measurement of digital audio equipment.* Audio Engineering Society. The
  dBFS definition (C3).
- Burgess, A.P. (2013). On the interpretation of synchronization in EEG
  hyperscanning studies: a cautionary note. *Front Hum Neurosci* 7:881.
  doi:10.3389/fnhum.2013.00881. Context for `Correlation` as a synchrony
  measure: Pearson r on raw signals is not a hyperscanning connectivity
  measure.
