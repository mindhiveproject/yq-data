# Test fixtures

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
