import { Modality, ProcessingStage } from "../../../data_stream.interface";
import {
  VisionReceiver,
  VisionAssetOptions,
  DEFAULT_WASM_PATH,
} from "./base_vision";

const DEFAULT_MODEL =
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";

/**
 * Face-oval landmark indices, used to place the region of interest.
 *
 * Only a handful are needed to bound the forehead and cheeks, so this is a
 * subset rather than the full 478-point mesh.
 */
const FOREHEAD_LANDMARKS = [10, 67, 297, 109, 338, 151];
const CHEEK_LANDMARKS = [50, 280, 234, 454, 118, 347];

export interface RPPGOptions extends VisionAssetOptions {
  /** Which facial region to average. Forehead is least affected by speech. */
  region?: "forehead" | "cheeks" | "both";
  /** Width/height of the downscaled frame used for sampling, in pixels. */
  sampleSize?: number;
}

/**
 * Remote photoplethysmography: the raw pulse-bearing signal from a camera.
 *
 * Each frame, the mean red, green and blue intensity of a facial region is
 * emitted as a three-channel sample. Cardiac pulsation modulates skin
 * reflectance by well under 1%, concentrated in the green channel where
 * haemoglobin absorbs most strongly — so the green channel is the one to
 * analyze.
 *
 * This receiver deliberately stops at the raw signal. Turning it into beats
 * per minute is ordinary time-series work, so it belongs in a pipeline where
 * the same {@link HeartRate} analyzer serves both this and a Muse PPG sensor:
 *
 * ```ts
 * nodes: [
 *   { id: "rgb",    receiver: "rppg" },
 *   { id: "green",  method: AnalysisMethod.CHANNEL_SELECTION, parameters: { indices: [1] } },
 *   { id: "window", method: AnalysisMethod.WINDOWING,         parameters: { size: 10, hop: 1 } },
 *   { id: "bpm",    method: AnalysisMethod.HEART_RATE,        parameters: { strategy: "spectral" } },
 * ]
 * ```
 *
 * Accuracy depends heavily on even lighting and a still subject; treat the
 * output as expressive rather than clinical.
 *
 * The pipeline this belongs to — facial ROI, spatial mean per colour channel,
 * detrend, bandpass, then rate estimation — follows heartbeat-js, whose
 * approach is described in Rouast et al. (2016). The downstream stages are
 * this package's own: see {@link HeartRate} for what actually estimates the
 * rate.
 *
 * Rouast, P.V., Adam, M.T.P., Cornforth, D.J., Lux, E. & Weinhardt, C. (2016).
 * Using Contactless Heart Rate Measurements for Real-Time Assessment of
 * Affective States. In Information Systems and Neuroscience, LNISO 10,
 * 157–163. https://doi.org/10.1007/978-3-319-41402-7_20
 * @see https://github.com/prouast/heartbeat-js
 *
 * The face is located with MediaPipe Face Landmarker — Lugaresi, C. et al.
 * (2019), arXiv:1906.08172.
 */
export class RPPGReceiver extends VisionReceiver {
  deviceName = "Video Heart Rate";
  deviceID: string | number;

  private landmarker: any;
  private canvas: HTMLCanvasElement | undefined;
  private context: CanvasRenderingContext2D | null = null;
  private options: Required<Pick<RPPGOptions, "region" | "sampleSize">>;
  private frameCount = 0;
  private firstFrameTime = 0;

  constructor(videoElement: HTMLVideoElement, options: RPPGOptions = {}) {
    super(videoElement, options);
    this.deviceID = "rppg";
    this.options = { region: "forehead", sampleSize: 256, ...options };
  }

  protected async createTask(vision: any): Promise<void> {
    const { FaceLandmarker, FilesetResolver } = vision;

    const resolver = await FilesetResolver.forVisionTasks(
      this.assets.wasmPath ?? DEFAULT_WASM_PATH
    );

    this.landmarker = await FaceLandmarker.createFromOptions(resolver, {
      baseOptions: {
        modelAssetPath: this.assets.modelAssetPath ?? DEFAULT_MODEL,
        delegate: this.assets.delegate,
      },
      outputFaceBlendshapes: false,
      runningMode: "VIDEO",
      numFaces: 1,
    });

    this.canvas = document.createElement("canvas");
    this.canvas.width = this.options.sampleSize;
    this.canvas.height = this.options.sampleSize;
    // Reading pixels back every frame is the dominant cost here, and
    // willReadFrequently tells the browser to keep the surface in CPU memory
    // rather than round-tripping it from the GPU each time.
    this.context = this.canvas.getContext("2d", { willReadFrequently: true });

    this.ensureStream({
      modality: Modality.VIDEO,
      processingStage: ProcessingStage.PREPROCESSED,
      name: "rppg",
      additionalMetadata: {
        samplingRate: this.assets.maxFps,
        channelInfo: [
          { index: 0, label: "red" },
          { index: 1, label: "green" },
          { index: 2, label: "blue" },
        ],
        additionalMetadata: { region: this.options.region },
      },
    });
  }

  protected closeTask(): void {
    this.landmarker?.close?.();
    this.landmarker = undefined;
    this.canvas = undefined;
    this.context = null;
    this.frameCount = 0;
  }

  protected processFrame(timestampMs: number): void {
    if (!this.landmarker || !this.context || !this.canvas) return;

    const results = this.landmarker.detectForVideo(
      this.videoElement,
      timestampMs
    );
    const landmarks = results?.faceLandmarks?.[0];
    if (!landmarks) return;

    const indices =
      this.options.region === "cheeks"
        ? CHEEK_LANDMARKS
        : this.options.region === "both"
        ? [...FOREHEAD_LANDMARKS, ...CHEEK_LANDMARKS]
        : FOREHEAD_LANDMARKS;

    const box = boundingBox(landmarks, indices);
    if (!box) return;

    const size = this.options.sampleSize;
    this.context.drawImage(this.videoElement, 0, 0, size, size);

    const x = Math.max(0, Math.floor(box.minX * size));
    const y = Math.max(0, Math.floor(box.minY * size));
    const w = Math.max(1, Math.min(size - x, Math.ceil((box.maxX - box.minX) * size)));
    const h = Math.max(1, Math.min(size - y, Math.ceil((box.maxY - box.minY) * size)));

    const { data } = this.context.getImageData(x, y, w, h);

    let red = 0;
    let green = 0;
    let blue = 0;
    const pixels = data.length / 4;
    for (let i = 0; i < data.length; i += 4) {
      red += data[i];
      green += data[i + 1];
      blue += data[i + 2];
    }

    // The measured frame rate is what downstream windowing needs; the
    // requested maxFps is only an upper bound and the camera rarely matches it.
    if (this.frameCount === 0) this.firstFrameTime = timestampMs;
    this.frameCount++;
    const elapsed = (timestampMs - this.firstFrameTime) / 1000;
    if (this.frameCount % 30 === 0 && elapsed > 0) {
      this.setSamplingRate(
        this.getStreamID(
          Modality.VIDEO,
          ProcessingStage.PREPROCESSED,
          "rppg"
        ),
        this.frameCount / elapsed
      );
    }

    this.update(
      {
        modality: Modality.VIDEO,
        processingStage: ProcessingStage.PREPROCESSED,
        name: "rppg",
      },
      [red / pixels, green / pixels, blue / pixels]
    );
  }
}

/** Alias matching the device name used by the original platform. */
export const VideoHeartRateReceiver = RPPGReceiver;

function boundingBox(
  landmarks: Array<{ x: number; y: number }>,
  indices: number[]
): { minX: number; minY: number; maxX: number; maxY: number } | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const index of indices) {
    const point = landmarks[index];
    if (!point) continue;
    if (point.x < minX) minX = point.x;
    if (point.y < minY) minY = point.y;
    if (point.x > maxX) maxX = point.x;
    if (point.y > maxY) maxY = point.y;
  }

  if (!isFinite(minX) || maxX <= minX || maxY <= minY) return null;
  return { minX, minY, maxX, maxY };
}
