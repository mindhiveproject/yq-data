import {
  AnalysisMethod,
  DataPacket,
  ProcessingStage,
  StreamMetadata,
} from "../../../data_stream.interface";
import { Accepts, BaseAnalyzer, EmitOptions } from "../../base_analyzer";
import { GapDetector } from "../../../utility";

export interface WindowingParameters {
  /** Window length. Seconds unless `unit` says otherwise. */
  size?: number;
  /** Step between consecutive windows. Defaults to `size` (no overlap). */
  hop?: number;
  /** Whether `size` and `hop` are expressed in seconds or in samples. */
  unit?: "seconds" | "samples";
  /**
   * Emit partial windows padded with zeros before the buffer has filled.
   *
   * Off by default: a half-empty window has a distorted spectrum, and a visual
   * bound to it would show a misleading value for the first few seconds.
   */
  emitPartial?: boolean;
  /**
   * What to emit when one packet completes more than one window, which
   * happens whenever the hop is shorter than a packet (a 0.04 s hop on Muse's
   * 12-sample packets).
   *
   * - `"latest"` (default): only the newest complete window; older ones are
   *   skipped. The output never falls behind the input, and its rate is capped
   *   at the packet rate — `packetRate` reports the rate actually delivered.
   *   This is what live consumers such as band power and visuals want.
   * - `"all"`: every window, in order, as offline framing produces them. Use
   *   it when the output must be an exact-rate series, such as a recorded
   *   feature for later analysis. One packet can then yield several windows.
   */
  frames?: "latest" | "all";
  /**
   * Missing time, in seconds, after which the buffer is discarded rather than
   * joined across the gap.
   *
   * A window spanning a gap splices two unrelated stretches of signal
   * together, and the discontinuity reads as broadband power or a false beat.
   * `"auto"` (default) acts only on a stream that declares a sample clock (see
   * `hasSampleClock`), such as the camera pulse, where any missing sample is
   * a real gap. Other streams are stamped on arrival, so a gap in their
   * timestamps may be nothing but transport delay; give a number to apply it
   * to them anyway.
   */
  maxGap?: number | "auto";
}

/**
 * Accumulates streaming packets into fixed-length, optionally overlapping
 * windows.
 *
 * Devices deliver signal in whatever chunk size their transport dictates —
 * Muse sends 12 EEG samples at a time — while spectral analysis needs a window
 * of a second or more. Making that buffering an explicit node rather than
 * hiding it inside each analyzer keeps every downstream analyzer stateless and
 * makes the window length a visible property of the graph.
 *
 * Returns `null` for every packet that only partially fills the buffer. Each
 * window is stamped with the time of its own last sample. After a gap (see
 * `maxGap`) the buffer starts again from empty, so the first window after it
 * arrives a full window length later.
 */
export class Windowing extends BaseAnalyzer {
  readonly name = "Windowing";
  readonly method = AnalysisMethod.WINDOWING;
  readonly stage = ProcessingStage.PREPROCESSED;

  /** Interleaved sample buffer, drained a hop at a time. */
  private buffer: number[] = [];
  private channelCount = 1;
  private gaps: GapDetector;

  constructor(parameters: WindowingParameters = {}) {
    super({
      size: 2,
      hop: undefined,
      unit: "seconds",
      emitPartial: false,
      frames: "latest",
      maxGap: "auto",
      ...parameters,
    });
    this.gaps = new GapDetector(this.parameters.maxGap);
  }

  /** A size in seconds needs a rate to interpret it; in samples it does not. */
  get accepts(): Accepts {
    return { requiresSamplingRate: this.parameters.unit !== "samples" };
  }

  /**
   * Windows of a fixed length, whose size and cadence are all known from the
   * input stream's rate and this node's parameters.
   *
   * The one thing that is not is the packet rate when windows are skipped to
   * stay current: it is the rate at which *packets* arrive, capped by the hop,
   * so it needs the device's packet size. That is known only if the stream
   * declares `samplesPerChannel` — or if every window is emitted, in which case
   * the hop alone sets it. Otherwise it is left unresolved, which tells nodes
   * downstream not to read its absence as a verdict.
   */
  protected outputOptions(meta: StreamMetadata): EmitOptions {
    const rate = meta.samplingRate;
    const windowSamples = this.windowSamples(meta);
    const hopSamples = this.hopSamples(meta);

    let packetRate: number | undefined;
    let resolved = true;
    if (rate) {
      const delivered =
        this.parameters.frames === "all"
          ? hopSamples
          : meta.samplesPerChannel !== undefined
          ? Math.max(hopSamples, meta.samplesPerChannel)
          : undefined;
      if (delivered === undefined) resolved = false;
      else packetRate = rate / delivered;
    }

    return {
      name: "windowed",
      samplesPerChannel: windowSamples,
      ...(resolved ? {} : { unresolved: ["packetRate" as const] }),
      additionalMetadata: {
        windowSamples,
        hopSamples,
        windowSeconds: rate ? windowSamples / rate : undefined,
        packetRate,
      },
    };
  }

  public reset(): void {
    this.buffer = [];
    this.gaps.reset();
  }

  /** Window length in samples per channel, for a given stream. */
  private windowSamples(meta: StreamMetadata): number {
    if (this.parameters.unit === "samples") {
      return Math.max(1, Math.floor(this.parameters.size));
    }
    const rate = meta.samplingRate ?? 0;
    return Math.max(1, Math.round(this.parameters.size * rate));
  }

  private hopSamples(meta: StreamMetadata): number {
    const size = this.windowSamples(meta);
    const hop = this.parameters.hop;
    if (hop === undefined || hop === null) return size;
    if (this.parameters.unit === "samples") {
      return Math.max(1, Math.min(size, Math.floor(hop)));
    }
    const rate = meta.samplingRate ?? 0;
    return Math.max(1, Math.min(size, Math.round(hop * rate)));
  }

  analyze(packet: DataPacket): DataPacket | DataPacket[] | null {
    const meta = packet.metadata;
    const channels = meta.channelCount ?? meta.channelInfo?.length ?? 1;

    // A changed channel layout invalidates everything buffered under the old one.
    if (channels !== this.channelCount) {
      this.channelCount = channels;
      this.buffer = [];
    }

    if (this.gaps.next(packet)) this.buffer = [];

    for (let i = 0; i < packet.data.length; i++) this.buffer.push(packet.data[i]);

    const windowSamples = this.windowSamples(meta);
    const hopSamples = this.hopSamples(meta);
    const needed = windowSamples * channels;

    if (this.buffer.length < needed) {
      if (!this.parameters.emitPartial) return null;
      const padded = new Float32Array(needed);
      padded.set(this.buffer);
      return this.buildPacket(packet, padded, hopSamples);
    }

    const step = hopSamples * channels;

    if (this.parameters.frames === "all") {
      const windows: DataPacket[] = [];
      while (this.buffer.length >= needed) {
        windows.push(this.take(packet, needed, windowSamples, hopSamples, hopSamples));
      }
      return windows.length === 1 ? windows[0] : windows;
    }

    // Skip to the newest complete window, staying on the hop grid. Emitting
    // the oldest instead would leave a window behind every time a packet
    // carries more than one hop, and the delay would grow without bound.
    const surplus = Math.floor((this.buffer.length - needed) / step);
    this.buffer.splice(0, surplus * step);

    // At most one window per packet, so a hop shorter than a packet delivers
    // windows at the packet rate, not at rate / hop.
    const delivered = Math.max(hopSamples, packet.data.length / channels);
    return this.take(packet, needed, windowSamples, hopSamples, delivered);
  }

  /** Emits the window at the front of the buffer and advances one hop. */
  private take(
    input: DataPacket,
    needed: number,
    windowSamples: number,
    hopSamples: number,
    deliveredHop: number
  ): DataPacket {
    const window = Float32Array.from(this.buffer.slice(0, needed));
    // Samples per channel that arrived after this window's last one.
    const later = (this.buffer.length - needed) / this.channelCount;
    this.buffer.splice(0, hopSamples * this.channelCount);

    const rate = input.metadata.samplingRate;
    const timestamp = rate ? input.timestamp - (later * 1000) / rate : input.timestamp;
    return this.buildPacket(input, window, deliveredHop, timestamp);
  }

  private buildPacket(
    input: DataPacket,
    data: Float32Array,
    deliveredHop: number,
    timestamp?: number
  ): DataPacket {
    const rate = input.metadata.samplingRate;

    return this.emitDeclared(input, data, {
      timestamp,
      // How often a downstream node will see a packet. Feature analyzers
      // publish this as their own sampling rate. Known here from the packet in
      // hand, where `outputOptions` could only estimate it.
      additionalMetadata: { packetRate: rate ? rate / deliveredHop : undefined },
    })!;
  }
}
