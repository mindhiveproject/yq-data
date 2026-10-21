"""References for src/analyzer/methods/rppg.ts and the PulseExtraction node.

Three layers:

* **Definition** -- Wang et al.'s Algorithm 1 (2017, IEEE TBME 64:1479,
  doi:10.1109/TBME.2016.2609282), written out in NumPy: for every window of
  ``l`` frames ending at frame n, divide each channel by its window mean,
  project with P = [[0, 1, -1], [-2, 1, 1]], mix the two rows as
  h = S1 + (std S1 / std S2) * S2 and overlap-add h - mean(h). ``l`` is
  round(1.6 * fs), the paper's 32 frames at 20 fps. The package must match it
  to float precision. ``green`` is the same framing with Cn's green row alone.
* **Field toolboxes**, run from the authors' own code at a pinned commit:
  pyVHR's ``cpu_POS`` (Boccignone et al., 2022, PeerJ Comput Sci 8:e929) and
  rPPG-Toolbox's ``POS_WANG`` with its FFT heart-rate estimator (Liu et al.,
  2023, NeurIPS Datasets and Benchmarks). Each differs from the paper by an
  off-by-one in its window loop, recorded below; the tests compare where the
  difference cannot reach. Only the functions named are lifted out of each
  file (with ``ast``), because the modules import cupy, torch and OpenCV at
  top level. The files are downloaded into .cache/ and hash-checked, not
  redistributed (pyVHR is GPL-3, rPPG-Toolbox is under the Responsible AI
  License).
* **Ground truth** -- the synthetic colour signals in inputs.py know where each
  beat is (see ``_rppg_rgb``), so each window's true rate is known.
"""

import ast
import math
import types
from pathlib import Path

import numpy as np
from scipy import signal as sps
from scipy import sparse

from inputs import fetch
from ref_common import as_float32

RPPG_SIGNALS = [
    "rppg_rgb_still_72bpm",
    "rppg_rgb_flicker_66bpm",
    "rppg_rgb_motion_84bpm",
    "rppg_rgb_15fps_60bpm",
]

POS_WINDOW_SECONDS = 1.6
# Heart-rate windows over the pulse, as a Windowing node would cut them.
HR_WINDOW_SECONDS, HR_HOP_SECONDS = 10.0, 5.0
# The band rPPG-Toolbox recommends for _calculate_fft_hr to reproduce its paper.
TOOLBOX_HR_BAND = (0.75, 2.5)

PYVHR_COMMIT = "a6270f04a97f05a13d145dd0a5e8c8df48d8bd62"
PYVHR_METHODS_SHA256 = "f8ee127601254a05cb0c321706a8da1bc49e2ec8e1e183d04ced51e15f14d3b5"
TOOLBOX_COMMIT = "b7500b848f84ad7f86e277b4612563b69f4f88f9"
TOOLBOX_FILES = {
    "unsupervised_methods/methods/POS_WANG.py": "2dbc5bb5909a394ade434705e3d68bb680a50920f860508f06dfb751a492e844",
    "unsupervised_methods/utils.py": "9e9a2c7c37e49e47603665eab1c7c20f7607511ec24f9a85a74ae0c699c351ac",
    "evaluation/post_process.py": "e7bd06b26440e741f6303b08aa01c012f72823732510b867e77fd8bf6438882b",
}


def window_length(fs):
    """pulseWindowLength: Math.round(1.6 * fs), at least 2."""
    return max(2, int(math.floor(POS_WINDOW_SECONDS * fs + 0.5)))


def pos_wang2017(rgb, l, algorithm="pos"):
    """Algorithm 1 of Wang et al. (2017), every window of l frames. rgb: 3 x N."""
    n = rgb.shape[1]
    out = np.zeros(n)
    P = np.array([[0.0, 1.0, -1.0], [-2.0, 1.0, 1.0]])
    for end in range(l - 1, n):
        m = end - l + 1
        window = rgb[:, m : end + 1]
        cn = window / window.mean(axis=1, keepdims=True)
        if algorithm == "green":
            h = cn[1] - 1.0
        else:
            s = P @ cn
            h = s[0] + (s[0].std() / s[1].std()) * s[1]
        out[m : end + 1] += h - h.mean()
    return out


def lift(path, names, namespace):
    """Executes only the top-level functions ``names`` of a Python file."""
    tree = ast.parse(Path(path).read_text())
    body = [node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name in names]
    missing = set(names) - {node.name for node in body}
    if missing:
        raise RuntimeError(f"{path}: no function {sorted(missing)}")
    exec(compile(ast.Module(body=body, type_ignores=[]), str(path), "exec"), namespace)
    return namespace


def pyvhr_pos():
    """pyVHR's cpu_POS.

    Its loop starts at n = w, so the first window (frames 0 to w - 1) is never
    added and samples before w differ from the paper. It also adds eps = 1e-9
    to the mean and to std(S2); with std(S2) near 1e-3, that moves the output
    by about 1e-6 of its size.
    """
    url = f"https://raw.githubusercontent.com/phuselab/pyVHR/{PYVHR_COMMIT}/pyVHR/BVP/methods.py"
    path = fetch(url, PYVHR_METHODS_SHA256, f"pyVHR-{PYVHR_COMMIT[:12]}-methods.py")
    return lift(path, ["cpu_POS"], {"np": np})["cpu_POS"]


def toolbox():
    """rPPG-Toolbox's POS_WANG and _calculate_fft_hr.

    POS_WANG takes ``RGB[m:n]`` for m = n - l, so its windows end one frame
    before n and the last frame is never in one; and l = ceil(1.6 * fs), the
    same as round() at every rate used here. It then
    detrends (smoothness priors, lambda 100) and band-passes (first-order
    Butterworth, 0.75-3 Hz, filtfilt). It calls ``np.mat``, which NumPy 2
    removed; ``np.asmatrix`` is the same function under its surviving name.
    """
    paths = {}
    for name, sha in TOOLBOX_FILES.items():
        url = f"https://raw.githubusercontent.com/ubicomplab/rPPG-Toolbox/{TOOLBOX_COMMIT}/{name}"
        paths[name] = fetch(url, sha, f"rPPG-Toolbox-{TOOLBOX_COMMIT[:12]}-{name.replace('/', '-')}")

    utils = types.SimpleNamespace(
        **lift(paths["unsupervised_methods/utils.py"], ["detrend"], {"np": np, "sparse": sparse})
    )
    numpy_with_mat = types.SimpleNamespace(**{k: getattr(np, k) for k in dir(np) if not k.startswith("__")})
    numpy_with_mat.mat = np.asmatrix
    pos = lift(
        paths["unsupervised_methods/methods/POS_WANG.py"],
        ["POS_WANG"],
        # The colour traces are already per-frame means: the frame averaging
        # step is the identity on them.
        {"np": numpy_with_mat, "math": math, "signal": sps, "utils": utils,
         "_process_video": lambda rgb: np.asarray(rgb, np.float64)},
    )["POS_WANG"]
    import scipy  # post_process.py reaches scipy.signal through the package

    hr = lift(
        paths["evaluation/post_process.py"],
        ["_next_power_of_2", "_calculate_fft_hr"],
        {"np": np, "scipy": scipy},
    )["_calculate_fft_hr"]
    return pos, hr


def median_rate(beats, fs):
    """rateFromPeaks: median of the instantaneous rates, 40-200 bpm."""
    if len(beats) < 2:
        return 0.0
    bpm = 60.0 / (np.diff(beats) / fs)
    bpm = bpm[(bpm >= 40.0) & (bpm <= 200.0)]
    return float(np.median(bpm)) if len(bpm) else 0.0


def build_rppg(signals):
    cpu_pos = pyvhr_pos()
    toolbox_pos, toolbox_hr = toolbox()

    cases = []
    for name in RPPG_SIGNALS:
        sig = signals[name]
        fs = sig["fs"]
        # The node receives a Float32Array; the reference starts from the
        # same float32-rounded colour.
        rgb = np.vstack([as_float32(c) for c in sig["channels"]])
        n = rgb.shape[1]
        l = window_length(fs)
        final = n - l + 1  # samples the streaming node has emitted by the end

        pyvhr = cpu_pos(rgb[None, :, :], fps=fs)[0]
        toolbox_bvp = np.asarray(toolbox_pos(rgb.T, fs), np.float64).ravel()

        beats = np.asarray(sig["truth"]["beats"])
        size, hop = int(round(HR_WINDOW_SECONDS * fs)), int(round(HR_HOP_SECONDS * fs))
        windows = []
        for start in range(0, final - size + 1, hop):
            stop = start + size
            inside = beats[(beats >= start) & (beats < stop)]
            ibis = np.diff(inside) / fs
            windows.append(
                {
                    "start": start,
                    "stop": stop,
                    "truthMedianRate": median_rate(inside, fs),
                    "truthMeanRate": float(60.0 / ibis.mean()),
                    "toolboxRate": float(
                        toolbox_hr(toolbox_bvp[start:stop], fs=fs,
                                   low_pass=TOOLBOX_HR_BAND[0], high_pass=TOOLBOX_HR_BAND[1])
                    ),
                }
            )

        cases.append(
            {
                "signal": name,
                "samplingRate": fs,
                "windowLength": l,
                "pyvhrWindowLength": int(1.6 * fs),
                "toolboxWindowLength": math.ceil(1.6 * fs),
                "pos": pos_wang2017(rgb, l).tolist(),
                "green": pos_wang2017(rgb, l, "green").tolist(),
                "pyvhr": np.asarray(pyvhr, np.float64).tolist(),
                "toolboxBvp": toolbox_bvp.tolist(),
                "truthBeats": beats.tolist(),
                "windows": windows,
            }
        )

    return {
        "reference": (
            "Definition: Wang et al. (2017) Algorithm 1 in NumPy, l = round(1.6 fs), on float32-rounded "
            "colour; 'green' is the same framing with the normalised green row. Field: pyVHR cpu_POS @ "
            f"{PYVHR_COMMIT[:12]} (raw H) and rPPG-Toolbox POS_WANG + _calculate_fft_hr "
            f"({TOOLBOX_HR_BAND[0]}-{TOOLBOX_HR_BAND[1]} Hz) @ {TOOLBOX_COMMIT[:12]}, run from the authors' code."
        ),
        "posWindowSeconds": POS_WINDOW_SECONDS,
        "hrWindowSeconds": HR_WINDOW_SECONDS,
        "hrHopSeconds": HR_HOP_SECONDS,
        "cases": cases,
    }
