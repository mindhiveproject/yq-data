import { Subscription } from "rxjs";
import { DataPacket } from "../data_stream.interface";
import { BaseReceiver } from "../receiver/base_receiver";
import { AUTO_STALE_INTERVALS } from "../manager/manager";
import { pointBounds, pointStride } from "../points";
import { TopologyDetail, topologyEdges } from "./topology";

/**
 * How the video frame is fitted into the element the overlay covers — the
 * same keywords as CSS `object-fit`.
 */
export type OverlayFit = "fill" | "contain" | "cover";

export interface FaceOverlayOptions {
  /**
   * The video the canvas sits on top of. Supplies the frame's aspect ratio and
   * its `object-fit`, which together decide where a normalized point lands.
   * Leave it out when drawing streams that arrived over a transport with no
   * local video, and give `frameSize` instead.
   */
  video?: HTMLVideoElement;
  /** Frame size in pixels, when there is no `video` to read it from. */
  frameSize?: { width: number; height: number };
  /** Overrides the fit read from the video's computed `object-fit`. */
  fit?: OverlayFit;
  /**
   * Flip drawing horizontally, for a video mirrored with CSS.
   *
   * Leave this false if the canvas is mirrored by the same CSS as the video —
   * then the browser flips both, and flipping here too would undo it. Setting
   * it here instead keeps label text readable.
   */
  mirror?: boolean;
  /** Which layers to draw. All default to true; each needs its stream. */
  layers?: {
    /** `face_box`. */
    box?: boolean;
    /** `landmarks`, as points. */
    landmarks?: boolean;
    /**
     * `landmarks`, joined by the model's own edges: `"contours"` (the
     * default) outlines eyes, brows, lips, irises and face; `"mesh"` draws
     * the full 2556-edge triangulation, which is far heavier to stroke.
     * Streams whose topology is unknown draw as points only.
     */
    connections?: TopologyDetail | false;
    /** `head_pose`, as axes at the face's centre. */
    headPose?: boolean;
    /** The strongest `expressions` score, above the box. */
    label?: boolean;
  };
  style?: {
    color?: string;
    lineWidth?: number;
    pointSize?: number;
    font?: string;
  };
  /**
   * Milliseconds after its last packet that a face stops being drawn.
   *
   * `"auto"` (the default) uses the same rule as the pipeline's staleness
   * guard — {@link AUTO_STALE_INTERVALS} of the stream's own cadence — so a
   * face that leaves the frame, and a transport that stalls, both clear
   * within a few frames.
   */
  staleAfter?: number | "auto";
}

/** Streams the overlay knows how to draw, by base name. */
type FaceLayer = "face_box" | "landmarks" | "head_pose" | "expressions";

const FACE_STREAM = /^(face_box|landmarks|head_pose|expressions)(?:_face_(\d+))?$/;

/** Shortest staleness limit `"auto"` derives, so jitter never blinks a face. */
const STALE_FLOOR_MS = 100;

/** Limit used before a stream has sent two packets and has no cadence yet. */
const STALE_UNKNOWN_MS = 500;

/** Weight of the newest gap in a stream's cadence estimate. */
const INTERVAL_SMOOTHING = 0.2;

interface LayerState {
  packet: DataPacket;
  /** Local arrival time. The remote clock is not this one, so it is not used. */
  receivedAt: number;
  interval?: number;
}

/** Normalized frame coordinates → CSS pixels on the canvas. */
export interface FrameTransform {
  scaleX: number;
  scaleY: number;
  offsetX: number;
  offsetY: number;
}

/**
 * Where a frame of `frame` size lands inside a `view` of the given size,
 * following CSS `object-fit`. With no frame size the frame fills the view.
 */
export function frameTransform(
  frame: { width: number; height: number } | undefined,
  view: { width: number; height: number },
  fit: OverlayFit
): FrameTransform {
  if (fit === "fill" || !frame || frame.width <= 0 || frame.height <= 0) {
    return { scaleX: view.width, scaleY: view.height, offsetX: 0, offsetY: 0 };
  }
  const pick = fit === "cover" ? Math.max : Math.min;
  const scale = pick(view.width / frame.width, view.height / frame.height);
  const width = frame.width * scale;
  const height = frame.height * scale;
  return {
    scaleX: width,
    scaleY: height,
    offsetX: (view.width - width) / 2,
    offsetY: (view.height - height) / 2,
  };
}

/**
 * Screen-space directions of the head's right, up and forward axes, for unit
 * length, with y pointing down the canvas.
 *
 * Rebuilds the rotation that `FaceLandmarkReceiver`'s Euler extraction
 * inverts — Rz(−roll)·Rx(−pitch)·Ry(−yaw) — and projects its columns
 * orthographically. MediaPipe's camera space has y up, hence the flip.
 */
export function headPoseAxes(
  yawDeg: number,
  pitchDeg: number,
  rollDeg: number
): [number, number][] {
  const toRadians = Math.PI / 180;
  const [cy, sy] = [Math.cos(-yawDeg * toRadians), Math.sin(-yawDeg * toRadians)];
  const [cp, sp] = [Math.cos(-pitchDeg * toRadians), Math.sin(-pitchDeg * toRadians)];
  const [cr, sr] = [Math.cos(-rollDeg * toRadians), Math.sin(-rollDeg * toRadians)];

  const rz = [[cr, -sr, 0], [sr, cr, 0], [0, 0, 1]];
  const rx = [[1, 0, 0], [0, cp, -sp], [0, sp, cp]];
  const ry = [[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]];
  const r = multiply(multiply(rz, rx), ry);

  return [0, 1, 2].map((axis) => [r[0][axis], -r[1][axis]]);
}

function multiply(a: number[][], b: number[][]): number[][] {
  return a.map((row) =>
    [0, 1, 2].map((col) => row[0] * b[0][col] + row[1] * b[1][col] + row[2] * b[2][col])
  );
}

/**
 * Which face, and which layer of it, a stream carries — or undefined for a
 * stream the overlay does not draw.
 *
 * Faces are grouped by everything in the stream ID before the name, so a
 * landmarker and an emotion receiver on the same camera stay separate faces,
 * and streams from a `RemoteStreamReceiver` group the way they did at source.
 */
export function faceStreamKey(
  streamID: string
): { face: string; layer: FaceLayer } | undefined {
  const split = streamID.lastIndexOf(":");
  if (split < 0) return undefined;
  const match = FACE_STREAM.exec(streamID.slice(split + 1));
  if (!match) return undefined;
  return {
    face: `${streamID.slice(0, split)}#${match[2] ?? "1"}`,
    layer: match[1] as FaceLayer,
  };
}

/**
 * The landmark packet to draw over the video, or undefined for one that
 * cannot be: metric `world` coordinates are not positions in the frame.
 */
function framePoints(packet: DataPacket | undefined): DataPacket | undefined {
  if (!packet) return undefined;
  return packet.metadata.additionalMetadata?.coordinateSpace === "world"
    ? undefined
    : packet;
}

/**
 * Draws face streams over a video: boxes, landmarks, head-pose axes and the
 * leading expression.
 *
 * It reads streams, not receivers, so the same overlay draws from a local
 * {@link FaceLandmarkReceiver} or {@link FaceEmotionReceiver} and from a
 * `RemoteStreamReceiver` carrying their streams from another machine. Turn on
 * the geometry it needs at the source — `emitFaceBox`, `emitLandmarks`,
 * `emitHeadPose`. Landmarks are joined using the edge lists in
 * `face_topology`, chosen by the topology the stream names, so the edges
 * themselves never travel with the data.
 *
 * Coordinates are normalized to the video frame; the overlay maps them onto
 * the canvas using the video's `object-fit`, so the canvas should cover the
 * video element exactly.
 *
 * ```ts
 * const face = new FaceLandmarkReceiver(video, { emitFaceBox: true });
 * const overlay = new FaceOverlay(canvas, { video });
 * overlay.attach(face);
 * overlay.start();
 * ```
 *
 * A face is drawn until its streams go quiet for longer than `staleAfter`.
 * Receivers publish nothing for a frame with no face, so that silence is how a
 * face leaving the frame reaches the canvas.
 */
export class FaceOverlay {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly options: FaceOverlayOptions;
  private readonly faces = new Map<string, Map<FaceLayer, LayerState>>();
  private readonly subscriptions = new Set<Subscription>();
  private videoStyle?: CSSStyleDeclaration;
  private frameHandle: number | undefined;

  constructor(canvas: HTMLCanvasElement, options: FaceOverlayOptions = {}) {
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("FaceOverlay needs a 2D canvas context.");
    this.canvas = canvas;
    this.ctx = ctx;
    this.options = options;
  }

  /** Draws every face stream a receiver publishes. Returns a detach function. */
  public attach(receiver: BaseReceiver<any>): () => void {
    const subscription = receiver.data.subscribe((packet) => this.push(packet));
    this.subscriptions.add(subscription);
    return () => {
      subscription.unsubscribe();
      this.subscriptions.delete(subscription);
    };
  }

  /**
   * Hands the overlay one packet. Use this to feed it from a pipeline output
   * or anything else that is not a receiver; other streams are ignored.
   */
  public push(packet: DataPacket): void {
    const key = faceStreamKey(packet.streamID);
    if (!key) return;

    let layers = this.faces.get(key.face);
    if (!layers) {
      layers = new Map();
      this.faces.set(key.face, layers);
    }

    const now = performance.now();
    const previous = layers.get(key.layer);
    let interval = previous?.interval;
    if (previous) {
      const gap = now - previous.receivedAt;
      interval =
        interval === undefined
          ? gap
          : interval * (1 - INTERVAL_SMOOTHING) + gap * INTERVAL_SMOOTHING;
    }

    layers.set(key.layer, { packet, receivedAt: now, interval });
  }

  /** Redraws on every animation frame until {@link stop}. */
  public start(): void {
    if (this.frameHandle !== undefined) return;
    const loop = () => {
      this.draw();
      this.frameHandle = requestAnimationFrame(loop);
    };
    this.frameHandle = requestAnimationFrame(loop);
  }

  public stop(): void {
    if (this.frameHandle !== undefined) cancelAnimationFrame(this.frameHandle);
    this.frameHandle = undefined;
  }

  /** Forgets every face and blanks the canvas. */
  public clear(): void {
    this.faces.clear();
    const { width, height } = this.canvas;
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.clearRect(0, 0, width, height);
  }

  public destroy(): void {
    this.stop();
    this.subscriptions.forEach((subscription) => subscription.unsubscribe());
    this.subscriptions.clear();
    this.clear();
  }

  /**
   * Draws one frame. {@link start} calls this for you; call it yourself to
   * draw from a render loop you already run.
   */
  public draw(): void {
    const view = this.resize();
    const ctx = this.ctx;
    ctx.clearRect(0, 0, view.width, view.height);

    const transform = frameTransform(this.frameSize(), view, this.fit());
    const now = performance.now();

    for (const [face, layers] of this.faces) {
      for (const [layer, state] of layers) {
        if (now - state.receivedAt > this.staleAfter(state)) layers.delete(layer);
      }
      if (layers.size === 0) {
        this.faces.delete(face);
        continue;
      }
      this.drawFace(layers, transform);
    }
  }

  private drawFace(
    layers: Map<FaceLayer, LayerState>,
    t: FrameTransform
  ): void {
    const ctx = this.ctx;
    const show = {
      box: true,
      landmarks: true,
      connections: "contours" as TopologyDetail | false,
      headPose: true,
      label: true,
      ...this.options.layers,
    };
    const style = {
      color: "#00e0a0",
      lineWidth: 2,
      pointSize: 2,
      font: "14px sans-serif",
      ...this.options.style,
    };
    const mirror = this.options.mirror ?? false;
    const toX = (u: number) => (mirror ? 1 - u : u) * t.scaleX + t.offsetX;
    const toY = (v: number) => v * t.scaleY + t.offsetY;

    ctx.strokeStyle = style.color;
    ctx.fillStyle = style.color;
    ctx.lineWidth = style.lineWidth;
    ctx.font = style.font;

    const points = framePoints(layers.get("landmarks")?.packet);
    if (show.landmarks && points) {
      const stride = pointStride(points.metadata);
      const size = style.pointSize;
      for (let i = 0; i + 1 < points.data.length; i += stride) {
        ctx.fillRect(toX(points.data[i]) - size / 2, toY(points.data[i + 1]) - size / 2, size, size);
      }
    }

    const edges =
      show.connections && points
        ? topologyEdges(points.metadata.additionalMetadata?.topology, show.connections)
        : undefined;
    if (edges && points) {
      // One path for every edge: a stroke per edge is what makes the full
      // mesh expensive, not the edges themselves.
      const stride = pointStride(points.metadata);
      const data = points.data;
      ctx.beginPath();
      for (let e = 0; e + 1 < edges.length; e += 2) {
        const a = edges[e] * stride;
        const b = edges[e + 1] * stride;
        if (b + 1 >= data.length || a + 1 >= data.length) continue;
        ctx.moveTo(toX(data[a]), toY(data[a + 1]));
        ctx.lineTo(toX(data[b]), toY(data[b + 1]));
      }
      ctx.lineWidth = Math.max(1, style.lineWidth / 2);
      ctx.stroke();
      ctx.lineWidth = style.lineWidth;
    }

    // The box in canvas pixels, from `face_box` or else the landmarks' extent;
    // it anchors the label and the head-pose axes.
    let box: { left: number; top: number; width: number; height: number } | undefined;
    const boxPacket = layers.get("face_box")?.packet;
    if (boxPacket && boxPacket.data.length >= 4) {
      const [x, y, w, h] = boxPacket.data;
      const xs = [toX(x), toX(x + w)];
      box = { left: Math.min(...xs), top: toY(y), width: Math.abs(xs[1] - xs[0]), height: h * t.scaleY };
      if (show.box) ctx.strokeRect(box.left, box.top, box.width, box.height);
    } else if (points) {
      const bounds = pointBounds(points.data, pointStride(points.metadata));
      if (bounds) {
        const xs = [toX(bounds.x), toX(bounds.x + bounds.width)];
        box = {
          left: Math.min(...xs),
          top: toY(bounds.y),
          width: Math.abs(xs[1] - xs[0]),
          height: bounds.height * t.scaleY,
        };
      }
    }

    const expressions = layers.get("expressions")?.packet;
    if (show.label && box && expressions && expressions.data.length > 0) {
      let best = 0;
      for (let i = 1; i < expressions.data.length; i++) {
        if (expressions.data[i] > expressions.data[best]) best = i;
      }
      const name = expressions.metadata.channelInfo?.[best]?.label ?? `class ${best}`;
      ctx.textBaseline = "bottom";
      ctx.fillText(
        `${name} ${Math.round(expressions.data[best] * 100)}%`,
        box.left,
        box.top - style.lineWidth
      );
    }

    const pose = layers.get("head_pose")?.packet;
    if (show.headPose && box && pose && pose.data.length >= 3) {
      const cx = box.left + box.width / 2;
      const cy = box.top + box.height / 2;
      const length = box.width / 2;
      const colors = ["#ff4d4d", "#4dff4d", "#4d9dff"];
      headPoseAxes(pose.data[0], pose.data[1], pose.data[2]).forEach(([dx, dy], axis) => {
        ctx.strokeStyle = colors[axis];
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(cx + (mirror ? -dx : dx) * length, cy + dy * length);
        ctx.stroke();
      });
      ctx.strokeStyle = style.color;
    }
  }

  /** Matches the backing store to the canvas's displayed size; returns CSS px. */
  private resize(): { width: number; height: number } {
    const ratio = globalThis.devicePixelRatio || 1;
    const width = this.canvas.clientWidth || this.canvas.width / ratio;
    const height = this.canvas.clientHeight || this.canvas.height / ratio;
    const backingWidth = Math.round(width * ratio);
    const backingHeight = Math.round(height * ratio);
    if (this.canvas.width !== backingWidth) this.canvas.width = backingWidth;
    if (this.canvas.height !== backingHeight) this.canvas.height = backingHeight;
    this.ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    return { width, height };
  }

  private frameSize(): { width: number; height: number } | undefined {
    const video = this.options.video;
    if (video && video.videoWidth > 0) {
      return { width: video.videoWidth, height: video.videoHeight };
    }
    return this.options.frameSize;
  }

  private fit(): OverlayFit {
    if (this.options.fit) return this.options.fit;
    const video = this.options.video;
    if (!video) return "fill";
    // A live declaration: read once, it keeps tracking the element's CSS.
    this.videoStyle ??= getComputedStyle(video);
    const fit = this.videoStyle.objectFit;
    // `none` and `scale-down` are rare on a camera feed; contain is the
    // closest of the three and is what browsers render video with by default.
    return fit === "fill" || fit === "cover" ? fit : "contain";
  }

  private staleAfter(state: LayerState): number {
    const limit = this.options.staleAfter ?? "auto";
    if (limit !== "auto") return limit;
    if (state.interval === undefined) return STALE_UNKNOWN_MS;
    return Math.max(STALE_FLOOR_MS, state.interval * AUTO_STALE_INTERVALS);
  }
}
