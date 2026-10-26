import { ChannelInfo, Modality } from "../../../data_stream.interface";
import { BaseReceiver } from "../../base_receiver";

/** Where the MediaPipe wasm runtime and model files are fetched from. */
export interface VisionAssetOptions {
  /** Directory containing the tasks-vision wasm bundle. */
  wasmPath?: string;
  /** URL of the `.task` model file. */
  modelAssetPath?: string;
  /**
   * GPU is much faster, and the default. It needs WebGL: where that is missing
   * (some locked-down or virtualised machines) `connect()` fails, and the
   * receiver must be built with `"CPU"` instead. Nothing falls back by itself.
   */
  delegate?: "GPU" | "CPU";
  /**
   * Target inference rate. Frames arriving faster than this are skipped; a
   * camera running at exactly this rate keeps every frame.
   */
  maxFps?: number;
}

export const DEFAULT_WASM_PATH =
  "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.3/wasm";

/** A landmark in 0–1 coordinates of the video frame, x right and y down. */
export interface NormalizedPoint {
  x: number;
  y: number;
  z?: number;
}

/** One frame a face tracker processed, as it hands it to in-page listeners. */
export interface FaceFrame {
  /** When the frame was processed, from `performance.now()`, in ms. */
  timestampMs: number;
  /** Landmarks of each face found, in the tracker's order. Empty when none was. */
  faces: ReadonlyArray<ReadonlyArray<NormalizedPoint>>;
}

/**
 * Channel layout of a `face_box` stream: the top-left corner and size of the
 * face in 0–1 coordinates of the video frame, x to the right and y downward.
 */
export const FACE_BOX_CHANNELS: ChannelInfo[] = [
  { index: 0, label: "x" },
  { index: 1, label: "y" },
  { index: 2, label: "width" },
  { index: 3, label: "height" },
];

/**
 * Name of a per-subject stream: `base` alone when one subject is tracked, else
 * `base_<subject>_<n>` counting from 1 — `landmarks`, or `landmarks_face_2`.
 * `FaceOverlay` reads the `face` form back, so a new kind of subject is named
 * here rather than by hand in each receiver.
 */
export function subjectStreamName(
  base: string,
  subject: "face" | "pose",
  index: number,
  total: number
): string {
  return total > 1 ? `${base}_${subject}_${index + 1}` : base;
}

/**
 * Shared lifecycle for receivers that infer signals from camera frames.
 *
 * All of them follow the same shape: lazily load `@mediapipe/tasks-vision`,
 * build a task, then run a `requestAnimationFrame` loop over an
 * `HTMLVideoElement` that a {@link VideoReceiver} owns. Sharing the element
 * rather than each receiver opening its own camera is what lets face tracking
 * and heart rate run off one video feed.
 *
 * `@mediapipe/tasks-vision` is an *optional* peer dependency — several
 * megabytes of wasm that a Muse-only application should never download — so
 * it is imported dynamically and a clear error is raised when it is absent.
 */
export abstract class VisionReceiver extends BaseReceiver {
  modalities: Modality[] = [Modality.VIDEO];

  protected videoElement: HTMLVideoElement;
  protected assets: Required<Pick<VisionAssetOptions, "delegate" | "maxFps">> &
    VisionAssetOptions;

  private running = false;
  private frameHandle: number | undefined;
  private lastVideoTime = -1;
  /** Earliest time the next frame may be processed, from performance.now(). */
  private nextInferenceTime = 0;

  constructor(videoElement: HTMLVideoElement, assets: VisionAssetOptions = {}) {
    super();
    this.videoElement = videoElement;
    this.assets = { delegate: "GPU", maxFps: 30, ...assets };
  }

  /** The element this receiver reads frames from. */
  get video(): HTMLVideoElement {
    return this.videoElement;
  }

  /** The inference rate cap, in frames per second. */
  get maxFps(): number {
    return this.assets.maxFps;
  }

  /** Loads the tasks-vision module, with a helpful error when it is missing. */
  protected async loadVisionModule(): Promise<any> {
    try {
      return await import("@mediapipe/tasks-vision");
    } catch (error) {
      throw new Error(
        "@mediapipe/tasks-vision is required for camera-derived receivers. " +
          "Install it alongside yq-data: npm install @mediapipe/tasks-vision"
      );
    }
  }

  /** Builds the MediaPipe task and registers this receiver's streams. */
  protected abstract createTask(vision: any): Promise<void>;

  /** Runs inference on one frame and publishes the result. */
  protected abstract processFrame(timestampMs: number): void;

  /** Releases the MediaPipe task. */
  protected abstract closeTask(): void;

  public async connect(): Promise<void> {
    if (this.isConnected) return;

    const vision = await this.loadVisionModule();
    await this.createTask(vision);
    this.isConnected = true;
  }

  public startStream(): void {
    if (!this.isConnected || this.running) return;
    this.running = true;
    this.loop();
  }

  public stopStream(): void {
    this.running = false;
    if (this.frameHandle !== undefined) {
      cancelAnimationFrame(this.frameHandle);
      this.frameHandle = undefined;
    }
  }

  public async disconnect(): Promise<void> {
    this.stopStream();
    this.closeTask();
    this.lastVideoTime = -1;
    this.nextInferenceTime = 0;
    this.isConnected = false;
  }

  private loop = (): void => {
    if (!this.running) return;

    const video = this.videoElement;
    const now = performance.now();
    const minInterval = 1000 / this.assets.maxFps;

    // Two guards, doing different jobs: readyState/currentTime skips frames
    // the camera has not actually advanced (rAF runs at display rate, which
    // is usually faster than the camera), and the deadline caps inference
    // cost independently of either.
    //
    // The deadline allows a quarter of an interval early. A frame is noticed
    // on the first animation frame after it arrives, so a 30 fps camera's
    // frames are seen 33.2, 33.5, 33.1 ms apart; a strict `>= 1000 / 30`
    // would hold a frame from a camera running exactly at the cap back by a
    // whole display refresh, more or less at random. Advancing the deadline
    // from the previous one rather than from `now` keeps the average rate at
    // the cap.
    if (
      video.readyState >= 2 &&
      video.currentTime !== this.lastVideoTime &&
      now >= this.nextInferenceTime - minInterval / 4
    ) {
      this.lastVideoTime = video.currentTime;
      this.nextInferenceTime =
        Math.max(this.nextInferenceTime, now - minInterval) + minInterval;

      try {
        this.processFrame(now);
      } catch (error) {
        console.error(`${this.deviceName} inference failed:`, error);
      }
    }

    this.frameHandle = requestAnimationFrame(this.loop);
  };
}
