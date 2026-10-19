"""References for src/analyzer/methods/stats.ts and the window functions.

Every value here is a direct NumPy / SciPy call; the convention each call fixes
is written next to it.
"""

import numpy as np
import scipy.signal as signal
import scipy.stats as stats
from numpy.polynomial import Polynomial
from numpy.polynomial import polynomial as P

from ref_common import as_float32, floats

DESCRIPTIVE_SIGNALS = [
    "sine_10hz_unit",
    "dc_offset",
    "white_noise_unit",
    "two_tone_offset",
    "stereo_tones",
    "eeg_muse_4s",
    "eeg_dc_drift_30s",
    "ppg_muse_75bpm_offset",
]

# Signals small enough to carry whole output arrays for the normalizers.
ARRAY_SIGNALS = ["sine_10hz_unit", "two_tone_offset", "eeg_openbci_2s", "stereo_tones"]


def build_stats(signals):
    descriptive = []
    for name in DESCRIPTIVE_SIGNALS:
        sig = signals[name]
        chans = [np.asarray(c, np.float64) for c in sig["channels"]]
        descriptive.append(
            {
                "signal": name,
                # float64 references for the pure functions...
                "mean": [float(np.mean(c)) for c in chans],
                "varPopulation": [float(np.var(c, ddof=0)) for c in chans],
                "varSample": [float(np.var(c, ddof=1)) for c in chans],
                "stdPopulation": [float(np.std(c, ddof=0)) for c in chans],
                "stdSample": [float(np.std(c, ddof=1)) for c in chans],
                "min": [float(np.min(c)) for c in chans],
                "max": [float(np.max(c)) for c in chans],
                "median": [float(np.median(c)) for c in chans],
                # ...and float32-input references for StatisticalFeatures.
                "fromFloat32": {
                    "mean": [float(np.mean(as_float32(c))) for c in chans],
                    "std": [float(np.std(as_float32(c), ddof=0)) for c in chans],
                    "rms": [float(np.sqrt(np.mean(as_float32(c) ** 2))) for c in chans],
                    "min": [float(np.min(as_float32(c))) for c in chans],
                    "max": [float(np.max(as_float32(c))) for c in chans],
                },
            }
        )

    normalizers = []
    for name in ARRAY_SIGNALS:
        chans = [as_float32(c) for c in signals[name]["channels"]]
        normalizers.append(
            {
                "signal": name,
                # scipy.stats.zscore defaults to ddof=0 (population sd).
                "zscore": [floats(stats.zscore(c, ddof=0)) for c in chans],
                # (x - min) / (max - min): sklearn.preprocessing.minmax_scale.
                "minmax": [floats((c - c.min()) / (c.max() - c.min())) for c in chans],
            }
        )

    # Polynomial fit: numpy.polynomial.polynomial.polyfit (lstsq on a scaled
    # Vandermonde matrix), coefficients low order first -- the same order
    # stats.ts `polyfit` returns.
    polyfit_cases = []
    for name, degree in [("eeg_openbci_2s", 1), ("eeg_openbci_2s", 2), ("ppg_muse_60bpm", 3)]:
        sig = signals[name]
        y = np.asarray(sig["channels"][0], np.float64)
        t = np.arange(len(y)) / sig["fs"]
        polyfit_cases.append(
            {
                "signal": name,
                "degree": degree,
                "x": "seconds",
                "coefficients": floats(P.polyfit(t, y, degree)),
            }
        )

    # Detrending.
    #   degree 0 -> scipy.signal.detrend(type="constant")
    #   degree 1 -> scipy.signal.detrend(type="linear")
    #   degree 6 -> HeartRate's default baseline removal. Reference is
    #               numpy.polynomial.Polynomial.fit, which maps t onto [-1, 1]
    #               before a QR least-squares solve -- the numerically stable
    #               way to fit a degree-6 polynomial.
    detrend_cases = []
    for name, seconds in [
        ("eeg_openbci_2s", None),
        ("eeg_dc_drift_30s", None),
        ("ppg_muse_60bpm", 10.0),
        ("ppg_muse_75bpm_offset", 10.0),
        ("ppg_muse_75bpm_offset", None),
        ("rppg_camera_72bpm", 10.0),
    ]:
        sig = signals[name]
        fs = sig["fs"]
        x = as_float32(sig["channels"][0])
        if seconds is not None:
            x = x[: int(round(seconds * fs))]
        t = np.arange(len(x)) / fs
        case = {
            "signal": name,
            "samples": len(x),
            "constant": floats(signal.detrend(x, type="constant")),
            "linear": floats(signal.detrend(x, type="linear")),
        }
        if name.startswith(("ppg", "rppg")):
            fit = Polynomial.fit(t, x, 6)
            case["poly6"] = floats(x - fit(t))
        detrend_cases.append(case)

    # Pearson correlation: scipy.stats.pearsonr.
    a, b = signals["corr_a"]["channels"], signals["corr_b"]["channels"]
    matrix = [[float(stats.pearsonr(ai, bj).statistic) for bj in b] for ai in a]
    a_f32 = [as_float32(c) for c in a]
    b_f32 = [as_float32(c) for c in b]
    matrix_f32 = [[float(stats.pearsonr(ai, bj).statistic) for bj in b_f32] for ai in a_f32]

    # Unequal lengths: the Correlation node documents "computed over the
    # shorter of the two windows", so the reference is pearsonr on the overlap.
    long_a = [as_float32(c) for c in signals["corr_a_tail_shift"]["channels"]]
    short_b = [as_float32(c) for c in signals["corr_b_short"]["channels"]]
    n = min(len(long_a[0]), len(short_b[0]))
    overlap = [float(stats.pearsonr(x[:n], y[:n]).statistic) for x, y in zip(long_a, short_b)]

    correlation = {
        "a": "corr_a",
        "b": "corr_b",
        "matrix": matrix,
        "matrixFromFloat32": matrix_f32,
        "unequal": {
            "a": "corr_a_tail_shift",
            "b": "corr_b_short",
            "overlap": n,
            "paired": overlap,
        },
    }

    return {
        "reference": {
            "mean/var/std/min/max/median": "numpy (var/std: ddof=0 population, ddof=1 sample)",
            "zscore": "scipy.stats.zscore(ddof=0)",
            "minmax": "(x - min) / (max - min), as sklearn.preprocessing.minmax_scale",
            "polyfit": "numpy.polynomial.polynomial.polyfit, coefficients low order first, x in seconds",
            "detrend": "scipy.signal.detrend type=constant|linear; poly6 = numpy.polynomial.Polynomial.fit residual, t in seconds",
            "correlation": "scipy.stats.pearsonr",
        },
        "descriptive": descriptive,
        "normalizers": normalizers,
        "polyfit": polyfit_cases,
        "detrend": detrend_cases,
        "correlation": correlation,
    }


def build_windows():
    """scipy.signal.windows with sym=True (numpy.hamming etc. are identical).

    The periodic (``sym=False``, "DFT-even") form -- what scipy.signal.welch and
    MATLAB's spectral tools use by default, after Harris (1978) -- is recorded
    alongside for comparison; the package intentionally uses the symmetric one.
    """
    cases = []
    for kind in ("hamming", "hann", "blackman"):
        fn = getattr(signal.windows, kind)
        for n in (1, 2, 5, 64, 256, 500):
            w = fn(n, sym=True)
            cases.append(
                {
                    "type": kind,
                    "length": n,
                    "symmetric": floats(w),
                    "periodic": floats(fn(n, sym=False)),
                    "power": float(np.sum(w**2)),
                }
            )
    return {
        "reference": "scipy.signal.windows.<type>(N, sym=True); periodic = sym=False",
        "cases": cases,
    }
