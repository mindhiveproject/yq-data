/**
 * The `lsl` protocol — what a Lab Streaming Layer relay says, and how it
 * becomes yq-data streams.
 *
 * LSL is a native protocol with no browser binding, so a relay running on the
 * machine the streams are on forwards them as JSON of the form
 * `{ "<streamKey>": { info: {...}, timeseries: [...], timestamp: n } }`. The
 * first message for a stream carries its `info` and registers it; later
 * messages carry samples. That shape is what LSLWebsocketMirror produces, and
 * any relay emitting the same JSON works.
 *
 * This is a translation layer onto the package's own streams, so it is
 * decode-only: yq-data sends nothing back to LSL. It is stateful — it
 * remembers which streams it has registered, and the numeric codes it has
 * handed out to marker labels — so each receiver gets its own instance.
 *
 * Over any transport it is just a protocol:
 *
 * ```ts
 * new RemoteStreamReceiver(new WebSocketTransport(url), { protocol: new LSLProtocol() });
 * ```
 *
 * `LSLReceiver` is that, plus reconnecting and a friendlier `connect(url)`.
 *
 * @see https://github.com/esromerog/LSLWebsocketMirror
 * @see https://labstreaminglayer.readthedocs.io
 */
import {
  ChannelInfo,
  Modality,
  ProcessingStage,
  StreamMetadata,
} from "../data_stream.interface";
import { genericChannelInfo, streamIDToString } from "../utility";
import { DecodeContext, Decoded, Protocol } from "./protocol";

export const LSL_PROTOCOL = "lsl";
/**
 * Version of this package's reading of the relay's JSON. LSL's own streams
 * carry no such number; the relay format has never changed shape.
 */
export const LSL_PROTOCOL_VERSION = 1;

/**
 * LSL channel format codes.
 *
 * String (3) and int64 (7) are excluded: packets carry numeric typed arrays,
 * and int64 does not survive the JSON relay without precision loss.
 */
const NUMERIC_FORMATS = new Set([1, 2, 4, 5, 6]);

/** Maps common LSL stream types onto the package's modality vocabulary. */
const TYPE_TO_MODALITY: Record<string, Modality> = {
  eeg: Modality.EEG,
  ecg: Modality.ECG,
  emg: Modality.EMG,
  eda: Modality.EDA,
  gsr: Modality.EDA,
  ppg: Modality.PPG,
  gaze: Modality.GAZE,
  eyetracking: Modality.GAZE,
  audio: Modality.AUDIO,
  markers: Modality.EVENT_MARKER,
  accelerometer: Modality.ACCELEROMETER,
  gyroscope: Modality.GYROSCOPE,
  respiration: Modality.RESPIRATION,
  temperature: Modality.TEMPERATURE,
};

function modalityFor(type: string | undefined): Modality {
  if (!type) return Modality.UNKNOWN;
  return TYPE_TO_MODALITY[type.toLowerCase().replace(/[\s_-]/g, "")] ??
    Modality.UNKNOWN;
}

/** Description of one LSL stream as reported by the relay. */
export interface LSLStreamInfo {
  name?: string;
  type?: string;
  channel_count?: number;
  nominal_srate?: number;
  channel_format?: number;
  source_id?: string;
  desc?: any;
}

interface LSLMessage {
  [streamKey: string]: {
    info?: LSLStreamInfo;
    /** Numbers for an ordinary stream; strings for a marker stream. */
    timeseries?: Array<number | string | Array<number | string>>;
    timestamp?: number;
  };
}

interface RegisteredStream {
  /** The yq-data stream ID this LSL stream publishes under. */
  streamID: string;
  /** Marker stream: samples are labels, and `codes` maps them to numbers. */
  categorical: boolean;
  /** Label to numeric code, mutated in place and shared into the metadata. */
  codes?: Record<string, number>;
}

const isRecord = (value: unknown): value is LSLMessage =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Flattens an LSL marker payload into one label per sample.
 *
 * Relays present markers either as a flat list of samples or as a list of
 * one-element channel arrays, and the values may already be numbers if the
 * stream was declared with a numeric format. All of it collapses to strings.
 */
function markerLabelsFrom(timeseries: unknown[]): string[] {
  const labels: string[] = [];
  for (const sample of timeseries) {
    const value = Array.isArray(sample) ? sample[0] : sample;
    if (value === undefined || value === null) continue;
    labels.push(String(value));
  }
  return labels;
}

/**
 * Pulls channel labels out of an LSL stream description.
 *
 * The relay may present `desc.channels.channel` as an array or, for a
 * single-channel stream, as a bare object — both shapes occur in the wild.
 */
function channelInfoFrom(info: LSLStreamInfo, channelCount: number): ChannelInfo[] {
  const raw = info.desc?.channels?.channel;
  const entries = Array.isArray(raw) ? raw : raw ? [raw] : [];

  if (entries.length === 0) {
    return genericChannelInfo(channelCount, info.type || "Channel");
  }

  return Array.from({ length: channelCount }, (_, index) => {
    const entry = entries[index] ?? {};
    const label =
      (Array.isArray(entry.label) ? entry.label[0] : entry.label) ??
      (Array.isArray(entry.name) ? entry.name[0] : entry.name) ??
      `${info.type || "Channel"} ${index + 1}`;
    const unit = Array.isArray(entry.unit) ? entry.unit[0] : entry.unit;
    return { index, label: String(label), ...(unit ? { unit: String(unit) } : {}) };
  });
}

export class LSLProtocol implements Protocol {
  readonly name = LSL_PROTOCOL;
  readonly version = LSL_PROTOCOL_VERSION;

  private readonly registered = new Map<string, RegisteredStream>();

  /** Stream keys the relay has announced so far. */
  get streamKeys(): string[] {
    return Array.from(this.registered.keys());
  }

  /** Forgets every stream and marker code, as if the relay were new. */
  reset(): void {
    this.registered.clear();
  }

  /** Nothing is sent back to LSL. */
  encodePacket(): unknown[] {
    return [];
  }

  decode(value: unknown, context?: DecodeContext): Decoded[] {
    if (!isRecord(value)) {
      console.warn("Ignoring unparseable LSL message.");
      return [];
    }

    const updates: Decoded[] = [];

    for (const streamKey of Object.keys(value)) {
      const entry = value[streamKey];
      if (!entry) continue;

      const stream = this.registered.get(streamKey);
      if (!stream) {
        // An info message announces the stream; samples follow separately.
        const meta = entry.info && this.register(streamKey, entry.info);
        if (meta) updates.push(meta);
        continue;
      }

      // Samples are about to be dropped. Not decoding them keeps a marker
      // label from being given a code nobody will ever see used.
      if (context && !context.streaming) continue;
      if (!Array.isArray(entry.timeseries)) continue;

      // LSL timestamps are seconds in the sender's clock domain.
      const deviceTime =
        entry.timestamp !== undefined ? entry.timestamp * 1000 : undefined;

      if (stream.categorical) {
        const labels = markerLabelsFrom(entry.timeseries);
        if (labels.length === 0) continue;
        updates.push({
          kind: "packet",
          streamID: stream.streamID,
          data: labels.map((label) => this.codeFor(stream, label)),
          deviceTime,
          labels,
        });
        continue;
      }

      // Non-categorical streams passed the numeric-format guard at
      // registration, so the payload is numbers however the union is typed.
      updates.push({
        kind: "packet",
        streamID: stream.streamID,
        data: entry.timeseries as ArrayLike<number> | ArrayLike<number>[],
        deviceTime,
      });
    }

    return updates;
  }

  private register(streamKey: string, info: LSLStreamInfo): Decoded | undefined {
    const modality = modalityFor(info.type);

    // A marker stream is categorical whatever format it declares. LSL markers
    // are conventionally strings, which is precisely the format the numeric
    // guard below rejects — so the check has to come after this, or the one
    // stream type an experiment most needs would be dropped on arrival.
    const categorical = modality === Modality.EVENT_MARKER;

    const format = info.channel_format;
    if (!categorical && format !== undefined && !NUMERIC_FORMATS.has(format)) {
      console.warn(
        `LSL stream "${streamKey}" uses a non-numeric channel format (${format}) and cannot be streamed as packets.`
      );
      return undefined;
    }

    // Markers carry one label per sample, so the stream is single-channel
    // however many channels the relay announces.
    const channelCount = categorical ? 1 : info.channel_count ?? 1;
    const name = (info.name ?? streamKey).replace(/:/g, "_");
    const deviceID = (info.source_id || info.name || streamKey).replace(/:/g, "_");
    const codes: Record<string, number> | undefined = categorical ? {} : undefined;

    // A relay registers each stream under its *source's* ID, never the
    // receiver's own, so one relay can carry several devices.
    const streamID = streamIDToString({
      deviceID,
      modality,
      processingStage: ProcessingStage.RAW,
      name,
    });

    this.registered.set(streamKey, { streamID, categorical, codes });

    const metadata: Partial<StreamMetadata> = {
      modality,
      // A marker stream declares no rate even when the relay reports one:
      // the absence is what keeps rate-dependent nodes off it, and an
      // irregular stream that claims a nominal rate is simply wrong.
      samplingRate: categorical ? undefined : info.nominal_srate || undefined,
      ...(categorical ? { valueType: "categorical" as const } : {}),
      channelCount,
      channelInfo: categorical
        ? [{ index: 0, label: name || "marker" }]
        : channelInfoFrom(info, channelCount),
      additionalMetadata: {
        lsl: info,
        streamKey,
        ...(codes ? { markerCodes: codes } : {}),
      },
    };

    return { kind: "meta", streamID, metadata };
  }

  /**
   * Numeric code for a marker label, assigned on first sight.
   *
   * Matches `MarkerReceiver`: the table is shared into the stream's metadata,
   * so an exported recording explains its own codes without the experiment
   * having had to declare them up front.
   */
  private codeFor(stream: RegisteredStream, label: string): number {
    const codes = stream.codes!;
    if (!(label in codes)) codes[label] = Object.keys(codes).length + 1;
    return codes[label];
  }
}
