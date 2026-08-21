/**
 * Correctness checks for the hand-written ml5 model inference.
 *
 * `ML5Classifier` reimplements what ml5.js and TensorFlow.js would do, so the
 * question worth answering is not "does it produce numbers" but "does it
 * produce the *same* numbers". These tests load the real voice-emotion model
 * with TensorFlow.js — the copy bundled inside `@vladmandic/face-api` — and
 * compare predictions element by element.
 */
import { readFileSync } from "fs";
import { join } from "path";
import { ML5Classifier } from "../../src";

const MODEL_DIR = join(__dirname, "../../models/voice-emotion");

const golden: {
  classes: string[];
  cases: { features: number[]; expected: number[] }[];
} = JSON.parse(
  readFileSync(join(__dirname, "fixtures/voice_emotion_golden.json"), "utf8")
);

/**
 * Serves the model directory over a stubbed `fetch`.
 *
 * `ML5Classifier.load` is written for the browser and takes a URL; in Node
 * there is nothing to serve the files, so requests are answered from disk.
 */
function stubFetch(): void {
  (global as any).fetch = async (url: string) => {
    const file = join(MODEL_DIR, url.split("/").pop() as string);
    const buffer = readFileSync(file);
    return {
      ok: true,
      status: 200,
      json: async () => JSON.parse(buffer.toString("utf8")),
      arrayBuffer: async () =>
        buffer.buffer.slice(
          buffer.byteOffset,
          buffer.byteOffset + buffer.byteLength
        ),
    };
  };
}

describe("ML5Classifier", () => {
  let classifier: ML5Classifier;

  beforeAll(async () => {
    stubFetch();
    classifier = await ML5Classifier.load("https://example.test/voice-emotion");
  });

  it("reads the model's shape and labels from its metadata", () => {
    expect(classifier.inputSize).toBe(53);
    expect(classifier.classes).toEqual(["N", "A", "S", "H"]);
  });

  it("produces a probability distribution", () => {
    const features = Array.from({ length: 53 }, (_, i) => i * 1.5);
    const scores = classifier.classify(features);

    expect(scores).toHaveLength(4);
    const total = scores.reduce((sum, s) => sum + s.confidence, 0);
    expect(total).toBeCloseTo(1, 5);
    for (const score of scores) {
      expect(score.confidence).toBeGreaterThanOrEqual(0);
      expect(score.confidence).toBeLessThanOrEqual(1);
    }
  });

  it("returns classes in metadata order, not sorted by confidence", () => {
    // ml5's own `classify` sorts by confidence; this one must not, because
    // channel indices are bound to positions.
    const features = Array.from({ length: 53 }, () => Math.random() * 100);
    expect(classifier.classify(features).map((s) => s.label)).toEqual([
      "N",
      "A",
      "S",
      "H",
    ]);
  });

  it("rejects a feature vector of the wrong length", () => {
    expect(() => classifier.classify(new Array(52).fill(0))).toThrow(
      /Expected 53 features/
    );
  });

  it("matches TensorFlow.js on the real voice-emotion model", () => {
    // The fixture holds outputs TensorFlow.js produced for this exact model,
    // so this is the test that would actually catch a wrong kernel layout, a
    // missed activation, or a normalization that drifted — the failure modes
    // that otherwise still yield plausible-looking probabilities. Regenerate
    // it with `tests/unit/fixtures/README.md` if the model ever changes.
    expect(golden.classes).toEqual(classifier.classes);

    for (const { features, expected } of golden.cases) {
      const actual = classifier.classify(features).map((s) => s.confidence);
      for (let c = 0; c < expected.length; c++) {
        expect(actual[c]).toBeCloseTo(expected[c], 6);
      }
    }
  });
});
