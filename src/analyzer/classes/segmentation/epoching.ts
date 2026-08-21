import {
  AnalysisMethod,
  DataPacket,
  ProcessingStage,
} from "../../../data_stream.interface";
import {
  Accepts,
  MultiInputAnalyzer,
  SyncParameters,
} from "../../base_analyzer";
import { getChannelCount } from "../../../utility";

export type BaselineMode = "none" | "mean";

/** What to do with a marker arriving while an epoch is still filling. */
export type OverlapMode =
  /** Ignore it. One epoch at a time, which is what a trial-based design wants. */
  | "ignore"
  /** Start another epoch alongside the one in flight. */
  | "allow";

export interface EpochingParameters extends SyncParameters {
  /** Seconds of signal kept from *before* each marker. */
  pre?: number;
  /** Seconds of signal kept from *after* each marker. */
  post?: number;
  /**
   * Subtract the mean of the pre-marker window from every channel.
   *
   * On by default, and only meaningful when `pre > 0`: it removes the slow
   * drift that makes two epochs minutes apart incomparable, which is the whole
   * reason to keep a pre-window in the first place.
   */
  baseline?: BaselineMode;
  /** Whether a marker may open an epoch while another is still filling. */
  overlap?: OverlapMode;
  /** Only epoch these marker labels. Unset epochs every marker. */
  labels?: string[];
  /**
   * How late a marker may arrive, in seconds, relative to the signal it refers
   * to.
   *
   * Sets how much signal is retained beyond the epoch window itself, and so
   * how far back a marker can still reach. Two seconds by default, which
   * covers a headset buffering over BLE while an experiment marks its trials
   * against the wall clock. Raise it if markers cross a slow transport; the
   * cost is memory, at `samplingRate * channels` numbers per second.
   */
  markerLag?: number;
}

/** A marker that has opened an epoch not yet filled by enough signal. */
interface PendingEpoch {
  /** Marker onset, in ms UTC. The epoch is cut relative to this. */
  time: number;
  label: string;
  code: number;
}

/** Metadata attached to every epoch, under `additionalMetadata.epoch`. */
export interface EpochInfo {
  /** The marker that opened this epoch. */
  label: string;
  /** That marker's numeric code. */
  code: number;
  /** Marker onset in ms UTC, which is also the packet's timestamp. */
  markerTime: number;
  /** Seconds of signal before and after the marker. */
  pre: number;
  post: number;
  /** Samples per channel in this epoch. */
  samples: number;
  /** How many epochs this node has emitted, counting from 1. */
  index: number;
}

/**
 * Cuts a fixed window of signal around each event marker.
 *
 * This is the node that makes markers useful rather than merely recorded, and
 * the join the compatibility layer otherwise forbids: `signal` takes a sampled
 * numeric stream, `marker` takes a categorical one, and nothing else fits
 * either port.
 *
 * ```ts
 * const pipeline = new Pipeline({
 *   nodes: [
 *     { id: "eeg",     receiver: "muse", stream: Modality.EEG },
 *     { id: "markers", receiver: "markers" },
 *     { id: "epochs",  method: AnalysisMethod.EPOCHING,
 *       parameters: { pre: 0.2, post: 0.8 } },
 *   ],
 *   edges: [
 *     { from: ["eeg"],     to: ["epochs", "signal"] },
 *     { from: ["markers"], to: ["epochs", "marker"] },
 *   ],
 * });
 * ```
 *
 * Each epoch is emitted as one packet, stamped at the marker's onset rather
 * than at the moment it was cut, and carrying its marker in
 * {@link EpochInfo}. That pairing — signal as the values, marker label as the
 * annotation — is deliberately the shape a supervised classifier consumes:
 * the epoch is the feature vector and `epoch.label` is the target, so a
 * training node downstream needs no separate notion of where labels come from.
 *
 * Emitting *individual* epochs rather than a running average is the same
 * choice. An averaged evoked response is one thing you can build from these;
 * a training set is another; neither belongs inside the segmentation step.
 *
 * Because an epoch reaches back `pre` seconds, output necessarily lags the
 * marker by `post` seconds — the signal has to arrive before it can be cut.
 */
export class Epoching extends MultiInputAnalyzer {
  readonly name = "Epoching";
  readonly method = AnalysisMethod.EPOCHING;
  readonly stage = ProcessingStage.PREPROCESSED;
  readonly ports = ["signal", "marker"];

  readonly accepts: Record<string, Accepts> = {
    signal: { requiresSamplingRate: true },
    marker: { valueTypes: ["categorical"] },
  };

  /** Rolling interleaved signal, and the timestamp of each sample. */
  private samples: number[] = [];
  private times: number[] = [];

  private channelCount = 1;
  private rate = 0;
  private lastSignal: DataPacket | null = null;

  private queue: PendingEpoch[] = [];
  private emitted = 0;

  /**
   * Markers dropped because the buffer did not reach back far enough.
   *
   * Expected for the first marker of a session — nothing has `pre` seconds of
   * history a moment after connecting — and a sign of an undersized buffer or
   * a stalled stream if it keeps climbing.
   */
  public dropped = 0;

  constructor(parameters: EpochingParameters = {}) {
    super({
      pre: 0.2,
      post: 0.8,
      baseline: "mean",
      overlap: "ignore",
      labels: undefined,
      markerLag: 2,
      ...parameters,
    });

    // Not a default but a fixture: pairing a sporadic marker stream with a
    // continuous one under any of the other policies would either drop most
    // markers or re-fire on every one.
    this.syncPolicy = "event";
  }

  public reset(): void {
    this.samples = [];
    this.times = [];
    this.lastSignal = null;
    this.queue = [];
    this.rate = 0;
  }

  analyze(
    packets: Record<string, DataPacket | undefined>
  ): DataPacket | null {
    const signal = packets.signal;
    const marker = packets.marker;

    if (signal) this.ingest(signal);
    if (marker) this.arm(marker);

    return this.harvest();
  }

  /** Appends a signal packet to the rolling buffer, with per-sample times. */
  private ingest(packet: DataPacket): void {
    const rate = packet.metadata.samplingRate;
    if (!rate || rate <= 0) return;

    const channels = getChannelCount(packet);

    // A stream that changes layout mid-run is a different signal; keeping the
    // old samples would splice two geometries into one epoch.
    if (channels !== this.channelCount || rate !== this.rate) {
      this.samples = [];
      this.times = [];
      this.channelCount = channels;
      this.rate = rate;
    }

    this.lastSignal = packet;

    const count = Math.floor(packet.data.length / channels);
    for (let i = 0; i < count; i++) {
      for (let c = 0; c < channels; c++) {
        this.samples.push(packet.data[i * channels + c]);
      }
      // Packets carry one stamp for the whole chunk, taken as the first
      // sample's — the same reading the recorder uses, so an epoch cut live
      // lines up with the same epoch cut from the exported CSV.
      this.times.push(packet.timestamp + (i / rate) * 1000);
    }

    this.trim();
  }


  /**
   * Holds one epoch's worth of signal plus `markerLag` seconds of slack.
   *
   * The slack is the whole reason a late marker still works: trimming to the
   * window alone would discard the very samples a marker arriving a moment
   * later refers to, and the epoch would be dropped for want of history that
   * had been in memory seconds earlier.
   */
  private trim(): void {
    const span =
      this.parameters.pre + this.parameters.post + this.parameters.markerLag;
    const capacity = Math.ceil(span * this.rate) + 1;
    const excess = this.times.length - capacity;
    if (excess <= 0) return;

    this.times.splice(0, excess);
    this.samples.splice(0, excess * this.channelCount);
  }

  /** Opens an epoch for a marker, subject to the label and overlap rules. */
  private arm(packet: DataPacket): void {
    const label = packet.labels?.[0] ?? String(packet.data[0]);

    const wanted: string[] | undefined = this.parameters.labels;
    if (wanted && wanted.length > 0 && !wanted.includes(label)) return;

    if (this.parameters.overlap === "ignore" && this.queue.length > 0) return;

    this.queue.push({ time: packet.timestamp, label, code: packet.data[0] });
  }

  /**
   * Emits the oldest epoch whose window has filled, if any.
   *
   * At most one per call: a second epoch that became ready on the same packet
   * stays queued and lands on the next one, which only arises under
   * `overlap: "allow"` and costs it one packet of extra latency.
   */
  private harvest(): DataPacket | null {
    if (!this.lastSignal || this.rate <= 0 || this.queue.length === 0) {
      return null;
    }

    const { pre, post } = this.parameters;
    const wanted = Math.max(1, Math.round((pre + post) * this.rate));
    const latest = this.times[this.times.length - 1];

    while (this.queue.length > 0) {
      const epoch = this.queue[0];
      const start = epoch.time - pre * 1000;

      // Still filling: the tail of this epoch has not been recorded yet.
      if (latest < epoch.time + post * 1000) return null;

      this.queue.shift();

      const from = this.times.findIndex((time) => time >= start);
      if (from === -1 || from + wanted > this.times.length) {
        // The pre-window predates anything buffered, so this epoch can only be
        // produced truncated. Dropping it keeps every emitted epoch the same
        // length, which is what makes a set of them comparable at all.
        this.dropped++;
        continue;
      }

      return this.cut(epoch, from, wanted);
    }

    return null;
  }

  /** Builds the output packet for one epoch. */
  private cut(
    epoch: PendingEpoch,
    from: number,
    wanted: number
  ): DataPacket {
    const channels = this.channelCount;
    const out = new Float32Array(wanted * channels);

    for (let i = 0; i < wanted; i++) {
      for (let c = 0; c < channels; c++) {
        out[i * channels + c] = this.samples[(from + i) * channels + c];
      }
    }

    if (this.parameters.baseline === "mean") {
      this.removeBaseline(out, wanted, channels);
    }

    this.emitted++;

    const info: EpochInfo = {
      label: epoch.label,
      code: epoch.code,
      markerTime: epoch.time,
      pre: this.parameters.pre,
      post: this.parameters.post,
      samples: wanted,
      index: this.emitted,
    };

    return this.emit(this.lastSignal!, out, {
      samplingRate: this.rate,
      channelCount: channels,
      // Stamped at the event, not at the moment the window closed, so epochs
      // from different runs of the same trial line up against each other.
      timestamp: epoch.time,
      additionalMetadata: { epoch: info },
    });
  }

  /** Subtracts each channel's pre-marker mean from the whole epoch. */
  private removeBaseline(
    data: Float32Array,
    samples: number,
    channels: number
  ): void {
    const baselineSamples = Math.round(this.parameters.pre * this.rate);
    if (baselineSamples <= 0) return;

    const span = Math.min(baselineSamples, samples);

    for (let c = 0; c < channels; c++) {
      let sum = 0;
      for (let i = 0; i < span; i++) sum += data[i * channels + c];
      const mean = sum / span;
      for (let i = 0; i < samples; i++) data[i * channels + c] -= mean;
    }
  }
}
