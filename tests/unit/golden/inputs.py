"""Deterministic input signals for the golden-value suite.

Every signal is defined here once. ``generate.py`` serialises these to
``fixtures/_inputs.json``; the TypeScript tests load that file so both sides
work from byte-identical samples. Do not hand-edit ``_inputs.json``.

A signal is a dict with:
  - ``description`` -- one line, carried into the fixture for context.
  - ``fs``          -- sampling rate in Hz (RMS ignores it, later methods will not).
  - ``channels``    -- list of 1-D sequences, one per channel.
  - ``truth``       -- optional; what the signal was built to contain (beat
                       sample indices, the true heart rate, ...). Synthetic
                       signals carry their own ground truth so a pipeline can
                       be scored against what is actually there, not only
                       against another implementation.

Each signal past the original five draws from its own seeded generator, so
adding or reordering signals never changes the samples of an existing one.
"""

import numpy as np


def _sine(freq, fs, n, amp=1.0, phase=0.0):
    t = np.arange(n) / fs
    return amp * np.sin(2 * np.pi * freq * t + phase)


def _pink(rng, n):
    """1/f ("pink") noise with unit standard deviation, by spectral shaping.

    Resting EEG has a roughly 1/f power spectrum (He et al., 2010, Neuron
    66:353), so pink noise plus a narrowband alpha component is the standard
    synthetic stand-in for a scalp channel.
    """
    white = np.fft.rfft(rng.standard_normal(n))
    f = np.fft.rfftfreq(n)
    f[0] = f[1]  # avoid dividing by zero; the DC bin is then removed below
    shaped = np.fft.irfft(white / np.sqrt(f), n)
    shaped -= shaped.mean()
    return shaped / shaped.std()


def _eeg(rng, fs, seconds, alpha_amp, alpha_freq=10.0, scale=10.0, offset=0.0):
    """Pink background plus an amplitude-modulated alpha rhythm, in microvolts."""
    n = int(round(fs * seconds))
    t = np.arange(n) / fs
    background = scale * _pink(rng, n)
    envelope = 1.0 + 0.5 * np.sin(2 * np.pi * 0.25 * t + rng.uniform(0, 2 * np.pi))
    alpha = alpha_amp * envelope * np.sin(2 * np.pi * alpha_freq * t + rng.uniform(0, 2 * np.pi))
    return offset + background + alpha


def _ppg(
    rng,
    fs,
    seconds,
    bpm,
    rsa=0.05,
    jitter=0.01,
    wander=0.3,
    noise=0.02,
    amplitude=1.0,
    offset=0.0,
):
    """Synthetic photoplethysmogram with known beat locations.

    Each beat is the sum of a systolic and a diastolic Gaussian -- the
    two-Gaussian pulse model used for PPG simulation (Tang et al., 2020,
    Sci Rep 10:13883, doi:10.1038/s41598-020-69076-x; the same model underlies
    the PPGSynth toolbox, Front Med 7:597774). Inter-beat intervals carry respiratory sinus
    arrhythmia (``rsa``, fractional modulation at 0.25 Hz) and random jitter.
    Baseline wander (0.15 Hz sine plus a slow linear drift) and white noise are
    added on top.

    Returns ``(signal, truth)``; ``truth["beats"]`` are the sample indices of
    the systolic maxima of the *noise-free* waveform, which is what a peak
    detector should find.
    """
    n = int(round(fs * seconds))
    t = np.arange(n) / fs

    beats = []
    tk = 0.3 + rng.uniform(0, 0.3)
    while tk < seconds + 1.0:
        beats.append(tk)
        ibi = (60.0 / bpm) * (1.0 + rsa * np.sin(2 * np.pi * 0.25 * tk))
        ibi *= 1.0 + jitter * rng.standard_normal()
        tk += ibi
    beats = np.array(beats)

    clean = np.zeros(n)
    for k, tb in enumerate(beats):
        ibi = beats[k + 1] - tb if k + 1 < len(beats) else 60.0 / bpm
        s1, s2, delay, a2 = 0.11 * ibi, 0.14 * ibi, 0.35 * ibi, 0.45
        clean += np.exp(-((t - tb) ** 2) / (2 * s1**2))
        clean += a2 * np.exp(-((t - tb - delay) ** 2) / (2 * s2**2))

    # Ground truth: the maximum of the clean waveform nearest each beat onset.
    truth_idx = []
    for k, tb in enumerate(beats):
        ibi = beats[k + 1] - tb if k + 1 < len(beats) else 60.0 / bpm
        lo = int(np.floor((tb - 0.25 * ibi) * fs))
        hi = int(np.ceil((tb + 0.25 * ibi) * fs))
        if lo < 1 or hi >= n - 1:
            continue  # beat clipped by the edge of the recording
        truth_idx.append(lo + int(np.argmax(clean[lo : hi + 1])))
    truth_idx = np.array(truth_idx, dtype=int)

    baseline = wander * np.sin(2 * np.pi * 0.15 * t + rng.uniform(0, 2 * np.pi))
    baseline += wander * 0.5 * (t / seconds)
    signal = offset + amplitude * (clean + baseline + noise * rng.standard_normal(n))

    ibis = np.diff(truth_idx) / fs
    truth = {
        "beats": truth_idx.tolist(),
        "hr": float(60.0 / ibis.mean()),
        "bpm": float(bpm),
    }
    return signal, truth


def build_signals():
    """Return the signal registry. Called by generate.py."""
    rng = np.random.default_rng(20260828)

    signals = {
        "sine_10hz_unit": {
            "description": "10 Hz sine, unit amplitude, 1024 samples at 256 Hz. RMS = 1/sqrt(2).",
            "fs": 256.0,
            "channels": [_sine(10.0, 256.0, 1024)],
        },
        "dc_offset": {
            "description": "Constant 0.5 for 512 samples. RMS = 0.5 exactly; zero-variance edge case.",
            "fs": 256.0,
            "channels": [np.full(512, 0.5)],
        },
        "white_noise_unit": {
            "description": "Gaussian white noise, sigma = 1, 2048 samples, seed 20260828.",
            "fs": 256.0,
            "channels": [rng.standard_normal(2048)],
        },
        "two_tone_offset": {
            "description": (
                "0.5 + sin(2*pi*8t) + 0.3*sin(2*pi*40t), 1500 samples at 500 Hz. "
                "No closed form; pure golden master."
            ),
            "fs": 500.0,
            "channels": [
                0.5 + _sine(8.0, 500.0, 1500) + 0.3 * _sine(40.0, 500.0, 1500)
            ],
        },
        "stereo_tones": {
            "description": (
                "Two channels: 5 Hz unit sine and 12 Hz half-amplitude sine, "
                "800 samples at 200 Hz. Exercises the multi-channel path."
            ),
            "fs": 200.0,
            "channels": [
                _sine(5.0, 200.0, 800),
                _sine(12.0, 200.0, 800, amp=0.5),
            ],
        },
    }

    # --- Spectral ---------------------------------------------------------

    signals["sine_8hz_bin_centred"] = {
        "description": (
            "8 Hz sine, amplitude 2.0, 256 samples at 256 Hz: exactly on an FFT "
            "bin with no zero padding, so an amplitude spectrum must read 2.0."
        ),
        "fs": 256.0,
        "channels": [_sine(8.0, 256.0, 256, amp=2.0)],
    }

    r = np.random.default_rng(1001)
    signals["eeg_muse_4s"] = {
        "description": (
            "Synthetic 4-channel scalp EEG at Muse's 256 Hz, 4 s: pink (1/f) "
            "background (10 uV sd) plus a 10 Hz alpha rhythm of differing "
            "strength per channel, in microvolts."
        ),
        "fs": 256.0,
        "channels": [
            _eeg(r, 256.0, 4.0, alpha_amp=a) for a in (4.0, 8.0, 12.0, 2.0)
        ],
    }

    r = np.random.default_rng(1002)
    signals["eeg_openbci_2s"] = {
        "description": (
            "Synthetic single-channel EEG at OpenBCI's 250 Hz, 2 s = 500 samples "
            "(not a power of two, so the spectrum is zero-padded to 512)."
        ),
        "fs": 250.0,
        "channels": [_eeg(r, 250.0, 2.0, alpha_amp=8.0)],
    }

    # --- Filtering --------------------------------------------------------

    r = np.random.default_rng(1003)
    signals["eeg_dc_drift_30s"] = {
        "description": (
            "30 s of synthetic EEG at 256 Hz riding on a 5000 uV electrode "
            "offset with a slow 40 uV drift -- the input a 0.5 Hz high-pass "
            "exists to clean up, and a stress test for float32 recursion."
        ),
        "fs": 256.0,
        "channels": [
            _eeg(r, 256.0, 30.0, alpha_amp=8.0, offset=5000.0)
            + 40.0 * np.sin(2 * np.pi * 0.02 * np.arange(7680) / 256.0)
        ],
    }

    # --- Cardiac ----------------------------------------------------------

    for name, seed, fs, seconds, bpm, kwargs, desc in [
        ("ppg_muse_60bpm", 2001, 64.0, 30.0, 60.0, {},
         "Synthetic PPG at Muse's 64 Hz, 30 s, 60 bpm, mild RSA, wander and noise."),
        ("ppg_muse_75bpm_offset", 2002, 64.0, 30.0, 75.0,
         {"amplitude": 400.0, "offset": 1.2e5, "wander": 0.6, "noise": 0.04},
         "Synthetic PPG at 64 Hz, 30 s, 75 bpm, on a raw-sensor-like 1.2e5 offset "
         "with stronger baseline wander."),
        ("ppg_muse_110bpm_noisy", 2003, 64.0, 30.0, 110.0,
         {"noise": 0.12, "rsa": 0.03},
         "Synthetic PPG at 64 Hz, 30 s, 110 bpm, heavy white noise (sd 0.12 of pulse height)."),
        ("rppg_camera_72bpm", 2004, 30.0, 20.0, 72.0,
         {"amplitude": 0.4, "offset": 120.0, "noise": 0.35, "wander": 1.5},
         "Synthetic camera rPPG (green-channel mean) at 30 fps, 20 s, 72 bpm: tiny "
         "pulse under large lighting drift and sensor noise."),
    ]:
        x, truth = _ppg(np.random.default_rng(seed), fs, seconds, bpm, **kwargs)
        signals[name] = {
            "description": desc,
            "fs": fs,
            "channels": [x],
            "truth": truth,
        }

    # --- Correlation ------------------------------------------------------

    r = np.random.default_rng(3001)
    shared = r.standard_normal((2, 512))
    a = shared + 0.5 * r.standard_normal((2, 512))
    b = 0.8 * shared + 0.7 * r.standard_normal((2, 512)) + np.array([[3.0], [-1.0]])
    signals["corr_a"] = {
        "description": "Stream A for correlation: 2 channels, 512 samples, sharing a latent with corr_b.",
        "fs": 128.0,
        "channels": list(a),
    }
    signals["corr_b"] = {
        "description": "Stream B: same latent as corr_a plus independent noise and per-channel offsets.",
        "fs": 128.0,
        "channels": list(b),
    }
    signals["corr_b_short"] = {
        "description": (
            "The newest 400 samples of corr_b: a shorter window ending at the "
            "same instant. Paired with corr_a_head_shift it makes the two "
            "windows differ in length."
        ),
        "fs": 128.0,
        "channels": [c[-400:] for c in b],
    }
    # The long partner of corr_b_short: corr_a with a +5 shift on its oldest
    # 112 samples, which fall outside the 400-sample overlap in time.
    a_long = a.copy()
    a_long[:, :-400] += 5.0
    signals["corr_a_head_shift"] = {
        "description": "corr_a with +5 added to samples 0-111 (outside the newest 400-sample overlap).",
        "fs": 128.0,
        "channels": list(a_long),
    }

    # --- Audio level ------------------------------------------------------

    signals["aes17_full_scale_997hz"] = {
        "description": (
            "AES17 reference tone: 997 Hz sine at digital full scale (peak 1.0), "
            "4800 samples at 48 kHz. AES17 defines its RMS level as 0 dBFS."
        ),
        "fs": 48000.0,
        "channels": [_sine(997.0, 48000.0, 4800)],
    }

    return signals
