# Golden-value suite

Checks that the package's DSP produces the **same numbers** as the reference
libraries the field already trusts — NumPy and SciPy now, MNE once an
EEG-specific method needs it.

The reference values are computed **offline in Python** and committed as JSON.
Jest never runs Python: it loads the fixtures and compares. Nothing here ships
in the npm package — `package.json` publishes `dist/` only, so this whole
directory is repo-only.

## Layout

| File | Role |
| --- | --- |
| `inputs.py` | The signal registry — every input defined once. |
| `generate.py` | Runs the reference calls, writes the fixtures. |
| `fixtures/_inputs.json` | The signals, serialised. **Generated — do not hand-edit.** |
| `fixtures/rms.json` | RMS reference values, one entry per signal. |
| `allclose.ts` | `toBeAllClose` — a `numpy.allclose`-style Jest matcher. |
| `*.test.ts` | The golden tests. Picked up by the normal `npm test`. |

## Running the tests

Nothing special — the fixtures are committed:

```bash
npm test
```

## Regenerating the fixtures

Only needed when a signal changes, a method's reference call changes, or you
bump the Python libraries.

With conda (see the note below):

```bash
conda env create -f tests/unit/golden/environment.yml   # first time only
conda activate yq-golden
python tests/unit/golden/generate.py
```

With a plain virtualenv:

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r tests/unit/golden/requirements.txt
python tests/unit/golden/generate.py
```

Then review the JSON diff and commit it. Each fixture records the exact
`python` / `numpy` / `scipy` versions it was produced with under `generatedBy`.

## Adding a method

1. Pick the reference call and its exact parameters (NumPy / SciPy / MNE) and
   write the convention it fixes — scaling, `ddof`, one- vs two-sided, window,
   detrend default — into the method's doc comment.
2. Add or reuse a signal in `inputs.py`.
3. In `generate.py`, compute the reference for that signal and write a new
   `fixtures/<method>.json`.
4. Regenerate; commit the fixture.
5. Add `<method>.test.ts` following `rms.test.ts`: `describe.each` over the
   cases, one tolerance per assertion with a comment saying *why* that value.
6. Start the tolerance loose (`rtol 1e-3`), then tighten. If it won't tighten,
   you've found a convention mismatch — document it rather than widening the
   tolerance to hide it.

## Tolerance notes

- **Pure `methods/` functions** operate in float64. Against NumPy the only
  difference is summation order; `rtol` around `1e-11` is realistic.
- **Analyzer classes** receive a `Float32Array` and emit one. The reference is
  computed over float32-rounded input and the comparison can assert about six
  significant digits (`rtol 1e-6`), no more.
- FFT-based methods added later will not be bit-identical to SciPy's pocketfft;
  test the FFT primitive on its own with a modest tolerance first, then higher
  methods can lean on it.

## Requirements

- **Node / Jest**: already covered by the repo's `devDependencies`; the tests
  run under the existing `jest.config.ts`.
- **Python** (regeneration only): 3.12, `numpy` 2.1, `scipy` 1.14 — pinned in
  `environment.yml` and `requirements.txt`. `mne` is intentionally not a
  dependency yet; it will be added alongside the first method that needs it.
- The pins are compatible-release (`~=`), not exact. RMS is version-invariant;
  when a method's golden values turn out to move between library versions,
  tighten that method's pin and note it here.
- On your machine you can manage the Python side with conda (`environment.yml`
  creates the `yq-golden` env) or any virtualenv tool — the generator only
  imports `numpy` and, later, `scipy` / `mne`.
