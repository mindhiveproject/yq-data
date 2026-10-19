"""References for src/analyzer/methods/peaks.ts and the HeartRate node.

Three layers:

* **Definitions** -- given a fixed list of beats, SDNN, RMSSD and the median
  rate are closed-form (Task Force of the ESC/NASPE, 1996, Circulation
  93:1043). NeuroKit2's ``hrv_time`` (Makowski et al., 2021, Behav Res Methods
  53:1689) is the reference implementation; the package should match exactly.
* **Ground truth** -- the synthetic PPG signals in inputs.py record where each
  systolic peak actually is. Detection is scored the way Charlton et al. (2022,
  Physiol Meas 43:085007) benchmark PPG beat detectors: a detection within a
  tolerance window of a true beat is a true positive; sensitivity, PPV, F1.
* **Reference pipeline** -- NeuroKit2's default PPG pipeline (``ppg_process``:
  Elgendi et al., 2013 cleaning and systolic-peak detection,
  doi:10.1371/journal.pone.0076585), run on the same signals, to show where
  an established open-source pipeline lands on identical input.
"""

import numpy as np
import neurokit2 as nk

from ref_common import as_float32, floats

PPG_SIGNALS = [
    "ppg_muse_60bpm",
    "ppg_muse_75bpm_offset",
    "ppg_muse_110bpm_noisy",
    "rppg_camera_72bpm",
]

WINDOW_SECONDS = 10.0
# Charlton et al. (2022) score PPG beats against ECG-derived references with a
# tolerance window; 150 ms is used here.
MATCH_TOLERANCE_S = 0.15


def median_rate(beats, fs, lo=40.0, hi=200.0):
    """rateFromPeaks: median of the instantaneous rates inside [lo, hi] bpm."""
    if len(beats) < 2:
        return 0.0
    bpm = 60.0 / (np.diff(beats) / fs)
    bpm = bpm[(bpm >= lo) & (bpm <= hi)]
    return float(np.median(bpm)) if len(bpm) else 0.0


def build_cardiac(signals):
    cases = []
    for name in PPG_SIGNALS:
        sig = signals[name]
        fs = sig["fs"]
        truth = np.array(sig["truth"]["beats"], dtype=int)
        x = as_float32(sig["channels"][0])

        hrv = nk.hrv_time(truth, sampling_rate=int(fs))

        _, info = nk.ppg_process(x, sampling_rate=int(fs))
        nk_peaks = np.asarray(info["PPG_Peaks"], dtype=int)

        win = int(round(WINDOW_SECONDS * fs))
        windows = []
        for start in range(0, len(x) - win + 1, win):
            stop = start + win
            t_in = truth[(truth >= start) & (truth < stop)] - start
            n_in = nk_peaks[(nk_peaks >= start) & (nk_peaks < stop)] - start
            windows.append(
                {
                    "start": start,
                    "stop": stop,
                    "truthBeats": t_in.tolist(),
                    "truthMedianRate": median_rate(t_in, fs),
                    "truthMeanRate": float(60.0 / (np.diff(t_in).mean() / fs)),
                    "neurokitMedianRate": median_rate(n_in, fs),
                }
            )

        cases.append(
            {
                "signal": name,
                "samplingRate": fs,
                "truthBeats": truth.tolist(),
                "truthRate": sig["truth"]["hr"],
                "definitions": {
                    "medianRate": median_rate(truth, fs),
                    "sdnnMs": float(hrv["HRV_SDNN"].iloc[0]),
                    "rmssdMs": float(hrv["HRV_RMSSD"].iloc[0]),
                },
                "neurokit": {
                    "call": f"neurokit2.ppg_process(x, sampling_rate={int(fs)})  # elgendi clean + peaks",
                    "peaks": nk_peaks.tolist(),
                },
                "windows": windows,
            }
        )

    return {
        "reference": {
            "definitions": "neurokit2.hrv_time(truth_peaks, sampling_rate) -> HRV_SDNN (ddof=1), HRV_RMSSD; median rate = median(60/IBI) within [40, 200] bpm",
            "groundTruth": "systolic maxima of the noise-free synthetic waveform (inputs.py _ppg)",
            "pipeline": "neurokit2.ppg_process default (Elgendi 2013)",
        },
        "windowSeconds": WINDOW_SECONDS,
        "matchToleranceSeconds": MATCH_TOLERANCE_S,
        "cases": cases,
    }
