import { ChannelInfo, Modality } from "../../../data_stream.interface";
import { BaseReceiver } from "../../base_receiver";

/** Where the MediaPipe wasm runtime and model files are fetched from. */
export interface VisionAssetOptions {
  /** Directory containing the tasks-vision wasm bundle. */
  wasmPath?: string;
  /** URL of the `.task` model file. */
  modelAssetPath?: string;
  /** GPU is much faster; fall back to CPU where WebGL is unavailable. */
  delegate?: "GPU" | "CPU";
  /** Target inference rate. Frames arriving faster than this are skipped. */
  maxFps?: number;
}

export const DEFAULT_WASM_PATH =
  "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.3/wasm";

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
 * Channel info for a flattened point list, labelled "0 x", "0 y", "1 x"….
 *
 * The labels are what tell a consumer the stride — an overlay finds where the
 * second point's "x" starts — so 2-D and 3-D landmark streams can share code.
 */
export function pointChannels(
  count: number,
  components: string[]
): ChannelInfo[] {
  const channels: ChannelInfo[] = [];
  for (let point = 0; point < count; point++) {
    for (const component of components) {
      channels.push({ index: channels.length, label: `${point} ${component}` });
    }
  }
  return channels;
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
  private lastInferenceTime = 0;

  constructor(videoElement: HTMLVideoElement, assets: VisionAssetOptions = {}) {
    super();
    this.videoElement = videoElement;
    this.assets = { delegate: "GPU", maxFps: 30, ...assets };
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
    this.isConnected = false;
  }

  private loop = (): void => {
    if (!this.running) return;

    const video = this.videoElement;
    const now = performance.now();
    const minInterval = 1000 / this.assets.maxFps;

    // Two guards, doing different jobs: readyState/currentTime skips frames
    // the camera has not actually advanced (rAF runs at display rate, which
    // is usually faster than the camera), and the interval check caps
    // inference cost independently of either.
    if (
      video.readyState >= 2 &&
      video.currentTime !== this.lastVideoTime &&
      now - this.lastInferenceTime >= minInterval
    ) {
      this.lastVideoTime = video.currentTime;
      this.lastInferenceTime = now;

      try {
        this.processFrame(now);
      } catch (error) {
        console.error(`${this.deviceName} inference failed:`, error);
      }
    }

    this.frameHandle = requestAnimationFrame(this.loop);
  };
}
