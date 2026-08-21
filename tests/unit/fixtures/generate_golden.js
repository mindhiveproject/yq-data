const tf = require('@tensorflow/tfjs');
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '../../../models/voice-emotion');
const topology = JSON.parse(fs.readFileSync(path.join(DIR, 'model.json'), 'utf8'));
const meta = JSON.parse(fs.readFileSync(path.join(DIR, 'model_meta.json'), 'utf8'));
const bin = fs.readFileSync(path.join(DIR, 'model.weights.bin'));

// Deterministic LCG, mirrored in the test so both sides build identical inputs.
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

(async () => {
  const model = await tf.loadLayersModel(tf.io.fromMemory({
    modelTopology: topology.modelTopology,
    weightSpecs: topology.weightsManifest.flatMap(g => g.weights),
    weightData: bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength),
  }));

  const rand = lcg(20240820);
  const cases = [];

  for (let trial = 0; trial < 8; trial++) {
    const features = [];
    const normalized = [];
    for (let i = 0; i < 53; i++) {
      const { min, max } = meta.inputs[String(i)];
      const u = rand();
      const value = min + u * (max - min);
      features.push(value);
      normalized.push(max === min ? 0 : (value - min) / (max - min));
    }
    const out = Array.from(model.predict(tf.tensor2d([normalized])).dataSync());
    cases.push({ features, expected: out });
  }

  fs.writeFileSync(
    path.join(__dirname, 'voice_emotion_golden.json'),
    JSON.stringify({
      generatedBy: "@tensorflow/tfjs " + tf.version.tfjs,
      model: "models/voice-emotion",
      classes: Object.values(meta.outputs)[0].uniqueValues,
      cases,
    }, null, 2) + "\n"
  );
  console.log('wrote', cases.length, 'cases; first expected =', cases[0].expected);
})();
