# Test fixtures

## `muse_athena_p1041.csv`, `muse_athena_p1035.csv`

Raw Bluetooth notifications from a Muse S Athena, one per line as hex. These are
the `test/log_p1041.csv` capture and the first 149 notifications of
`test/log_p1035.csv` from [muse-jsx](https://github.com/fuji3to4/muse-jsx), used
under its MIT license: Copyright 2025 Satoshi Fujii and the original authors and
contributors of urish/muse-js.

The p1041 capture includes `0x88` status packets, the battery packet of newer
firmware. The firmware version of the recording is not known.

## `voice_emotion_golden.json`

Reference outputs for `models/voice-emotion`, produced by TensorFlow.js 4.22.0
— the runtime ml5.js itself would use. `ML5Classifier` reimplements that
forward pass by hand to keep TensorFlow out of the package, and this fixture is
what proves the reimplementation agrees.

Feature vectors are drawn from a seeded LCG so the fixture is reproducible, and
each one lies inside the model's own training range so the normalization path
is exercised the way real input would exercise it.

Regenerate only when the model itself changes:

```bash
npm install --no-save @tensorflow/tfjs@4.22.0
node tests/unit/fixtures/generate_golden.js
```
