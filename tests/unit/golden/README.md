# Golden-value suite

Checks that the package's DSP produces the **same numbers** as the reference
libraries the field already trusts, and says so precisely where it does not.

- **Conformance** references are NumPy / SciPy called with exactly the
  convention the package documents. These must match to float precision.
- **Field-standard** references are the pipelines researchers actually use:
  YASA for EEG band power and NeuroKit2 for PPG beats and HRV. Synthetic
  signals carry their own **ground truth** (true beat locations, true rate).
  These are judged against stated, justified tolerances.

**Results** live in two places. The tests are the live record: every known gap
is a `divergence(...)` test, and `GOLDEN_STRICT=1` prints its current size.
The to-do list of divergences (D1–D10) and the documented conventions
(C1–C6) is in the *Open Gaps* section of the package spec in Notion, under
*Golden-value divergences*. The literature and libraries the references come
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
| `ref_filter.py` | Butterworth responses, `lfilter`, streaming `sosfilt`, `filtfilt`. |
| `ref_cardiac.py` | HRV definitions (NeuroKit2), ground-truth beats, NeuroKit2 PPG pipeline. |
| `fixtures/_inputs.json` | The signals, serialised. **Generated, do not hand-edit.** |
| `fixtures/<family>.json` | Reference values, one file per method family. |
| `harness.ts` | Fixture loading, packet building, `divergence`, `recorder`. |
| `allclose.ts` | `toBeAllClose`, a `numpy.allclose`-style Jest matcher. |
| `*.test.ts` | The golden tests. Picked up by the normal `npm test`. |
| `report.py` | Builds `report/index.html`, the visual comparison (optional). |

## Divergence tests

Where the package is known to differ from the reference, the test asserts the
**reference** behaviour and is registered with `divergence(...)`, which is
`it.failing`. The suite stays green while the gap exists. When someone closes
the gap, Jest reports "failing test passed". Remove the marker and tick the
item off the spec's Open Gaps list. Every such test names its divergence ID
(D1–D10) in a comment, and pinned conventions name theirs (C1–C6).

To see the measured gaps as ordinary failures:

```bash
GOLDEN_STRICT=1 npx jest tests/unit/golden
```

## Comparison report

```bash
GOLDEN_REPORT=1 npx jest tests/unit/golden   # records package outputs to report/measured/
python tests/unit/golden/report.py           # writes report/index.html
```

`report/` is git-ignored. The report needs only the Python standard library.

## Running the tests

Nothing special — the fixtures are committed:

```bash
npm test
```

## Regenerating the fixtures

Only needed when a signal changes, a method's reference call changes, or you
bump the Python libraries.

With conda (see the note below):

```bash
conda env create -f tests/unit/golden/environment.yml   # first time only
conda activate yq-golden
python tests/unit/golden/generate.py
```

With a plain virtualenv:

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r tests/unit/golden/requirements.txt
python tests/unit/golden/generate.py
```

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
   tolerance to hide it. If it is a real gap, write the reference assertion
   as a `divergence(...)` test, give it the next D-number in a comment and
   add it to the spec's Open Gaps list.

## Tolerance notes

- **Pure `methods/` functions** operate in float64. Against NumPy the only
  difference is summation order; `rtol` around `1e-11` is realistic.
- **Analyzer classes** receive a `Float32Array` and emit one. The reference is
  computed over float32-rounded input and the comparison can assert about six
  significant digits (`rtol 1e-6`), no more.
- mathjs's FFT against SciPy's pocketfft: the periodogram agrees to ~3e-8 of
  the peak bin, so spectral tests use `rtol 1e-5` with an absolute floor
  relative to the peak.
- IIR filters recurse in float32 (`lfilter` stores y in a `Float32Array`).
  Filter tests bound the error relative to output RMS instead of using `rtol`
  per sample.
- Field-standard comparisons (YASA, ground truth) are not float tolerances.
  Each bar is justified in a comment next to the assertion.

## Requirements

- **Node / Jest**: already covered by the repo's `devDependencies`; the tests
  run under the existing `jest.config.ts`.
- **Python** (regeneration only): 3.12, `numpy` 2.1, `scipy` 1.14,
  `neurokit2` 0.2.13, `yasa` 0.7.0, pinned in `environment.yml` and
  `requirements.txt`. YASA pulls in MNE. Nothing calls MNE directly, because
  YASA's `bandpower` is the EEG reference.
- NumPy/SciPy pins are compatible-release (`~=`). NeuroKit2 and YASA are
  pinned exactly, because their algorithms (peak detection, Welch defaults)
  feed fixture values directly.
- You can manage the Python side with conda (`environment.yml` creates the
  `yq-golden` env) or any virtualenv tool.

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

- Bristow-Johnson, R. *Audio EQ Cookbook.* W3C Working Group Note.
  https://www.w3.org/TR/audio-eq-cookbook/. The biquad formulas
  `designBiquad` uses (D1).
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
  detector.
- Elgendi, M. et al. (2013). Systolic peak detection in acceleration
  photoplethysmograms measured from emergency responders in tropical
  conditions. *PLoS ONE* 8(10):e76585. doi:10.1371/journal.pone.0076585.
  NeuroKit2's default PPG detector.
- Charlton, P.H. et al. (2022). Detecting beats in the photoplethysmogram:
  benchmarking open-source algorithms. *Physiol Meas* 43(8):085007.
  doi:10.1088/1361-6579/ac826d. Beat-detection scoring (±150 ms, F1).
- Lipponen, J.A. & Tarvainen, M.P. (2019). A robust algorithm for heart rate
  variability time series artefact correction using novel beat
  classification. *J Med Eng Technol.* NN-interval cleaning (D7).
- Tang, Q. et al. (2020). Synthetic photoplethysmogram generation using two
  Gaussian functions. *Sci Rep* 10:13883. doi:10.1038/s41598-020-69076-x.
  The pulse model for the synthetic PPG in `inputs.py`.

**Other**

- AES17-2020. *AES standard method for digital audio engineering —
  Measurement of digital audio equipment.* Audio Engineering Society. The
  dBFS definition (C3).
- Burgess, A.P. (2013). On the interpretation of synchronization in EEG
  hyperscanning studies: a cautionary note. *Front Hum Neurosci* 7:881.
  doi:10.3389/fnhum.2013.00881. Context for `Correlation` as a synchrony
  measure: Pearson r on raw signals is not a hyperscanning connectivity
  measure.
