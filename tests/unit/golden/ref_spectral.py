"""References for src/analyzer/methods/fft.ts, Spectrum and BandPower.

Two kinds of reference live here, and the tests treat them differently:

* **Conformance** -- what SciPy computes when asked for exactly the convention
  the package documents (symmetric window, mean removed, zero-padded to a power
  of two, one-sided). The package should match these to float32 precision.
* **Field standard** -- what an established EEG pipeline computes for the same
  question ("how much alpha is in this window?"). YASA's ``bandpower``
  (Vallat & Walker, 2021, eLife 10:e70092) is the reference: Welch PSD
  (scipy.signal.welch, periodic Hann) integrated over each band with Simpson's
  rule. Agreement here is judged with a tolerance, not to the last digit.
"""

import numpy as np
import scipy.signal as signal
import yasa

from ref_common import as_float32, floats, next_pow2

# Mirror of DEFAULT_EEG_BANDS in band_power.ts.
EEG_BANDS = {
    "Delta": (1, 4),
    "Theta": (4, 8),
    "Alpha": (8, 12),
    "Low beta": (12, 16),
    "High beta": (16, 25),
    "Gamma": (25, 45),
}

WINDOWS = {"hamming": "hamming", "hann": "hann", "blackman": "blackman", "rectangular": "boxcar"}


def sym_window(kind, n):
    return signal.windows.get_window(WINDOWS[kind], n, fftbins=False)


def package_spectrum(x, fs, window="hamming", detrend=True):
    """The package's documented spectrum convention, computed with SciPy.

    Returns (magnitude, psd, freqs, nfft, nyquist_psd). ``psd`` is literally
    ``scipy.signal.periodogram`` with the package's window, padding and detrend;
    ``magnitude`` is the amplitude spectrum ``2|X|/sum(w)`` (``|X|/sum(w)`` at
    DC), Heinzel, Ruediger & Schilling (2002) sec. 9, as fft.ts documents it.
    """
    n = len(x)
    nfft = next_pow2(n)
    w = sym_window(window, n)
    xd = x - x.mean() if detrend else x
    spec = np.fft.rfft(xd * w, nfft)
    bins = nfft // 2
    magnitude = 2 * np.abs(spec[:bins]) / w.sum()
    magnitude[0] /= 2
    freqs, psd = signal.periodogram(
        x,
        fs,
        window=w,
        nfft=nfft,
        detrend="constant" if detrend else False,
        scaling="density",
        return_onesided=True,
    )
    return magnitude, psd[:bins], freqs[:bins], nfft, float(psd[bins])


def build_spectrum(signals):
    cases = []
    plan = [
        ("sine_8hz_bin_centred", ["hamming", "hann", "rectangular"], [True]),
        ("sine_10hz_unit", ["hamming"], [True, False]),
        ("two_tone_offset", ["hamming", "hann"], [True, False]),
        ("stereo_tones", ["hamming"], [True]),
        ("eeg_muse_4s", ["hamming", "hann"], [True]),
        ("eeg_openbci_2s", ["hamming", "blackman"], [True]),
    ]
    for name, windows, detrends in plan:
        sig = signals[name]
        fs = sig["fs"]
        for window in windows:
            for detrend in detrends:
                mags, psds, nyq = [], [], []
                for c in sig["channels"]:
                    m, p, freqs, nfft, nyquist = package_spectrum(
                        as_float32(c), fs, window, detrend
                    )
                    mags.append(floats(m))
                    psds.append(floats(p))
                    nyq.append(nyquist)
                cases.append(
                    {
                        "signal": name,
                        "window": window,
                        "detrend": detrend,
                        "fftLength": nfft,
                        "resolution": fs / nfft,
                        "frequencies": floats(freqs),
                        "magnitude": mags,
                        "psd": psds,
                        "nyquistPsd": nyq,
                    }
                )

    # Amplitude recovery (Heinzel, Ruediger & Schilling, 2002, sec. 9): the
    # amplitude spectrum of a windowed sinusoid is 2|X|/sum(w), which reads
    # the sinusoid's own amplitude at its bin for any window.
    sig = signals["sine_8hz_bin_centred"]
    x = as_float32(sig["channels"][0])
    amplitude = {}
    for window in ("hamming", "hann", "rectangular"):
        w = sym_window(window, len(x))
        spec = np.fft.rfft((x - x.mean()) * w, next_pow2(len(x)))
        amplitude[window] = {
            "heinzelAmplitudeAtBin": float(2 * np.abs(spec[8]) / w.sum()),
            "coherentGain": float(w.sum() / len(w)),
        }

    return {
        "reference": (
            "scipy.signal.periodogram(x, fs, window=<symmetric window array>, "
            "nfft=next_pow2(len), detrend='constant'|False, scaling='density'), "
            "first nfft/2 bins; magnitude = 2*|rfft(detrended*w, nfft)|/sum(w), "
            "|X|/sum(w) at DC (Heinzel 2002 sec. 9)"
        ),
        "cases": cases,
        "amplitude": {
            "signal": "sine_8hz_bin_centred",
            "trueAmplitude": 2.0,
            "bin": 8,
            "windows": amplitude,
        },
    }


def band_area(spec, freqs, lo, hi):
    """Area under the piecewise-linear spectrum between lo and hi (trapezoid
    rule, edges linearly interpolated), clipped to the spectrum's frequencies."""
    lo, hi = max(lo, freqs[0]), min(hi, freqs[-1])
    if hi <= lo:
        return 0.0, 0.0
    grid = np.concatenate([[lo], freqs[(freqs > lo) & (freqs < hi)], [hi]])
    return float(np.trapezoid(np.interp(grid, freqs, spec), grid)), float(hi - lo)


def own_convention_bands(spec, freqs, bands, aggregate):
    """bandAverage / bandSum from fft.ts: exact-edge trapezoid integration.

    "sum" is bandSum, the area under the spectrum -- on a PSD, band power in
    units^2. "mean" is bandAverage, that area over the band's width.
    """
    out = []
    for lo, hi in bands.values():
        area, width = band_area(spec, freqs, lo, hi)
        out.append(area if aggregate == "sum" else (area / width if width else 0.0))
    return np.array(out)


def build_band_power(signals):
    configs = [
        # BandPower defaults: hamming, psd, integrated, averaged across channels.
        {"window": "hamming", "scaling": "psd", "aggregate": "sum", "relative": False},
        {"window": "hamming", "scaling": "psd", "aggregate": "sum", "relative": True},
        # The original You-Quantified numbers: mean amplitude across bins.
        {"window": "hamming", "scaling": "magnitude", "aggregate": "mean", "relative": False},
        {"window": "hamming", "scaling": "magnitude", "aggregate": "mean", "relative": True},
        {"window": "hann", "scaling": "psd", "aggregate": "sum", "relative": True},
        {"window": "hamming", "scaling": "psd", "aggregate": "mean", "relative": False},
    ]
    bands_for_yasa = [(lo, hi, name) for name, (lo, hi) in EEG_BANDS.items()]

    cases = []
    for name in ("eeg_muse_4s", "eeg_openbci_2s"):
        sig = signals[name]
        fs = sig["fs"]
        chans = np.array([as_float32(c) for c in sig["channels"]])
        n = chans.shape[1]

        own = []
        for cfg in configs:
            per_channel = []
            for c in chans:
                m, p, freqs, nfft, _ = package_spectrum(c, fs, cfg["window"], True)
                spec = p if cfg["scaling"] == "psd" else m
                per_channel.append(
                    own_convention_bands(spec, freqs, EEG_BANDS, cfg["aggregate"])
                )
            per_channel = np.array(per_channel)  # [channel][band]
            averaged = per_channel.mean(axis=0)
            if cfg["relative"]:
                averaged = averaged / averaged.sum()
                rel_pc = per_channel / per_channel.sum(axis=1, keepdims=True)
            else:
                rel_pc = per_channel
            own.append(
                {
                    **cfg,
                    "channelAverage": floats(averaged),
                    "perChannel": floats(rel_pc),
                }
            )

        # Physically integrated band power from the *same* periodogram the
        # package uses (hamming, zero-padded): the piecewise-linear PSD
        # integrated on a dense grid, an independent route to band_area().
        # Isolates the units question from window and band-edge choices.
        integrated = []
        for c in chans:
            _, p, f, _, _ = package_spectrum(c, fs, "hamming", True)
            integrated.append(
                [
                    np.trapezoid(np.interp(g, f, p), g)
                    for g in (np.linspace(lo, hi, 400001) for lo, hi in EEG_BANDS.values())
                ]
            )
        integrated = np.array(integrated)

        # Field standard: YASA bandpower, one Welch segment spanning the window
        # (win_sec = window length), periodic Hann, Simpson integration.
        absolute = yasa.bandpower(
            chans, sf=fs, win_sec=n / fs, bands=bands_for_yasa, relative=False
        )
        relative = yasa.bandpower(
            chans, sf=fs, win_sec=n / fs, bands=bands_for_yasa, relative=True
        )
        names = list(EEG_BANDS)
        cases.append(
            {
                "signal": name,
                "bands": EEG_BANDS,
                "ownConvention": own,
                "integratedPsdPerChannel": floats(integrated),
                "yasa": {
                    "call": f"yasa.bandpower(data, sf={fs}, win_sec={n / fs}, bands=DEFAULT_EEG_BANDS, relative=...)",
                    "absolutePerChannel": floats(absolute[names].to_numpy()),
                    "relativePerChannel": floats(relative[names].to_numpy()),
                    "relativeChannelAverage": floats(
                        absolute[names].to_numpy().mean(axis=0)
                        / absolute[names].to_numpy().mean(axis=0).sum()
                    ),
                },
            }
        )

    return {
        "reference": {
            "ownConvention": "package_spectrum() (scipy.signal.periodogram with the package's convention) + fft.ts exact-edge trapezoid integration over [lo, hi]",
            "integratedPsd": "piecewise-linear PSD integrated on a dense grid over [lo, hi] -- band power in units^2",
            "yasa": "yasa.bandpower (Vallat & Walker 2021): scipy.signal.welch + scipy.integrate.simpson, inclusive band edges",
        },
        "cases": cases,
    }
