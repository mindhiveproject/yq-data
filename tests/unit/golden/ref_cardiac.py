"""References for src/analyzer/methods/peaks.ts and the HeartRate node.

Four layers:

* **Definitions** -- given a fixed list of beats, SDNN, RMSSD and the median
  rate are closed-form (Task Force of the ESC/NASPE, 1996, Circulation
  93:1043). NeuroKit2's ``hrv_time`` (Makowski et al., 2021, Behav Res Methods
  53:1689) is the reference implementation; the package should match exactly.
* **Reference detectors** -- the two detectors Charlton et al. (2022, Physiol
  Meas 43:085007) found best among fifteen open-source PPG beat detectors, run
  from the authors' own MATLAB (ppg-beats toolbox) under GNU Octave:
  MSPTDfast v2 (Charlton et al., 2025, Physiol Meas 46:035002), the efficient
  MSPTD the package ports, and qppgfast (Vest et al., 2018, Physiol Meas
  39:105004; after Zong et al., 2003). Also NeuroKit2's own Python port of
  MSPTDfast v2 (``ppg_findpeaks(method="charlton")``).
* **Ground truth** -- the synthetic PPG signals in inputs.py record where each
  systolic peak actually is. The real recording is labelled from the ECG
  recorded alongside it, as Charlton et al. label their benchmark datasets.
  Detection is scored their way: a detection within 150 ms of a reference
  beat is a true positive; sensitivity, PPV, F1.
* **Reference pipeline** -- NeuroKit2's default PPG pipeline (``ppg_process``:
  Elgendi et al., 2013 cleaning and systolic-peak detection,
  doi:10.1371/journal.pone.0076585), run on the whole signal, for context.

The reference detectors see the same input as the package: each 10 s window
preprocessed exactly as the HeartRate node does it (degree-6 detrend, then a
zero-phase order-2 Butterworth band-pass over [40, 200] bpm, each step
rounded to float32 as the package stores it). MSPTDfast is also run on the
raw window, where the package's port must reproduce it index-for-index.

Needs GNU Octave (7 or later, for jsondecode) on PATH. The toolbox files are
downloaded at a pinned commit into .cache/ and hash-checked; they are not
redistributed here (qppgfast is BSD-3/GPL-2, the helpers GPL-3).
"""

import json
import shutil
import subprocess
import tempfile
from pathlib import Path

import numpy as np
import neurokit2 as nk
from scipy import signal as sps

from inputs import CACHE, bio_resting, fetch
from ref_common import as_float32

PPG_SIGNALS = [
    "ppg_muse_60bpm",
    "ppg_muse_75bpm_offset",
    "ppg_muse_110bpm_noisy",
    "rppg_camera_72bpm",
    "ppg_real_rest_100hz",
    "ppg_real_rest_64hz",
]
REAL = {"ppg_real_rest_100hz", "ppg_real_rest_64hz"}

WINDOW_SECONDS = 10.0
# Charlton et al. (2022) count a PPG beat as correct within 150 ms of the
# reference beat.
MATCH_TOLERANCE_S = 0.15
# HeartRate defaults.
MIN_RATE, MAX_RATE, DETREND_DEGREE, BAND_ORDER = 40.0, 200.0, 6, 2
# A window is left out of the real-signal scoring when the ECG reference
# itself is doubtful: an R-R interval more than 30% off the record's median is
# a missed or spurious R peak (checked by eye against the PPG on this record).
ECG_RR_TOLERANCE = 0.3

PPG_BEATS_COMMIT = "c397be7afc0d8a1601a85cd673718372e40f1f59"
PPG_BEATS_FILES = {
    "msptdfastv2_beat_detector.m": "39f5010f1d485f2dc180bffbbe662dc9bd16e8116bd1ae630761f1e2b58bcabd",
    "qppgfast_beat_detector.m": "73148a852451a7a1b993c7fb69796b74842226b8ebc94fe7e2a1b6763a76471f",
    "tidy_beats.m": "600955a9979ffb50bf48f70030a6e395fafe1d983a2ab74b1a79931848e358b6",
    "pulse_peaks_from_onsets.m": "432865f1777058c235a7d2be8c7ee3e026419ab8fa19843217043bb728d0c165",
}
OCTAVE_DIR = Path(__file__).parent / "octave"


def median_rate(beats, fs, lo=MIN_RATE, hi=MAX_RATE):
    """rateFromPeaks: median of the instantaneous rates inside [lo, hi] bpm."""
    if len(beats) < 2:
        return 0.0
    bpm = 60.0 / (np.diff(beats) / fs)
    bpm = bpm[(bpm >= lo) & (bpm <= hi)]
    return float(np.median(bpm)) if len(bpm) else 0.0


def package_pulse(x, fs):
    """The HeartRate node's preprocessing, step for step.

    detrend(x, 6, fs): t is a Float32Array of i * (1 / fs); the residual is
    stored as float32. sosfiltfilt over butter(2, [40, 200] bpm) in float64,
    stored as float32.
    """
    x = as_float32(x)
    t = as_float32(np.arange(len(x)) * (1.0 / fs))
    fit = np.polynomial.Polynomial.fit(t, x, DETREND_DEGREE)
    detrended = as_float32(x - fit(t))
    hi = min(MAX_RATE / 60.0, fs / 2 - 0.01)
    sos = sps.butter(BAND_ORDER, [MIN_RATE / 60.0, hi], btype="bandpass", fs=fs, output="sos")
    return as_float32(sps.sosfiltfilt(sos, detrended))


def ppg_beats_dir():
    """The toolbox's reference detectors at the pinned commit, hash-checked."""
    folder = CACHE / f"ppg-beats-{PPG_BEATS_COMMIT[:12]}"
    for name, sha in PPG_BEATS_FILES.items():
        url = f"https://raw.githubusercontent.com/peterhcharlton/ppg-beats/{PPG_BEATS_COMMIT}/source/{name}"
        path = fetch(url, sha, f"ppg-beats-{PPG_BEATS_COMMIT[:12]}-{name}")
        folder.mkdir(exist_ok=True)
        shutil.copyfile(path, folder / name)
    return folder


def run_octave(batch):
    """MSPTDfast v2 and qppgfast over each {"fs", "x"}; 0-based indices back."""
    if shutil.which("octave") is None:
        raise RuntimeError("the cardiac fixtures need GNU Octave on PATH (brew install octave)")
    toolbox = ppg_beats_dir()
    with tempfile.TemporaryDirectory() as tmp:
        src, dst = Path(tmp) / "in.json", Path(tmp) / "out.json"
        src.write_text(json.dumps({"cases": [{"fs": c["fs"], "x": list(map(float, c["x"]))} for c in batch]}))
        script = f"addpath('{OCTAVE_DIR}'); addpath('{toolbox}'); run_detectors('{src}', '{dst}');"
        subprocess.run(["octave", "--no-gui", "--quiet", "--eval", script], check=True)
        out = json.loads(dst.read_text())

    def zero_based(v):
        return [int(i) - 1 for i in np.atleast_1d(v if v is not None else []).ravel()]

    return [{k: zero_based(o[k]) for k in o} for o in out]


def neurokit_msptdfast(pulse, fs):
    """NeuroKit2's Python port of MSPTDfast v2, on the same pulse."""
    try:
        return np.asarray(nk.ppg_findpeaks(pulse, sampling_rate=int(fs), method="charlton")["PPG_Peaks"], int)
    except (ValueError, IndexError) as error:
        # Its refinement slices win_sig[p - tol:p + tol + 1] and fails when
        # that runs off the window.
        return {"error": str(error)}


def ecg_reference(fs):
    """R peaks of the ECG recorded with the real PPG, as indices at ``fs``."""
    ecg = bio_resting()["ECG"]
    _, info = nk.ecg_peaks(nk.ecg_clean(ecg, sampling_rate=100), sampling_rate=100)
    r100 = np.asarray(info["ECG_R_Peaks"], int)
    rr = np.diff(r100)
    bad = np.abs(rr / np.median(rr) - 1) > ECG_RR_TOLERANCE
    doubtful = sorted(set(r100[:-1][bad]) | set(r100[1:][bad]))
    to_fs = lambda idx: np.round(np.asarray(idx) * fs / 100.0).astype(int)  # noqa: E731
    return to_fs(r100), to_fs(doubtful), {
        "call": "neurokit2.ecg_peaks(neurokit2.ecg_clean(ecg, sampling_rate=100), sampling_rate=100)",
        "doubtfulRR": int(bad.sum()),
    }


def build_cardiac(signals):
    cases, batch, slots = [], [], []
    for name in PPG_SIGNALS:
        sig = signals[name]
        fs = sig["fs"]
        x = as_float32(sig["channels"][0])
        real = name in REAL

        if real:
            truth, doubtful, ecg_info = ecg_reference(fs)
        else:
            truth = np.array(sig["truth"]["beats"], dtype=int)

        _, info = nk.ppg_process(x, sampling_rate=int(fs))
        nk_peaks = np.asarray(info["PPG_Peaks"], dtype=int)

        win = int(round(WINDOW_SECONDS * fs))
        windows = []
        for start in range(0, len(x) - win + 1, win):
            stop = start + win
            raw = x[start:stop]
            pulse = package_pulse(raw, fs)
            t_in = truth[(truth >= start) & (truth < stop)] - start
            w = {
                "start": start,
                "stop": stop,
                "truthMedianRate": median_rate(t_in, fs),
                "truthMeanRate": float(60.0 / (np.diff(t_in).mean() / fs)),
                "references": {"neurokitMsptdfast": neurokit_msptdfast(pulse, fs)},
            }
            if real:
                w["excluded"] = bool(np.any((doubtful >= start) & (doubtful < stop)))
            else:
                w["truthBeats"] = t_in.tolist()
            nkm = w["references"]["neurokitMsptdfast"]
            if not isinstance(nkm, dict):
                w["references"]["neurokitMsptdfast"] = nkm.tolist()
            windows.append(w)
            for kind, data in (("raw", raw), ("pulse", pulse)):
                batch.append({"fs": fs, "x": data})
                slots.append((w, kind))

        case = {
            "signal": name,
            "samplingRate": fs,
            "real": real,
            "neurokit": {
                "call": f"neurokit2.ppg_process(x, sampling_rate={int(fs)})  # elgendi clean + peaks",
                "peaks": nk_peaks.tolist(),
            },
            "windows": windows,
        }
        if real:
            case["ecgBeats"] = truth.tolist()
            case["ecg"] = ecg_info
        else:
            hrv = nk.hrv_time(truth, sampling_rate=int(fs))
            case["truthBeats"] = truth.tolist()
            case["truthRate"] = sig["truth"]["hr"]
            case["definitions"] = {
                "medianRate": median_rate(truth, fs),
                "sdnnMs": float(hrv["HRV_SDNN"].iloc[0]),
                "rmssdMs": float(hrv["HRV_RMSSD"].iloc[0]),
            }
        cases.append(case)

    for (w, kind), out in zip(slots, run_octave(batch)):
        if kind == "raw":
            w["references"]["msptdfastRaw"] = out["msptdfastv2_peaks"]
        else:
            w["references"]["msptdfast"] = out["msptdfastv2_peaks"]
            w["references"]["msptdfastOnsets"] = out["msptdfastv2_onsets"]
            w["references"]["qppgfast"] = out["qppgfast_peaks"]

    return {
        "reference": {
            "definitions": "neurokit2.hrv_time(truth_peaks, sampling_rate) -> HRV_SDNN (ddof=1), HRV_RMSSD; median rate = median(60/IBI) within [40, 200] bpm",
            "detectors": (
                f"ppg-beats @ {PPG_BEATS_COMMIT[:12]} under GNU Octave: msptdfastv2_beat_detector(x, fs), "
                "qppgfast_beat_detector(x, fs); neurokit2.ppg_findpeaks(x, fs, method='charlton')"
            ),
            "input": "per 10 s window: raw (msptdfastRaw) and the HeartRate node's preprocessing (all others)",
            "groundTruth": "synthetic: systolic maxima of the noise-free waveform (inputs.py _ppg); real: ECG R peaks",
            "pipeline": "neurokit2.ppg_process default (Elgendi 2013), whole signal",
        },
        "octave": subprocess.run(["octave", "--version"], capture_output=True, text=True).stdout.splitlines()[0],
        "windowSeconds": WINDOW_SECONDS,
        "matchToleranceSeconds": MATCH_TOLERANCE_S,
        "cases": cases,
    }
