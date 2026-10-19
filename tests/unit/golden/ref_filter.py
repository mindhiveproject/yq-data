"""References for src/analyzer/methods/filter.ts and the Filtering node.

Design is checked by frequency response rather than coefficients: SciPy and
the package may order or pair second-order sections differently and still
realise the same filter, so |H(f)| is the quantity that must agree.

Filter-order convention: the package's ``order`` is the ``N`` of
``scipy.signal.butter(N, ...)``, so a band filter of order N has 2N poles,
exactly as in SciPy. Besides the response, the design is also checked
coefficient-for-coefficient (``build_butter``), ``firwin`` and the window
functions are checked tap-for-tap, and ``filtfilt`` is exercised over every
pad type.
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
    ("highpass_1_250_o5", "highpass", 1.0, 250.0, 5, "odd order high-pass"),
    ("bandpass_1_40_256_o4", "bandpass", [1.0, 40.0], 256.0, 4, "Filtering node default"),
    ("bandpass_1_40_256_o3", "bandpass", [1.0, 40.0], 256.0, 3, "odd order band-pass"),
    ("bandpass_8_12_256_o4", "bandpass", [8.0, 12.0], 256.0, 4, "alpha band isolation"),
    ("bandpass_hr_64_o2", "bandpass", [40 / 60, 200 / 60], 64.0, 2, "HeartRate pulse band, Muse PPG"),
    ("bandpass_hr_30_o2", "bandpass", [40 / 60, 200 / 60], 30.0, 2, "HeartRate pulse band, camera rPPG"),
    ("bandstop_58_62_256_o2", "bandstop", [58.0, 62.0], 256.0, 2, "60 Hz line-noise notch"),
    ("bandstop_48_52_250_o3", "bandstop", [48.0, 52.0], 250.0, 3, "50 Hz line-noise notch, odd order"),
]


def scipy_sos(kind, cutoff, fs, order):
    return signal.butter(order, cutoff, btype=kind, fs=fs, output="sos"), order


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
        "reference": "scipy.signal.butter(order, ...) + scipy.signal.sosfreqz",
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
    to equal a single pass; a mismatch is the streaming machinery, the design,
    or arithmetic width.
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
            "conditions)."
        ),
        "cases": cases,
        "sosCases": sos_cases,
    }


# ---------------------------------------------------------------------------
# Coefficient-level design checks


BUTTER_GRID = [
    # (kind, cutoff, fs, why)
    ("lowpass", 40.0, 256.0, "EEG low-pass"),
    ("highpass", 0.5, 250.0, "EEG drift removal"),
    ("bandpass", [1.0, 40.0], 256.0, "EEG broadband"),
    ("bandpass", [8.0, 12.0], 256.0, "alpha"),
    ("bandpass", [40 / 60, 200 / 60], 64.0, "pulse band, Muse PPG"),
    ("bandstop", [58.0, 62.0], 256.0, "60 Hz notch"),
    ("bandstop", [48.0, 52.0], 250.0, "50 Hz notch"),
]


def _pairs(values):
    return [[float(v.real), float(v.imag)] for v in np.atleast_1d(values)]


def build_butter():
    """Butterworth design, coefficient for coefficient.

    ``sos`` is compared in SciPy's own order (the pairing algorithm is
    ported), ``zpk`` as a set, and ``ba`` only up to order 4 -- above that the
    transfer-function form is too ill-conditioned for any two implementations
    to agree to many digits, which is SciPy's own warning about it.
    """
    cases = []
    for kind, cutoff, fs, why in BUTTER_GRID:
        for order in range(1, 9):
            call = f"scipy.signal.butter({order}, {cutoff}, btype='{kind}', fs={fs}, output=%r)"
            z, p, k = signal.butter(order, cutoff, btype=kind, fs=fs, output="zpk")
            case = {
                "id": f"{kind}_{cutoff}_{fs}_N{order}",
                "kind": kind,
                "cutoff": cutoff,
                "samplingRate": fs,
                "order": order,
                "why": why,
                "scipyCall": call % "sos",
                "sos": floats(signal.butter(order, cutoff, btype=kind, fs=fs, output="sos")),
                "zpk": {"z": _pairs(z), "p": _pairs(p), "k": float(k)},
            }
            if order <= 4:
                b, a = signal.butter(order, cutoff, btype=kind, fs=fs)
                case["ba"] = {"b": floats(b), "a": floats(a)}
            cases.append(case)
    return {
        "reference": "scipy.signal.butter(N, Wn, btype, fs=fs, output=...) for N = 1..8",
        "cases": cases,
    }


# ---------------------------------------------------------------------------
# Windows and FIR design


WINDOW_SPECS = [
    # (id, spec as the package takes it, spec as SciPy takes it)
    ("boxcar", "boxcar", "boxcar"),
    ("rectangular", "rectangular", "boxcar"),
    ("triang", "triang", "triang"),
    ("bartlett", "bartlett", "bartlett"),
    ("hann", "hann", "hann"),
    ("hamming", "hamming", "hamming"),
    ("blackman", "blackman", "blackman"),
    ("blackmanharris", "blackmanharris", "blackmanharris"),
    ("nuttall", "nuttall", "nuttall"),
    ("flattop", "flattop", "flattop"),
    ("cosine", "cosine", "cosine"),
    ("bohman", "bohman", "bohman"),
    ("kaiser_8.6", ["kaiser", 8.6], ("kaiser", 8.6)),
    ("kaiser_0", ["kaiser", 0.0], ("kaiser", 0.0)),
    ("tukey_0.25", ["tukey", 0.25], ("tukey", 0.25)),
    ("tukey_default", "tukey", "tukey"),
    ("tukey_1", ["tukey", 1.0], ("tukey", 1.0)),
    ("gaussian_7", ["gaussian", 7.0], ("gaussian", 7.0)),
]
WINDOW_LENGTHS = [1, 2, 3, 8, 31, 64, 101]


def build_window_functions():
    cases = []
    for wid, spec, scipy_spec in WINDOW_SPECS:
        for length in WINDOW_LENGTHS:
            for symmetric in (True, False):
                w = signal.get_window(scipy_spec, length, fftbins=not symmetric)
                cases.append(
                    {
                        "id": f"{wid}:{length}:{'sym' if symmetric else 'periodic'}",
                        "spec": spec,
                        "length": length,
                        "symmetric": symmetric,
                        "window": floats(w),
                    }
                )
    return {
        "reference": "scipy.signal.get_window(spec, M, fftbins=not symmetric)",
        "cases": cases,
    }


FIR_CASES = [
    # (id, numtaps, cutoff, fs, firwin kwargs, why)
    ("lowpass_hamming", 101, 40.0, 256.0, {}, "default window"),
    ("lowpass_even_taps", 100, 40.0, 256.0, {}, "even length is fine for a low-pass"),
    ("lowpass_noscale", 101, 40.0, 256.0, {"scale": False}, "unscaled"),
    ("lowpass_normalised", 51, 0.3, 2.0, {}, "fs=2: cutoff as a fraction of Nyquist"),
    ("highpass_hamming", 101, 1.0, 256.0, {"pass_zero": False}, "drift removal"),
    ("highpass_named", 101, 1.0, 256.0, {"pass_zero": "highpass"}, "pass_zero by name"),
    ("bandpass_hamming", 201, [1.0, 40.0], 256.0, {"pass_zero": False}, "EEG broadband"),
    ("bandpass_alpha", 257, [8.0, 12.0], 256.0, {"pass_zero": "bandpass"}, "alpha"),
    ("bandstop_hamming", 201, [58.0, 62.0], 256.0, {"pass_zero": True}, "60 Hz notch"),
    ("bandstop_named", 201, [48.0, 52.0], 250.0, {"pass_zero": "bandstop"}, "50 Hz notch"),
    ("multiband", 151, [10.0, 20.0, 40.0], 256.0, {"pass_zero": True}, "three edges"),
    ("kaiser_width", 101, 40.0, 256.0, {"width": 5.0}, "width= picks a Kaiser window"),
]
FIR_WINDOWS = [w for w in WINDOW_SPECS if w[0] not in ("rectangular", "kaiser_0", "tukey_1")]


def _firwin(numtaps, cutoff, fs, window, kwargs):
    return signal.firwin(numtaps, cutoff, fs=fs, window=window, **kwargs)


def build_fir():
    cases = []
    for cid, numtaps, cutoff, fs, kwargs, why in FIR_CASES:
        if "width" in kwargs:
            windows = [("(from width)", None, None)]
        else:
            windows = [("hamming", "hamming", "hamming")] if cid not in WINDOWED else FIR_WINDOWS
        for wid, spec, scipy_spec in windows:
            kw = dict(kwargs)
            h = (
                signal.firwin(numtaps, cutoff, fs=fs, **kw)
                if scipy_spec is None
                else _firwin(numtaps, cutoff, fs, scipy_spec, kw)
            )
            cases.append(
                {
                    "id": f"{cid}:{wid}",
                    "numtaps": numtaps,
                    "cutoff": cutoff,
                    "fs": fs,
                    "options": {
                        "window": spec,
                        **{{"pass_zero": "passZero"}.get(k, k): v for k, v in kw.items()},
                    },
                    "why": why,
                    "taps": floats(h),
                }
            )
    ord_cases = []
    for ripple, width in [(60.0, 0.1), (40.0, 0.05), (80.0, 0.2), (12.0, 0.3)]:
        n, beta = signal.kaiserord(ripple, width)
        ord_cases.append({"ripple": ripple, "width": width, "numtaps": int(n), "beta": float(beta)})
    return {
        "reference": "scipy.signal.firwin(numtaps, cutoff, window=..., pass_zero=..., fs=...), kaiserord",
        "cases": cases,
        "kaiserord": ord_cases,
    }


# A few designs are swept over every window, the rest use the default only.
WINDOWED = {"lowpass_hamming", "highpass_hamming", "bandpass_hamming", "bandstop_hamming"}


# ---------------------------------------------------------------------------
# Initial conditions and zero-phase variants


# Leading samples of each signal used by the cases below: enough to cover both
# edges and a stretch of interior, small enough to keep the fixture light.
EXTRAS_SAMPLES = 600


def build_filtering_extras(signals):
    """lfilter_zi / sosfilt_zi, lfilter with zi, and filtfilt over pad types."""
    zi_cases = []
    for name, (b, a) in {
        "butter2_low": signal.butter(2, 0.2),
        "butter4_band": signal.butter(2, [0.1, 0.4], btype="band"),
        "fir_15": (np.hanning(15) / np.hanning(15).sum(), [1.0]),
        "butter3_high": signal.butter(3, 0.1, btype="high"),
        "unnormalised": (np.array([2.0, 1.0, 0.5]), np.array([2.0, -0.5, 0.25])),
        "b_longer_than_a": (np.array([0.5, 0.25, 0.125, 0.0625]), np.array([1.0, -0.4])),
    }.items():
        zi_cases.append({"id": name, "b": floats(b), "a": floats(a), "zi": floats(signal.lfilter_zi(b, a))})

    sos_cases = []
    for name, sos in {
        "lowpass_o4": signal.butter(4, 40.0, fs=256.0, output="sos"),
        "bandpass_o3": signal.butter(3, [1.0, 40.0], btype="band", fs=256.0, output="sos"),
        "highpass_o5": signal.butter(5, 0.5, btype="high", fs=250.0, output="sos"),
    }.items():
        sos_cases.append({"id": name, "sos": floats(sos), "zi": floats(signal.sosfilt_zi(sos))})

    # lfilter / sosfilt with an explicit initial state, one shot.
    x = as_float32(signals["eeg_muse_4s"]["channels"][0])[:EXTRAS_SAMPLES]
    b, a = signal.butter(3, [4.0, 30.0], btype="band", fs=256.0)
    zi = np.linspace(-0.3, 0.4, max(len(a), len(b)) - 1)
    y, zf = signal.lfilter(b, a, x, zi=zi)
    lfilter_zi_case = {
        "signal": "eeg_muse_4s",
        "b": floats(b),
        "a": floats(a),
        "zi": floats(zi),
        "output": floats(y),
        "zf": floats(zf),
    }

    sos = signal.butter(4, [4.0, 30.0], btype="band", fs=256.0, output="sos")
    zi_sos = np.stack([np.linspace(-0.2, 0.3, 2) * (i + 1) for i in range(len(sos))])
    y, zf = signal.sosfilt(sos, x, zi=zi_sos)
    sosfilt_zi_case = {
        "signal": "eeg_muse_4s",
        "sos": floats(sos),
        "zi": floats(zi_sos),
        "output": floats(y),
        "zf": floats(zf),
    }

    # filtfilt: pad types and lengths, ba and sos and FIR.
    pad_cases = []
    plan = [
        ("ppg_muse_75bpm_offset", "ba", signal.butter(2, 3.0, fs=64.0)),
        ("eeg_dc_drift_30s", "sos", signal.butter(4, [1.0, 40.0], btype="band", fs=256.0, output="sos")),
        ("eeg_muse_4s", "sos", signal.butter(3, 30.0, fs=256.0, output="sos")),
        ("ppg_muse_75bpm_offset", "fir", (signal.firwin(41, 3.0, fs=64.0), np.array([1.0]))),
    ]
    for name, form, design in plan:
        x = as_float32(signals[name]["channels"][0])[:EXTRAS_SAMPLES]
        for padtype in ("odd", "even", "constant", None):
            for padlen in (None, 0, 7, 50):
                kw = {"padtype": padtype}
                if padlen is not None:
                    kw["padlen"] = padlen
                if form == "sos":
                    y = signal.sosfiltfilt(design, x, **kw)
                    coeffs = {"sections": [{"b": floats(r[:3]), "a": floats(r[3:])} for r in design]}
                else:
                    b, a = design
                    y = signal.filtfilt(b, a, x, **kw)
                    coeffs = {"b": floats(b), "a": floats(a)}
                pad_cases.append(
                    {
                        "id": f"{form}:{name}:{padtype}:{padlen}",
                        "form": form,
                        "signal": name,
                        "padtype": padtype,
                        "padlen": padlen,
                        **coeffs,
                        "scipy": floats(y),
                    }
                )

    return {
        "reference": "scipy.signal.lfilter_zi / sosfilt_zi / lfilter(zi=) / sosfilt(zi=) / filtfilt / sosfiltfilt",
        "lfilterZi": zi_cases,
        "sosfiltZi": sos_cases,
        "samples": EXTRAS_SAMPLES,
        "lfilterWithZi": lfilter_zi_case,
        "sosfiltWithZi": sosfilt_zi_case,
        "padCases": pad_cases,
    }

