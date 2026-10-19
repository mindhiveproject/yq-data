"""Helpers shared by the golden-value reference generators."""

import json
import platform
import re

import numpy as np


def versions():
    """Library versions the fixtures were produced with."""
    out = {"python": platform.python_version(), "numpy": np.__version__}
    for module in ("scipy", "neurokit2", "yasa"):
        try:
            out[module] = __import__(module).__version__
        except ModuleNotFoundError:
            pass
    return out


def as_float32(x):
    """Round-trip through float32 -- the width the analyzer's deinterleave() uses.

    Analyzer classes never see the raw float64 samples: the pipeline hands them
    a ``Float32Array``. Computing the reference over float32-rounded input keeps
    that quantisation out of the tolerance budget.
    """
    return np.asarray(x, np.float32).astype(np.float64)


def next_pow2(n):
    """Mirror of fft.ts `nextPowerOfTwo`."""
    return 1 if n < 1 else int(2 ** np.ceil(np.log2(n)))


def floats(x):
    """A NumPy array (or scalar) as plain JSON-ready floats."""
    a = np.asarray(x, np.float64)
    return a.tolist()


_NUMBER_LIST = re.compile(r"\[\s*(-?[\d.eE+\-]+(?:,\s*-?[\d.eE+\-]+)*)\s*\]")


def dump(path, doc):
    """Write JSON with structure indented but numeric arrays kept on one line.

    One-number-per-line output would turn a 7680-sample array into 7680 lines;
    keeping arrays on a line keeps the fixtures diffable at the structure level
    and an order of magnitude shorter.
    """
    text = json.dumps(doc, indent=2)
    text = _NUMBER_LIST.sub(
        lambda m: "[" + ", ".join(s.strip() for s in m.group(1).split(",")) + "]",
        text,
    )
    path.write_text(text + "\n")
