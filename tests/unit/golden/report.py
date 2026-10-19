"""Build the visual golden-value report.

    npm run golden:report        # runs the suite, then this script
    # or by hand:
    GOLDEN_REPORT=1 npx jest tests/unit/golden --json --outputFile=tests/unit/golden/report/results.json
    GOLDEN_STRICT=1 npx jest tests/unit/golden --json --outputFile=tests/unit/golden/report/strict.json
    python tests/unit/golden/report.py

The report is generic over what the suites declare; nothing here names a
method. A test puts a figure in the report with ``rec.compare({...})`` (see
``harness.ts``), and this script:

* draws every declared figure, grouped by its ``group``;
* computes the error figures itself, from the series, so a caption can never
  state a number that is no longer true;
* lists every test the suite marks ``[divergence]`` with the gap measured by a
  ``GOLDEN_STRICT=1`` run (the divergence tests fail there, and their failure
  message is the gap);
* tallies passing / failing / known-gap tests per suite from Jest's own JSON.

Standard library only.
"""

import datetime
import json
import math
import re
import sys
from pathlib import Path

HERE = Path(__file__).parent
FIXTURES = HERE / "fixtures"
REPORT = HERE / "report"
MEASURED = REPORT / "measured"
OUT = REPORT / "index.html"
TEMPLATE = HERE / "report_template.html"

ANSI = re.compile(r"\x1b\[[0-9;]*m")

# Colour per series, by role, in order of appearance: an index into the
# template's --s1..--s5 tokens, so a second series of one role stays distinct.
ROLE_COLOURS = {
    "package": [1, 4],
    "reference": [2, 5],
    "field": [3, 5],
    "truth": [3, 5],
}


def load(path):
    return json.loads(path.read_text())


def rms(values):
    return math.sqrt(sum(v * v for v in values) / len(values)) if values else 0.0


def provenance():
    """Library versions across every fixture, e.g. {'scipy': '1.14.1'}."""
    merged = {}
    for path in sorted(FIXTURES.glob("*.json")):
        if path.name.startswith("_"):
            continue
        for lib, version in load(path).get("generatedBy", {}).items():
            merged.setdefault(lib, [])
            if version not in merged[lib]:
                merged[lib].append(version)
    return {lib: " / ".join(versions) for lib, versions in merged.items()}


def series_x(figure, series):
    if series.get("x") is not None:
        return series["x"]
    if figure["kind"] == "bars":
        return figure["categories"]
    return figure.get("x") or list(range(len(series["values"])))


def figure_stats(figure):
    """Error of each package series against every non-package series."""
    package = [s for s in figure["series"] if s["role"] == "package"]
    others = [s for s in figure["series"] if s["role"] != "package"]
    pairs = []
    for mine in package:
        for ref in others:
            if len(mine["values"]) != len(ref["values"]):
                continue
            diff = [abs(a - b) for a, b in zip(mine["values"], ref["values"])]
            worst = max(range(len(diff)), key=diff.__getitem__)
            span = max(abs(v) for v in ref["values"]) or 1.0
            pairs.append(
                {
                    "package": mine["name"],
                    "against": ref["name"],
                    "maxAbs": diff[worst],
                    "rms": rms(diff),
                    # Relative to the reference's own range, so a figure in dB
                    # and one in bpm are comparable.
                    "relMax": diff[worst] / span,
                    "worstAt": series_x(figure, mine)[worst],
                }
            )
    return pairs


def check_claim(figure, pairs):
    """Compare what the test says (match / diverges) with what the data shows."""
    if not pairs:
        return None
    worst = max(p["relMax"] for p in pairs)
    best = min(p["relMax"] for p in pairs)
    tolerance = figure.get("tolerance", 1e-3)
    if figure["expect"] == "match" and worst > tolerance:
        return (
            f"declared as matching within {tolerance:g} of the reference range, "
            f"but the largest error is {worst:.2g}"
        )
    if figure["expect"] == "diverges" and best < 1e-6:
        return "declared as a divergence, but the package agrees with a reference here"
    return None


def prepare_figure(suite, figure):
    seen = {}
    for s in figure["series"]:
        slot = seen.get(s["role"], 0)
        seen[s["role"]] = slot + 1
        choices = ROLE_COLOURS.get(s["role"], [1])
        s["colour"] = f"var(--s{choices[min(slot, len(choices) - 1)]})"
    pairs = figure_stats(figure)
    return {
        **figure,
        "suite": suite,
        "stats": pairs,
        "flag": check_claim(figure, pairs),
    }


def gap_message(messages):
    """The assertion text of a failed test, without the code frame."""
    text = ANSI.sub("", messages[0]) if messages else ""
    lines = []
    for line in text.splitlines():
        if re.match(r"\s+at |^\s*>?\s*\d+ \|", line):
            break
        if line.strip():
            lines.append(line.strip())
    return re.sub(r"^Error: ", "", " ".join(lines))[:420]


def test_records(results_path, strict_path):
    """Per-test status from Jest's JSON, with the strict run's gap messages."""
    results = load(results_path)
    strict = {}
    if strict_path.exists():
        for file in load(strict_path)["testResults"]:
            for t in file["assertionResults"]:
                if t["status"] == "failed":
                    strict[(file["name"], t["fullName"])] = gap_message(t["failureMessages"])

    suites, divergences, failing = {}, [], []
    for file in results["testResults"]:
        name = Path(file["name"]).name.replace(".test.ts", "")
        row = suites.setdefault(
            name, {"name": name, "tests": 0, "passed": 0, "failed": 0, "gaps": 0}
        )
        for t in file["assertionResults"]:
            is_gap = "[divergence]" in t["title"]
            row["tests"] += 1
            if t["status"] == "passed":
                row["passed"] += 1
                if is_gap:
                    row["gaps"] += 1
                    divergences.append(
                        {
                            "suite": name,
                            "where": " › ".join(t["ancestorTitles"]),
                            "title": t["title"].replace("[divergence] ", ""),
                            "gap": strict.get((file["name"], t["fullName"])),
                        }
                    )
            elif t["status"] == "failed":
                row["failed"] += 1
                failing.append({"suite": name, "title": t["fullName"]})
    return sorted(suites.values(), key=lambda r: r["name"]), divergences, failing, bool(strict)


def build_data():
    if not MEASURED.exists() or not (REPORT / "results.json").exists():
        sys.exit(
            "no measured outputs; run `npm run golden:report` (or the GOLDEN_REPORT=1 "
            "jest command in this file's docstring) first"
        )

    groups = {}
    for path in sorted(MEASURED.glob("*.json")):
        for figure in load(path).get("comparisons", []):
            figure = prepare_figure(path.stem, figure)
            groups.setdefault(figure["group"], []).append(figure)

    suites, divergences, failing, strict_ran = test_records(
        REPORT / "results.json", REPORT / "strict.json"
    )
    return {
        "date": datetime.date.today().isoformat(),
        "provenance": provenance(),
        "summary": {
            "tests": sum(s["tests"] for s in suites),
            "passed": sum(s["passed"] for s in suites),
            "failed": sum(s["failed"] for s in suites),
            "gaps": sum(s["gaps"] for s in suites),
            "figures": sum(len(f) for f in groups.values()),
        },
        "suites": suites,
        "divergences": divergences,
        "strictRan": strict_ran,
        "failing": failing,
        "groups": [{"name": name, "figures": figs} for name, figs in groups.items()],
    }


def main():
    data = build_data()
    html = TEMPLATE.read_text().replace(
        "/*__DATA__*/null", json.dumps(data, separators=(",", ":"))
    )
    OUT.parent.mkdir(exist_ok=True)
    OUT.write_text(html)
    print(
        f"wrote {OUT.relative_to(HERE.parent.parent.parent)} "
        f"({data['summary']['figures']} figures, {data['summary']['gaps']} known gaps)"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
