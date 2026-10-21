import { Modality, ProcessingStage } from "../../../data_stream.interface";
import {
  VisionReceiver,
  VisionAssetOptions,
  DEFAULT_WASM_PATH,
  NormalizedPoint,
} from "./base_vision";
import type { FaceLandmarkReceiver } from "./face_landmarker";

const DEFAULT_MODEL =
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";

/**
 * Skin regions on the MediaPipe Face Landmarker mesh, as polygons of landmark
 * indices in boundary order. Left and right are the subject's own.
 *
 * - `forehead` runs from the top of the eyebrows to the second row of the
 *   mesh, and dips to the glabella between the brows. It stops short of the
 *   mesh's top row, which sits at the hairline and is the first thing a fringe
 *   covers.
 * - The cheeks are the malar region under each eye, clear of the lower lid,
 *   the side of the nose (shadowed) and the nasolabial fold (which moves with
 *   every smile). Each is the exact mirror of the other on the canonical mesh.
 *
 * Kim et al. (2021) scored 39 facial regions across seven rPPG algorithms; the
 * medial forehead, the glabella and both malar regions made their top five,
 * and combining regions beat any single one.
 *
 * Kim, D.-Y., Lee, K. & Sohn, C.-B. (2021). Assessment of ROI Selection for
 * Facial Video-Based rPPG. Sensors 21(23):7923.
 * https://doi.org/10.3390/s21237923
 */
export const RPPG_SKIN_POLYGONS = {
  forehead: [104, 69, 108, 151, 337, 299, 333, 334, 296, 336, 9, 107, 66, 105],
  rightCheek: [118, 119, 100, 36, 205, 207, 187, 123, 117],
  leftCheek: [347, 348, 329, 266, 425, 427, 411, 352, 346],
} as const;

export type RPPGRegion = "forehead" | "cheeks" | "both";

/** The skin polygons sampled for a region. */
export function regionPolygons(region: RPPGRegion): ReadonlyArray<readonly number[]> {
  const { forehead, rightCheek, leftCheek } = RPPG_SKIN_POLYGONS;
  if (region === "forehead") return [forehead];
  if (region === "cheeks") return [rightCheek, leftCheek];
  return [forehead, rightCheek, leftCheek];
}

/**
 * A region's polygons in pixel coordinates of a `width` × `height` frame, as
 * `[x, y]` vertex lists. `null` if any landmark is missing.
 */
export function skinPolygons(
  landmarks: ReadonlyArray<NormalizedPoint>,
  region: RPPGRegion,
  width: number,
  height: number
): [number, number][][] | null {
  const out: [number, number][][] = [];
  for (const polygon of regionPolygons(region)) {
    const vertices: [number, number][] = [];
    for (const index of polygon) {
      const point = landmarks[index];
      if (!point) return null;
      vertices.push([point.x * width, point.y * height]);
    }
    out.push(vertices);
  }
  return out;
}

/**
 * Mean red, green and blue of the fully opaque pixels in RGBA data.
 *
 * The receiver clears its canvas to transparent and draws the video through a
 * clip of the skin polygons, so opacity *is* the mask. Partly transparent
 * pixels on the antialiased edge are left out, since they mix in whatever lies
 * just outside the skin. `null` when fewer than `minPixels` pixels remain.
 */
export function meanSkinColor(
  rgba: ArrayLike<number>,
  minPixels = 1
): [number, number, number] | null {
  let red = 0;
  let green = 0;
  let blue = 0;
  let count = 0;
  for (let i = 0; i + 3 < rgba.length; i += 4) {
    if (rgba[i + 3] !== 255) continue;
    red += rgba[i];
    green += rgba[i + 1];
    blue += rgba[i + 2];
    count++;
  }
  if (count < Math.max(1, minPixels)) return null;
  return [red / count, green / count, blue / count];
}

/**
 * Puts irregularly timed frames onto a regular sample grid.
 *
 * Signal processing downstream assumes evenly spaced samples, and a camera
 * does not deliver them: the frame rate wanders with exposure, the page
 * notices each frame up to a display refresh late, and a frame without a
 * usable face yields nothing at all. Dropping those samples would silently
 * compress time, which shifts every frequency and inter-beat interval
 * measured across the hole.
 *
 * Each grid sample is linearly interpolated from the two frames either side
 * of it. A run without frames longer than `maxGapMs` is not bridged; the grid
 * restarts at the next frame instead, and the time in between has no samples.
 */
export class FrameResampler {
  private readonly period: number;
  private previous: { time: number; value: number[] } | undefined;
  private nextTime = 0;

  constructor(readonly rate: number, readonly maxGapMs: number) {
    this.period = 1000 / rate;
  }

  /**
   * Adds a frame and returns the grid samples it completes: their times and
   * values, oldest first. A frame restarting the grid is its first sample.
   */
  push(time: number, value: number[]): { times: number[]; values: number[][] } {
    const times: number[] = [];
    const values: number[][] = [];
    const previous = this.previous;

    if (previous === undefined || time - previous.time > this.maxGapMs) {
      times.push(time);
      values.push(value.slice());
      this.nextTime = time + this.period;
    } else if (time > previous.time) {
      const span = time - previous.time;
      // The tolerance keeps a frame that lands exactly on the grid from being
      // missed to floating-point error and emitted a frame late.
      while (this.nextTime <= time + 1e-6) {
        const w = (this.nextTime - previous.time) / span;
        times.push(this.nextTime);
        values.push(value.map((v, c) => previous.value[c] + w * (v - previous.value[c])));
        this.nextTime += this.period;
      }
    } else {
      // A frame stamped at or before the previous one carries no new time.
      return { times, values };
    }

    this.previous = { time, value: value.slice() };
    return { times, values };
  }

  public reset(): void {
    this.previous = undefined;
  }
}

export interface RPPGOptions extends VisionAssetOptions {
  /**
   * Which skin is averaged: the `forehead`, both `cheeks`, or `both`
   * (default). More skin averages away more camera noise, and Kim et al.
   * (2021) found the combination more accurate than any one region.
   */
  region?: RPPGRegion;
  /**
   * Longest side, in pixels, of the image read back each frame. The region is
   * cropped from the full-resolution frame first, so this only bites when the
   * face is large in the frame; it bounds the per-frame readback cost.
   */
  sampleSize?: number;
  /**
   * Rate of the emitted stream, in Hz. Defaults to `maxFps` (of `faceSource`
   * when there is one). Frames are interpolated onto this grid, so a camera
   * running slower than it, as many do in dim light, still yields an evenly
   * sampled stream.
   */
  samplingRate?: number;
  /**
   * Longest run without a usable face, in seconds, that is interpolated over.
   * After a longer one the stream falls silent and restarts on the next face;
   * downstream nodes see the gap through the stream's sample clock and start
   * again rather than splice across it.
   */
  maxGap?: number;
  /**
   * A {@link FaceLandmarkReceiver} on the same video element to take
   * landmarks from, instead of running a second copy of the model. Its frame
   * rate then sets this receiver's, and the asset options here are unused.
   * This receiver emits only while that one is streaming.
   */
  faceSource?: FaceLandmarkReceiver;
}

/** Fewer skin pixels than this and the region is too small to trust. */
const MIN_SKIN_PIXELS = 64;

/**
 * Remote photoplethysmography: the raw pulse-bearing signal from a camera.
 *
 * Each frame, the mean red, green and blue of the facial skin is measured and
 * emitted as a three-channel sample. The skin is polygons on the Face
 * Landmarker mesh (see {@link RPPG_SKIN_POLYGONS}), so the region follows the
 * face as it turns and never takes in eyes, brows, nostrils or background.
 *
 * The stream is evenly sampled at `samplingRate` and declares a sample clock
 * (`additionalMetadata.sampleClock`): each packet is stamped with the time of
 * its last sample. When the face is lost for longer than `maxGap` the stream
 * goes silent, the same signal every face stream uses for a face that is gone.
 *
 * This receiver stops at the colour signal. Turning it into a pulse and a rate
 * is ordinary time-series work, so it belongs in a pipeline:
 *
 * ```ts
 * nodes: [
 *   { id: "rgb",    receiver: "rppg" },
 *   { id: "pulse",  method: AnalysisMethod.PULSE_EXTRACTION },                     // POS
 *   { id: "window", method: AnalysisMethod.WINDOWING,  parameters: { size: 10, hop: 1 } },
 *   { id: "bpm",    method: AnalysisMethod.HEART_RATE },
 * ]
 * ```
 *
 * From `pulse` on, the chain is the one a Muse PPG sensor uses.
 *
 * Accuracy depends on even lighting and a reasonably still subject; treat the
 * output as expressive rather than clinical.
 *
 * The face is located with MediaPipe Face Landmarker — Lugaresi, C. et al.
 * (2019), arXiv:1906.08172.
 */
export class RPPGReceiver extends VisionReceiver {
  deviceName = "Video Heart Rate";
  deviceID: string | number;

  private landmarker: any;
  private readonly faceSource: FaceLandmarkReceiver | undefined;
  private unsubscribe: (() => void) | undefined;
  private canvas: HTMLCanvasElement | undefined;
  private context: CanvasRenderingContext2D | null = null;
  private resampler: FrameResampler | undefined;
  private options: Required<Pick<RPPGOptions, "region" | "sampleSize" | "maxGap">> &
    Pick<RPPGOptions, "samplingRate">;

  constructor(videoElement: HTMLVideoElement, options: RPPGOptions = {}) {
    super(videoElement, options);
    if (options.faceSource && options.faceSource.video !== videoElement) {
      throw new Error(
        "RPPGReceiver: faceSource must track the same video element, or the " +
          "landmarks would be placed on a different image."
      );
    }
    this.deviceID = "rppg";
    this.faceSource = options.faceSource;
    this.options = {
      region: options.region ?? "both",
      sampleSize: options.sampleSize ?? 160,
      maxGap: options.maxGap ?? 0.25,
      samplingRate: options.samplingRate,
    };
  }

  /** Rate of the emitted stream, in Hz. */
  get samplingRate(): number {
    return this.options.samplingRate ?? (this.faceSource ?? this).maxFps;
  }

  public async connect(): Promise<void> {
    if (!this.faceSource) return super.connect();
    if (this.isConnected) return;
    this.prepareSampling();
    this.isConnected = true;
  }

  public startStream(): void {
    if (!this.faceSource) return super.startStream();
    if (!this.isConnected || this.unsubscribe) return;
    this.unsubscribe = this.faceSource.onFrame((frame) =>
      this.sample(frame.timestampMs, frame.faces[0])
    );
  }

  public stopStream(): void {
    if (!this.faceSource) return super.stopStream();
    this.unsubscribe?.();
    this.unsubscribe = undefined;
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

    this.prepareSampling();
  }

  private prepareSampling(): void {
    this.canvas = document.createElement("canvas");
    // Reading pixels back every frame is the dominant cost here, and
    // willReadFrequently tells the browser to keep the surface in CPU memory
    // rather than round-tripping it from the GPU each time.
    this.context = this.canvas.getContext("2d", { willReadFrequently: true });
    if (this.context) this.context.imageSmoothingQuality = "high";
    this.resampler = new FrameResampler(this.samplingRate, this.options.maxGap * 1000);

    this.ensureStream({
      modality: Modality.VIDEO,
      processingStage: ProcessingStage.PREPROCESSED,
      name: "rppg",
      additionalMetadata: {
        samplingRate: this.samplingRate,
        channelInfo: [
          { index: 0, label: "red" },
          { index: 1, label: "green" },
          { index: 2, label: "blue" },
        ],
        additionalMetadata: { region: this.options.region, sampleClock: true },
      },
    });
  }

  protected closeTask(): void {
    this.landmarker?.close?.();
    this.landmarker = undefined;
    this.canvas = undefined;
    this.context = null;
    this.resampler = undefined;
  }

  protected processFrame(timestampMs: number): void {
    if (!this.landmarker) return;
    const results = this.landmarker.detectForVideo(this.videoElement, timestampMs);
    this.sample(timestampMs, results?.faceLandmarks?.[0]);
  }

  /** Measures one frame's skin colour and publishes the grid samples it completes. */
  private sample(
    timestampMs: number,
    landmarks: ReadonlyArray<NormalizedPoint> | undefined
  ): void {
    if (!landmarks || !this.resampler) return;
    const colour = this.readSkin(landmarks);
    if (!colour) return;

    const { times, values } = this.resampler.push(timestampMs, colour);
    if (values.length === 0) return;

    const data = new Float32Array(values.length * 3);
    values.forEach((v, i) => data.set(v, i * 3));

    this.update(
      {
        modality: Modality.VIDEO,
        processingStage: ProcessingStage.PREPROCESSED,
        name: "rppg",
      },
      data,
      undefined,
      // performance.now() and Date.now() are the same clock up to the page's
      // time origin, which is what makes this a wall-clock timestamp.
      { timestamp: performance.timeOrigin + times[times.length - 1] }
    );
  }

  /** Mean colour of the region's skin in the current video frame. */
  private readSkin(
    landmarks: ReadonlyArray<NormalizedPoint>
  ): [number, number, number] | null {
    const canvas = this.canvas;
    const context = this.context;
    const video = this.videoElement;
    const width = video.videoWidth;
    const height = video.videoHeight;
    if (!canvas || !context || !width || !height) return null;

    const polygons = skinPolygons(landmarks, this.options.region, width, height);
    if (!polygons) return null;

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const polygon of polygons) {
      for (const [x, y] of polygon) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
    const x0 = Math.max(0, Math.floor(minX));
    const y0 = Math.max(0, Math.floor(minY));
    const cropWidth = Math.min(width, Math.ceil(maxX)) - x0;
    const cropHeight = Math.min(height, Math.ceil(maxY)) - y0;
    if (cropWidth < 2 || cropHeight < 2) return null;

    const scale = Math.min(1, this.options.sampleSize / Math.max(cropWidth, cropHeight));
    const outWidth = Math.max(1, Math.round(cropWidth * scale));
    const outHeight = Math.max(1, Math.round(cropHeight * scale));
    // Assigning a canvas dimension reallocates it, so only when it changes.
    if (canvas.width !== outWidth) canvas.width = outWidth;
    if (canvas.height !== outHeight) canvas.height = outHeight;

    context.clearRect(0, 0, outWidth, outHeight);
    context.save();
    context.beginPath();
    for (const polygon of polygons) {
      polygon.forEach(([x, y], i) => {
        const px = (x - x0) * scale;
        const py = (y - y0) * scale;
        if (i === 0) context.moveTo(px, py);
        else context.lineTo(px, py);
      });
      context.closePath();
    }
    context.clip();
    context.drawImage(video, x0, y0, cropWidth, cropHeight, 0, 0, outWidth, outHeight);
    context.restore();

    const { data } = context.getImageData(0, 0, outWidth, outHeight);
    return meanSkinColor(data, MIN_SKIN_PIXELS);
  }
}

/** Alias matching the device name used by the original platform. */
export const VideoHeartRateReceiver = RPPGReceiver;
