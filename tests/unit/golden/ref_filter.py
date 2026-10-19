"""References for src/analyzer/methods/filter.ts and the Filtering node.

Design is checked by frequency response rather than coefficients: SciPy and
the package may order or pair second-order sections differently and still
realise the same filter, so |H(f)| is the quantity that must agree.

Filter-order convention: ``scipy.signal.butter(N, ...)`` for a band filter
returns an order-2N system. The package's ``order`` is the total order (two
biquads for ``order: 4``), so a package band filter of order K is compared
against ``butter(K // 2, ...)`` -- the same number of poles.
"""

import numpy as np
import scipy.signal as signal

from ref_common import as_float32, floats


DESIGNS = [
    # (id, kind, cutoff, fs, order, why)
    ("lowpass_40_256_o2", "lowpass", 40.0, 256.0, 2, "EEG anti-alias / smoothing"),
    ("lowpass_40_256_o4", "lowpass", 40.0, 256.0, 4, "EEG low-pass, typical order"),
    ("lowpass_40_256_o6", "lowpass", 40.0, 256.0, 6, "steeper low-pass"),
    ("lowpass_3_64_o4", "lowpass", 3.0, 64.0, 4, "PPG smoothing at Muse PPG rate"),
    ("highpass_0.5_256_o4", "highpass", 0.5, 256.0, 4, "EEG drift removal"),
    ("highpass_1_250_o2", "highpass", 1.0, 250.0, 2, "OpenBCI drift removal"),
    ("lowpass_40_256_o3", "lowpass", 40.0, 256.0, 3, "odd order"),
    ("bandpass_1_40_256_o4", "bandpass", [1.0, 40.0], 256.0, 4, "Filtering node default"),
    ("bandpass_8_12_256_o4", "bandpass", [8.0, 12.0], 256.0, 4, "alpha band isolation"),
    ("bandpass_hr_64_o4", "bandpass", [40 / 60, 200 / 60], 64.0, 4, "HeartRate pulse band, Muse PPG"),
    ("bandpass_hr_30_o4", "bandpass", [40 / 60, 200 / 60], 30.0, 4, "HeartRate pulse band, camera rPPG"),
    ("bandstop_58_62_256_o2", "bandstop", [58.0, 62.0], 256.0, 2, "60 Hz line-noise notch"),
]


def scipy_sos(kind, cutoff, fs, order):
    n = order // 2 if kind in ("bandpass", "bandstop") else order
    return signal.butter(n, cutoff, btype=kind, fs=fs, output="sos"), n


def build_design():
    cases = []
    for cid, kind, cutoff, fs, order, why in DESIGNS:
        sos, n = scipy_sos(kind, cutoff, fs, order)
        nyq = fs / 2
        grid = np.unique(
            np.concatenate(
                [
                    np.geomspace(0.05, 0.98 * nyq, 120),
                    np.atleast_1d(cutoff),
                ]
            )
        )
        _, h = signal.sosfreqz(sos, worN=grid, fs=fs)
        cases.append(
            {
                "id": cid,
                "kind": kind,
                "cutoff": cutoff,
                "samplingRate": fs,
                "order": order,
                "why": why,
                "scipyCall": f"scipy.signal.butter({n}, {cutoff}, btype='{kind}', fs={fs}, output='sos')",
                "frequencies": floats(grid),
                "magnitude": floats(np.abs(h)),
            }
        )
    return {
        "reference": "scipy.signal.butter(...) + scipy.signal.sosfreqz; band filters use butter(order // 2)",
        "cases": cases,
    }


def build_lfilter(signals):
    """scipy.signal.lfilter with zero initial state, on the package's float32 input.

    Coefficients are stored in the fixture, so these cases isolate the
    difference-equation engine from filter design.
    """
    from_pkg_fir = [
        -0.00588043, -0.00620177, -0.00106799, 0.02467073, 0.07864882, 0.15035629,
        0.21289894, 0.23779528, 0.21289894, 0.15035629, 0.07864882, 0.02467073,
        -0.00106799, -0.00620177, -0.00588043,
    ]
    plan = [
        ("fir_ppg_lowpass", from_pkg_fir, [1.0], "ppg_muse_60bpm"),
        ("biquad_lowpass_10hz", *signal.butter(2, 10.0, fs=256.0), "white_noise_unit"),
        ("biquad_highpass_0.5hz_dc", *signal.butter(2, 0.5, "highpass", fs=256.0), "eeg_dc_drift_30s"),
    ]
    cases = []
    for cid, b, a, name in plan:
        x = as_float32(signals[name]["channels"][0])
        y = signal.lfilter(b, a, x)
        cases.append(
            {
                "id": cid,
                "signal": name,
                "b": floats(b),
                "a": floats(a),
                "output": floats(y),
            }
        )
    return {
        "reference": "scipy.signal.lfilter(b, a, x) with zero initial conditions, float64",
        "cases": cases,
    }


def build_streaming(signals):
    """A Filtering node fed Muse-sized packets vs one sosfilt over the whole record.

    The streaming node must carry state across packets, so chunked output has
    to equal a single pass. Only designs where package and SciPy agree are used
    here, so any mismatch is the streaming machinery or arithmetic width.
    """
    plan = [
        ("highpass_0.5_dc_drift", "highpass", 0.5, 4, "eeg_dc_drift_30s", 12),
        ("lowpass_40_eeg4ch", "lowpass", 40.0, 4, "eeg_muse_4s", 12),
        ("bandpass_default_eeg4ch", "bandpass", [1.0, 40.0], 4, "eeg_muse_4s", 12),
    ]
    cases = []
    for cid, kind, cutoff, order, name, chunk in plan:
        sig = signals[name]
        fs = sig["fs"]
        sos, n = scipy_sos(kind, cutoff, fs, order)
        outs = [floats(signal.sosfilt(sos, as_float32(c))) for c in sig["channels"]]
        cases.append(
            {
                "id": cid,
                "signal": name,
                "kind": kind,
                "cutoff": cutoff,
                "order": order,
                "packetSize": chunk,
                "scipyCall": f"sosfilt(butter({n}, {cutoff}, '{kind}', fs={fs}, output='sos'), x)",
                "output": outs,
            }
        )
    return {
        "reference": "scipy.signal.sosfilt over the whole record, zero initial state, float64",
        "cases": cases,
    }


def zero_init_filtfilt(b, a, x):
    """filtfilt as filter.ts documents it: odd-reflection padding, zero state.

    SciPy's own filtfilt additionally seeds each pass with the step-response
    steady state (lfilter_zi scaled by the first sample), which is what removes
    the start-up transient; see Gustafsson (1996) and the scipy docs.
    """
    padlen = min(3 * max(len(a), len(b)), len(x) - 1)
    ext = signal._arraytools.odd_ext(x, padlen)
    y = signal.lfilter(b, a, ext)
    y = signal.lfilter(b, a, y[::-1])[::-1]
    return y[padlen : padlen + len(x)]


def build_filtfilt(signals):
    cases = []
    b, a = signal.butter(2, 3.0, fs=64.0)
    for name in ("ppg_muse_60bpm", "ppg_muse_75bpm_offset"):
        x = as_float32(signals[name]["channels"][0])
        cases.append(
            {
                "id": f"biquad_lowpass_3hz:{name}",
                "signal": name,
                "b": floats(b),
                "a": floats(a),
                "scipy": floats(signal.filtfilt(b, a, x)),
                "zeroInitOddPad": floats(zero_init_filtfilt(b, a, x)),
                "edgeSamples": 3 * max(len(a), len(b)),
            }
        )

    sos = signal.butter(4, 3.0, fs=64.0, output="sos")
    sos_cases = []
    for name in ("ppg_muse_60bpm", "ppg_muse_75bpm_offset"):
        x = as_float32(signals[name]["channels"][0])
        sos_cases.append(
            {
                "id": f"sos_lowpass_3hz_o4:{name}",
                "signal": name,
                "sections": [{"b": floats(s[:3]), "a": floats(s[3:])} for s in sos],
                "scipy": floats(signal.sosfiltfilt(sos, x)),
            }
        )
    return {
        "reference": (
            "scipy.signal.filtfilt(b, a, x) / sosfiltfilt(sos, x) with defaults "
            "(padtype='odd', padlen=3*max(len(a),len(b)), steady-state initial "
            "conditions). zeroInitOddPad reproduces the package's documented "
            "variant (same padding, zero initial state)."
        ),
        "cases": cases,
        "sosCases": sos_cases,
    }
