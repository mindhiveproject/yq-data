import { Modality, ProcessingStage } from "../../../data_stream.interface";
import { VisionReceiver, VisionAssetOptions } from "./base_vision";

/**
 * Where face-api's weight files are fetched from.
 *
 * The maintained fork ships its models inside the npm package, so jsDelivr
 * serves them without the consuming app having to copy anything into its own
 * `public/` directory — which is exactly what the old platform had to do.
 */
export const DEFAULT_FACE_API_MODELS =
  "https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.15/model";

/**
 * Expression labels in a fixed order.
 *
 * face-api returns them as an object, and object key order is not something
 * to bind a channel index to. Listing them explicitly means channel 3 is
 * "angry" forever, regardless of what the library does internally.
 */
const EXPRESSIONS = [
  "neutral",
  "happy",
  "sad",
  "angry",
  "fearful",
  "disgusted",
  "surprised",
] as const;

export interface FaceEmotionOptions extends VisionAssetOptions {
  /** Directory holding the face-api weight files. */
  modelPath?: string;
  /**
   * Face detector to run before expression classification.
   *
   * `tiny` is a 190 KB network that comfortably keeps up with a camera;
   * `ssd` is the 5.4 MB SSD-MobileNet the original app used, more accurate on
   * small or partially occluded faces and considerably slower. The detector
   * only decides *where* the face is — expression scores come from the same
   * network either way.
   */
  detector?: "tiny" | "ssd";
  /** Minimum detection score for a face to be reported. */
  minConfidence?: number;
  /** Faces to track. Each gets its own stream. */
  numFaces?: number;
  /** Also emit estimated age and gender. Costs an extra model download. */
  emitAgeGender?: boolean;
}

/**
 * Facial emotion recognition via face-api's expression network.
 *
 * Emits seven expression probabilities per tracked face — neutral, happy,
 * sad, angry, fearful, disgusted, surprised — summing to 1. This is the
 * signal the old platform's Video Emotion device produced, and the channel
 * labels match the keys it dispatched.
 *
 * Like the other camera receivers it reads pixels from an `HTMLVideoElement`
 * that a {@link VideoReceiver} owns, so it can run alongside
 * {@link FaceLandmarkReceiver} and {@link RPPGReceiver} on one camera.
 *
 * `@vladmandic/face-api` is an *optional* peer dependency — it carries a
 * TensorFlow.js runtime that an EEG-only application should never download —
 * so it is imported dynamically on `connect()`.
 *
 * ```ts
 * const camera = new VideoReceiver(videoElement);
 * await camera.connect();
 * await camera.startStream();
 *
 * const emotion = new FaceEmotionReceiver(videoElement, { maxFps: 10 });
 * await emotion.connect();
 * emotion.startStream();
 * ```
 *
 * Expression networks are trained on posed, frontal, well-lit faces. Treat
 * the output as expressive rather than diagnostic.
 *
 * The detector and the expression network are face-api.js, originally by
 * Vincent Mühler (https://github.com/justadudewhohacks/face-api.js); this uses
 * the maintained `@vladmandic` fork, which tracks current TensorFlow.js.
 */
export class FaceEmotionReceiver extends VisionReceiver {
  deviceName = "Face Emotion";
  deviceID: string | number;

  private faceapi: any;
  private detectorOptions: any;
  private options: Required<
    Pick<
      FaceEmotionOptions,
      "modelPath" | "detector" | "minConfidence" | "numFaces" | "emitAgeGender"
    >
  >;

  /**
   * Guards against overlapping inference.
   *
   * face-api's detection is asynchronous, but the base class's frame loop is
   * not — without this, a camera running faster than the network would queue
   * up detections until the tab stalls.
   */
  private busy = false;

  constructor(videoElement: HTMLVideoElement, options: FaceEmotionOptions = {}) {
    // A detector plus two classifier passes is far heavier than a MediaPipe
    // graph, so this defaults to half the base class's frame budget.
    super(videoElement, { ...options, maxFps: options.maxFps ?? 15 });
    this.deviceID = "face-emotion";
    this.options = {
      detector: "tiny",
      minConfidence: 0.5,
      numFaces: 1,
      emitAgeGender: false,
      ...options,
      modelPath:
        options.modelPath ?? options.modelAssetPath ?? DEFAULT_FACE_API_MODELS,
    };
  }

  /** Loads face-api rather than the MediaPipe runtime the base class expects. */
  protected async loadVisionModule(): Promise<any> {
    try {
      return await import("@vladmandic/face-api");
    } catch (error) {
      throw new Error(
        "@vladmandic/face-api is required for FaceEmotionReceiver. " +
          "Install it alongside yq-data: npm install @vladmandic/face-api"
      );
    }
  }

  protected async createTask(vision: any): Promise<void> {
    this.faceapi = vision.nets ? vision : vision.default;
    const { nets } = this.faceapi;
    const path = this.options.modelPath;

    const detectorNet =
      this.options.detector === "ssd" ? nets.ssdMobilenetv1 : nets.tinyFaceDetector;

    await Promise.all([
      detectorNet.loadFromUri(path),
      nets.faceLandmark68Net.loadFromUri(path),
      nets.faceExpressionNet.loadFromUri(path),
      ...(this.options.emitAgeGender ? [nets.ageGenderNet.loadFromUri(path)] : []),
    ]);

    this.detectorOptions =
      this.options.detector === "ssd"
        ? new this.faceapi.SsdMobilenetv1Options({
            minConfidence: this.options.minConfidence,
          })
        : new this.faceapi.TinyFaceDetectorOptions({
            scoreThreshold: this.options.minConfidence,
          });

    // Expression labels are fixed, so unlike the blendshape streams these can
    // be registered up front rather than on the first result.
    for (let face = 0; face < this.options.numFaces; face++) {
      this.registerStreams(face);
    }
  }

  protected closeTask(): void {
    this.faceapi = undefined;
    this.detectorOptions = undefined;
    this.busy = false;
  }

  private faceSuffix(face: number): string | undefined {
    return this.options.numFaces > 1 ? `face_${face + 1}` : undefined;
  }

  private nameFor(base: string, face: number): string {
    const suffix = this.faceSuffix(face);
    return suffix ? `${base}_${suffix}` : base;
  }

  private registerStreams(face: number): void {
    this.initializeStream({
      modality: Modality.VIDEO,
      processingStage: ProcessingStage.INFERRED,
      name: this.nameFor("expressions", face),
      additionalMetadata: {
        samplingRate: this.assets.maxFps,
        channelInfo: EXPRESSIONS.map((label, index) => ({ index, label })),
      },
    });

    if (this.options.emitAgeGender) {
      this.initializeStream({
        modality: Modality.VIDEO,
        processingStage: ProcessingStage.INFERRED,
        name: this.nameFor("age_gender", face),
        additionalMetadata: {
          samplingRate: this.assets.maxFps,
          channelInfo: [
            { index: 0, label: "age", unit: "years" },
            { index: 1, label: "male_probability" },
          ],
        },
      });
    }
  }

  protected processFrame(): void {
    if (!this.faceapi || this.busy) return;
    this.busy = true;
    this.detect()
      .catch((error) => console.error(`${this.deviceName} inference failed:`, error))
      .finally(() => {
        this.busy = false;
      });
  }

  private async detect(): Promise<void> {
    // The whole chain has to be built before the first await — face-api's
    // task objects are lazily composed, and awaiting the detector alone
    // discards the landmark and expression stages.
    let task = this.faceapi
      .detectAllFaces(this.videoElement, this.detectorOptions)
      .withFaceLandmarks()
      .withFaceExpressions();

    if (this.options.emitAgeGender) task = task.withAgeAndGender();

    const results = await task;
    if (!results || results.length === 0) return;

    const faces = Math.min(results.length, this.options.numFaces);

    for (let face = 0; face < faces; face++) {
      const result = results[face];
      const expressions = result?.expressions;
      if (!expressions) continue;

      this.update(
        {
          modality: Modality.VIDEO,
          processingStage: ProcessingStage.INFERRED,
          name: this.nameFor("expressions", face),
        },
        EXPRESSIONS.map((label) => expressions[label] ?? 0)
      );

      if (this.options.emitAgeGender && result.age !== undefined) {
        // face-api reports the winning label plus its confidence; a single
        // probability is more useful downstream than a string and a number
        // that means different things depending on the string.
        const maleProbability =
          result.gender === "male"
            ? result.genderProbability
            : 1 - result.genderProbability;

        this.update(
          {
            modality: Modality.VIDEO,
            processingStage: ProcessingStage.INFERRED,
            name: this.nameFor("age_gender", face),
          },
          [result.age, maleProbability]
        );
      }
    }
  }
}
