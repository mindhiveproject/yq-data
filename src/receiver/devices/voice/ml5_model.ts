/**
 * Minimal inference for ml5.js-format neural networks.
 *
 * ml5 saves three files: a TensorFlow.js `model.json` topology, a flat
 * `model.weights.bin`, and a `model_meta.json` holding the per-feature min and
 * max used to normalize training data. Loading that back normally means
 * pulling in ml5 and TensorFlow.js.
 *
 * The models this package uses are small dense stacks — the voice emotion
 * classifier is 53→256→64→16→4, about 30k parameters — so the forward pass is
 * a handful of matrix multiplies. Implementing it directly keeps a whole
 * TensorFlow runtime out of an application that only wants a number out of a
 * microphone, and makes prediction synchronous, which matters when results
 * arrive in a callback from an audio worklet.
 *
 * Only the layer types these models use are supported; anything else raises
 * rather than silently mis-predicting.
 */

type Activation = "relu" | "sigmoid" | "softmax" | "linear" | "tanh";

interface DenseLayer {
  units: number;
  activation: Activation;
  /** Row-major `[inputs, units]`, so weight (i, o) sits at `i * units + o`. */
  kernel: Float32Array;
  bias: Float32Array;
  inputs: number;
}

/** A single class score, matching the shape ml5's `classify` returns. */
export interface Classification {
  label: string;
  confidence: number;
}

const SUPPORTED: Activation[] = ["relu", "sigmoid", "softmax", "linear", "tanh"];

/**
 * A loaded ml5 classifier, ready to score feature vectors.
 */
export class ML5Classifier {
  private layers: DenseLayer[] = [];
  private inputMin: Float32Array;
  private inputMax: Float32Array;
  private labels: string[];

  private constructor(
    layers: DenseLayer[],
    inputMin: Float32Array,
    inputMax: Float32Array,
    labels: string[]
  ) {
    this.layers = layers;
    this.inputMin = inputMin;
    this.inputMax = inputMax;
    this.labels = labels;
  }

  /** Number of features each input vector must carry. */
  get inputSize(): number {
    return this.inputMin.length;
  }

  /** Class labels, in output-unit order. */
  get classes(): string[] {
    return [...this.labels];
  }

  /**
   * Fetches and parses a model saved by ml5.
   *
   * @param basePath Directory containing `model.json`, `model.weights.bin`
   * and `model_meta.json`, with or without a trailing slash.
   */
  static async load(basePath: string): Promise<ML5Classifier> {
    const base = basePath.replace(/\/$/, "");

    const [topology, meta, weights] = await Promise.all([
      fetchJSON(`${base}/model.json`),
      fetchJSON(`${base}/model_meta.json`),
      fetch(`${base}/model.weights.bin`).then((response) => {
        if (!response.ok) {
          throw new Error(
            `Failed to fetch ${base}/model.weights.bin: ${response.status}`
          );
        }
        return response.arrayBuffer();
      }),
    ]);

    const specs = (topology.weightsManifest ?? []).flatMap(
      (group: any) => group.weights ?? []
    );

    // The manifest lists tensors in the order they were written, so a running
    // byte offset is enough to slice each one out of the flat buffer.
    const tensors = new Map<string, { shape: number[]; values: Float32Array }>();
    let offset = 0;
    for (const spec of specs) {
      if (spec.dtype !== "float32") {
        throw new Error(
          `Unsupported weight dtype "${spec.dtype}" for ${spec.name}; only float32 models are supported.`
        );
      }
      const count = spec.shape.reduce((a: number, b: number) => a * b, 1);
      tensors.set(spec.name, {
        shape: spec.shape,
        // Copy rather than view: the manifest does not guarantee 4-byte
        // alignment for every tensor, and a misaligned Float32Array view
        // throws.
        values: new Float32Array(weights.slice(offset, offset + count * 4)),
      });
      offset += count * 4;
    }

    const configs = topology.modelTopology?.config?.layers ?? [];
    const layers: DenseLayer[] = [];

    for (const layer of configs) {
      if (layer.class_name !== "Dense") {
        throw new Error(
          `Unsupported layer type "${layer.class_name}"; only Dense layers are supported.`
        );
      }

      const name = layer.config.name;
      const kernel = tensors.get(`${name}/kernel`);
      const bias = tensors.get(`${name}/bias`);
      if (!kernel || !bias) {
        throw new Error(`Missing weights for layer ${name}.`);
      }

      const activation = (layer.config.activation ?? "linear") as Activation;
      if (!SUPPORTED.includes(activation)) {
        throw new Error(`Unsupported activation "${activation}" in layer ${name}.`);
      }

      layers.push({
        units: kernel.shape[1],
        inputs: kernel.shape[0],
        activation,
        kernel: kernel.values,
        bias: bias.values,
      });
    }

    if (layers.length === 0) throw new Error("Model contains no dense layers.");

    // ml5 keys the normalization ranges by feature index as strings.
    const inputCount = layers[0].inputs;
    const inputMin = new Float32Array(inputCount);
    const inputMax = new Float32Array(inputCount);
    for (let i = 0; i < inputCount; i++) {
      const range = meta.inputs?.[String(i)];
      if (!range) throw new Error(`Missing normalization range for input ${i}.`);
      inputMin[i] = range.min;
      inputMax[i] = range.max;
    }

    // The output key is the training label's name, whatever it happened to be.
    const output: any = Object.values(meta.outputs ?? {})[0];
    const labels: string[] = output?.uniqueValues ?? [];
    if (labels.length !== layers[layers.length - 1].units) {
      throw new Error(
        `Model has ${layers[layers.length - 1].units} outputs but metadata lists ${labels.length} classes.`
      );
    }

    return new ML5Classifier(layers, inputMin, inputMax, labels);
  }

  /**
   * Scores one feature vector.
   *
   * Returns a confidence per class in the model's own label order — not
   * sorted by confidence the way ml5's `classify` returns it, because a
   * stable order is what lets these map onto fixed channel indices.
   */
  classify(features: ArrayLike<number>): Classification[] {
    if (features.length !== this.inputSize) {
      throw new Error(
        `Expected ${this.inputSize} features, received ${features.length}.`
      );
    }

    let activations = new Float32Array(this.inputSize);
    for (let i = 0; i < this.inputSize; i++) {
      const span = this.inputMax[i] - this.inputMin[i];
      // A feature that never varied in training normalizes to 0, matching
      // ml5, rather than dividing by zero.
      activations[i] = span === 0 ? 0 : (features[i] - this.inputMin[i]) / span;
    }

    for (const layer of this.layers) {
      activations = forward(layer, activations);
    }

    return this.labels.map((label, index) => ({
      label,
      confidence: activations[index],
    }));
  }
}

function forward(layer: DenseLayer, input: Float32Array): Float32Array {
  const output = new Float32Array(layer.units);

  // TensorFlow.js stores dense kernels row-major as [inputs, units], so the
  // stride between weights of one output unit is `units`, not 1.
  for (let unit = 0; unit < layer.units; unit++) {
    let sum = layer.bias[unit];
    for (let i = 0; i < layer.inputs; i++) {
      sum += input[i] * layer.kernel[i * layer.units + unit];
    }
    output[unit] = sum;
  }

  switch (layer.activation) {
    case "relu":
      for (let i = 0; i < output.length; i++) {
        if (output[i] < 0) output[i] = 0;
      }
      return output;
    case "sigmoid":
      for (let i = 0; i < output.length; i++) {
        output[i] = 1 / (1 + Math.exp(-output[i]));
      }
      return output;
    case "tanh":
      for (let i = 0; i < output.length; i++) {
        output[i] = Math.tanh(output[i]);
      }
      return output;
    case "softmax": {
      // Subtracting the max before exponentiating keeps large logits finite.
      let max = -Infinity;
      for (let i = 0; i < output.length; i++) {
        if (output[i] > max) max = output[i];
      }
      let total = 0;
      for (let i = 0; i < output.length; i++) {
        output[i] = Math.exp(output[i] - max);
        total += output[i];
      }
      for (let i = 0; i < output.length; i++) output[i] /= total;
      return output;
    }
    default:
      return output;
  }
}

async function fetchJSON(url: string): Promise<any> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status}`);
  }
  return response.json();
}
