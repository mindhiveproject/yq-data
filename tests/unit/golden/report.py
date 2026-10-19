"""Build the visual golden-value comparison report.

    GOLDEN_REPORT=1 npx jest tests/unit/golden   # records package outputs
    python tests/unit/golden/report.py           # writes report/index.html

Reads the committed fixtures (what the references compute) and the measured
package outputs the tests wrote to ``report/measured/``, then writes one
self-contained HTML page charting the largest divergences.
Standard library only.
"""

import json
import math
import sys
from pathlib import Path

HERE = Path(__file__).parent
FIXTURES = HERE / "fixtures"
MEASURED = HERE / "report" / "measured"
OUT = HERE / "report" / "index.html"


def load(path):
    return json.loads(path.read_text())


def db(x):
    return 20 * math.log10(max(x, 1e-12))


def build_data():
    inputs = load(FIXTURES / "_inputs.json")["signals"]
    measured = {p.stem: load(p) for p in MEASURED.glob("*.json")}
    missing = {"filter", "band_power", "cardiac", "windowing"} - set(measured)
    if missing:
        sys.exit(
            f"missing measured outputs for {sorted(missing)}; run "
            "GOLDEN_REPORT=1 npx jest tests/unit/golden first"
        )

    # Band filter responses: package vs scipy.signal.butter.
    design = load(FIXTURES / "filter_design.json")
    titles = {
        "bandpass_1_40_256_o4": "Filtering default, 1–40 Hz @ 256 Hz",
        "bandpass_8_12_256_o4": "Alpha 8–12 Hz @ 256 Hz",
        "bandpass_hr_64_o4": "HeartRate pulse band @ 64 Hz",
        "bandstop_58_62_256_o2": "60 Hz notch @ 256 Hz",
    }
    filters = []
    for case in design["cases"]:
        if case["id"] not in titles:
            continue
        pkg = measured["filter"][f"design:{case['id']}"]
        filters.append(
            {
                "title": titles[case["id"]],
                "cutoff": case["cutoff"],
                "package": [[f, db(m)] for f, m in zip(case["frequencies"], pkg)],
                "reference": [
                    [f, db(m)] for f, m in zip(case["frequencies"], case["magnitude"])
                ],
            }
        )

    # Zero-phase edges on the raw-sensor-like PPG.
    ff = load(FIXTURES / "filtfilt.json")
    case = next(c for c in ff["cases"] if "offset" in c["id"])
    fs = inputs[case["signal"]]["fs"]
    pkg = measured["filter"][f"filtfilt:{case['id']}"]
    n = len(pkg)
    span = int(2 * fs)
    edges = []
    for label, lo, hi in [("First 2 s", 0, span), ("Last 2 s", n - span, n)]:
        edges.append(
            {
                "title": label,
                "package": [[i / fs, pkg[i]] for i in range(lo, hi)],
                "reference": [[i / fs, case["scipy"][i]] for i in range(lo, hi)],
            }
        )

    # Relative band power: default, psd + sum, YASA.
    bp = load(FIXTURES / "band_power.json")
    case = next(c for c in bp["cases"] if c["signal"] == "eeg_muse_4s")
    m = measured["band_power"]
    band_power = {
        "bands": list(case["bands"]),
        "series": [
            {"name": "Package default", "values": m["yasaCompare:eeg_muse_4s:default"]},
            {"name": "Package psd + sum", "values": m["yasaCompare:eeg_muse_4s:hamming"]},
            {"name": "YASA bandpower", "values": case["yasa"]["relativeChannelAverage"]},
        ],
    }

    # SDNN per window: package vs the true beats.
    labels = {
        "ppg_muse_60bpm": "PPG 60",
        "ppg_muse_75bpm_offset": "PPG 75",
        "ppg_muse_110bpm_noisy": "PPG 110",
        "rppg_camera_72bpm": "rPPG 72",
    }
    sdnn = {"windows": [], "package": [], "truth": []}
    for key, value in measured["cardiac"].items():
        if not key.startswith("sdnn:"):
            continue
        _, signal, start = key.split(":")
        fs = inputs[signal]["fs"]
        sdnn["windows"].append(f"{labels[signal]} · {int(start) / fs:.0f} s")
        sdnn["package"].append(value["package"])
        sdnn["truth"].append(value["truth"])

    # Windowing backlog over a minute of Muse packets, replaying the node's
    # rule (at most one window per packet) against plain framing.
    size, hop, packet, fs = 512, 10, 12, 256.0
    buffered, emitted, received, lag = 0, 0, 0, []
    for k in range(int(60 * fs / packet)):
        buffered += packet
        received += packet
        if buffered >= size:
            emitted += 1
            buffered -= hop
        expected = max(0, (received - size) // hop + 1)
        lag.append([received / fs, (expected - emitted) * hop / fs])
    frames = next(iter(measured["windowing"].values()))

    generated = load(FIXTURES / "rms.json")["generatedBy"]

    return {
        "filters": filters,
        "edges": edges,
        "bandPower": band_power,
        "sdnn": sdnn,
        "lag": lag[::4],
        "frames": frames,
        "generatedBy": generated,
    }


TEMPLATE = Path(__file__).with_name("report_template.html")


def main():
    data = build_data()
    html = TEMPLATE.read_text().replace(
        "/*__DATA__*/null", json.dumps(data, separators=(",", ":"))
    )
    OUT.parent.mkdir(exist_ok=True)
    OUT.write_text(html)
    print(f"wrote {OUT.relative_to(HERE.parent.parent.parent)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
