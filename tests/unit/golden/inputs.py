"""Deterministic input signals for the golden-value suite.

Every signal is defined here once. ``generate.py`` serialises these to
``fixtures/_inputs.json``; the TypeScript tests load that file so both sides
work from byte-identical samples. Do not hand-edit ``_inputs.json``.

A signal is a dict with:
  - ``description`` -- one line, carried into the fixture for context.
  - ``fs``          -- sampling rate in Hz (RMS ignores it, later methods will not).
  - ``channels``    -- list of 1-D sequences, one per channel.
"""

import numpy as np


def _sine(freq, fs, n, amp=1.0, phase=0.0):
    t = np.arange(n) / fs
    return amp * np.sin(2 * np.pi * freq * t + phase)


def build_signals():
    """Return the signal registry. Called by generate.py."""
    rng = np.random.default_rng(20260828)

    return {
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
