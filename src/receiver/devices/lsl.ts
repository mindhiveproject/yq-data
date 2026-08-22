import {
  ChannelInfo,
  Modality,
  ProcessingStage,
  StreamIdentifierLiteral,
} from "../../data_stream.interface";
import { BaseReceiver } from "../base_receiver";
import { genericChannelInfo } from "../../utility";

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
interface LSLStreamInfo {
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

export interface LSLOptions {
  /** Reconnect automatically after an unexpected close. */
  autoReconnect?: boolean;
  /** Initial reconnect delay in ms; doubles up to `maxReconnectDelay`. */
  reconnectDelay?: number;
  maxReconnectDelay?: number;
}

interface RegisteredStream {
  streamID: StreamIdentifierLiteral;
  modality: Modality;
  name: string;
  deviceID: string;
  channelCount: number;
  /** Marker stream: samples are labels, and `codes` maps them to numbers. */
  categorical: boolean;
  /** Label to numeric code, mutated in place and shared into the metadata. */
  codes?: Record<string, number>;
}

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
 * Lab Streaming Layer receiver, over a WebSocket relay.
 *
 * LSL itself is a native protocol with no browser binding, so this expects a
 * relay that forwards streams as JSON of the form
 * `{ "<streamKey>": { info: {...}, timeseries: [...], timestamp: n } }`.
 * The first message for a stream carries its `info` and registers it; later
 * messages carry samples.
 *
 * That shape is what LSLWebsocketMirror produces — a Python script the user
 * runs on the machine the LSL streams are on. Any relay emitting the same
 * JSON works; there is no other requirement.
 *
 * @see https://github.com/esromerog/LSLWebsocketMirror
 * @see https://labstreaminglayer.readthedocs.io
 *
 * One relay commonly carries several devices, so each LSL stream becomes its
 * own yq-data stream, identified by that stream's `source_id`.
 */
export class LSLReceiver extends BaseReceiver {
  deviceName: string = "LSL";
  modalities: Modality[] = [Modality.UNKNOWN];
  deviceID: string | number;

  private socket: WebSocket | undefined;
  private socketURL = "";
  private registered = new Map<string, RegisteredStream>();
  private streaming = false;
  private options: Required<LSLOptions>;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private currentDelay: number;
  private intentionalClose = false;

  constructor(options: LSLOptions = {}) {
    super();
    this.deviceID = "LSL";
    this.options = {
      autoReconnect: true,
      reconnectDelay: 1000,
      maxReconnectDelay: 15000,
      ...options,
    };
    this.currentDelay = this.options.reconnectDelay;
  }

  /** Stream keys the relay has announced so far. */
  get discoveredStreams(): string[] {
    return Array.from(this.registered.keys());
  }

  public async connect(socketURL: string): Promise<void> {
    if (this.isConnected) {
      console.warn("LSL receiver is already connected.");
      return;
    }

    this.socketURL = socketURL;
    this.intentionalClose = false;
    await this.openSocket();
  }

  private openSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(this.socketURL);
      this.socket = socket;

      socket.onopen = () => {
        this.isConnected = true;
        this.currentDelay = this.options.reconnectDelay;
        resolve();
      };

      socket.onerror = (event) => {
        console.error("LSL WebSocket error:", event);
        if (!this.isConnected) reject(new Error("Unable to reach LSL relay."));
      };

      socket.onclose = () => {
        this.isConnected = false;
        if (!this.intentionalClose && this.options.autoReconnect) {
          this.scheduleReconnect();
        }
      };

      socket.onmessage = (event) => this.handleMessage(event);
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    const delay = this.currentDelay;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      // Back off so a relay that is down does not get hammered.
      this.currentDelay = Math.min(
        this.currentDelay * 2,
        this.options.maxReconnectDelay
      );
      this.openSocket().catch(() => this.scheduleReconnect());
    }, delay);
  }

  private handleMessage(event: MessageEvent): void {
    let payload: LSLMessage;
    try {
      payload = JSON.parse(event.data);
    } catch {
      console.warn("Ignoring unparseable LSL message.");
      return;
    }

    for (const streamKey of Object.keys(payload)) {
      const entry = payload[streamKey];
      if (!entry) continue;

      if (!this.registered.has(streamKey)) {
        if (entry.info) this.register(streamKey, entry.info);
        // An info message announces the stream; samples follow separately.
        continue;
      }

      if (!this.streaming) continue;
      if (!Array.isArray(entry.timeseries)) continue;

      const stream = this.registered.get(streamKey)!;
      const identifier = {
        modality: stream.modality,
        processingStage: ProcessingStage.RAW,
        name: stream.name,
        deviceID: stream.deviceID,
      };
      // LSL timestamps are seconds in the sender's clock domain.
      const deviceTime =
        entry.timestamp !== undefined ? entry.timestamp * 1000 : undefined;

      if (stream.categorical) {
        const labels = markerLabelsFrom(entry.timeseries);
        if (labels.length === 0) continue;
        this.update(
          identifier,
          labels.map((label) => this.codeFor(stream, label)),
          deviceTime,
          { labels }
        );
        continue;
      }

      // Non-categorical streams passed the numeric-format guard at
      // registration, so the payload is numbers however the union is typed.
      this.update(
        identifier,
        entry.timeseries as ArrayLike<number> | ArrayLike<number>[],
        deviceTime
      );
    }
  }

  private register(streamKey: string, info: LSLStreamInfo): void {
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
      return;
    }

    // Markers carry one label per sample, so the stream is single-channel
    // however many channels the relay announces.
    const channelCount = categorical ? 1 : info.channel_count ?? 1;
    const name = (info.name ?? streamKey).replace(/:/g, "_");
    const deviceID = (info.source_id || info.name || streamKey).replace(
      /:/g,
      "_"
    );
    const codes: Record<string, number> | undefined = categorical ? {} : undefined;

    const streamID = this.initializeStream({
      modality,
      processingStage: ProcessingStage.RAW,
      name,
      deviceID,
      additionalMetadata: {
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
      },
    });

    if (!this.modalities.includes(modality)) this.modalities.push(modality);

    this.registered.set(streamKey, {
      streamID,
      modality,
      name,
      deviceID,
      channelCount,
      categorical,
      codes,
    });
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

  public startStream(): void {
    this.streaming = true;
  }

  public stopStream(): void {
    this.streaming = false;
  }

  public async disconnect(): Promise<void> {
    this.intentionalClose = true;
    this.streaming = false;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }

    if (this.socket) {
      this.socket.onmessage = null;
      this.socket.onclose = null;
      this.socket.onerror = null;
      if (
        this.socket.readyState === WebSocket.OPEN ||
        this.socket.readyState === WebSocket.CONNECTING
      ) {
        this.socket.close(1000);
      }
      this.socket = undefined;
    }

    this.isConnected = false;
  }
}

/**
 * Pulls channel labels out of an LSL stream description.
 *
 * The relay may present `desc.channels.channel` as an array or, for a
 * single-channel stream, as a bare object — both shapes occur in the wild.
 */
function channelInfoFrom(
  info: LSLStreamInfo,
  channelCount: number
): ChannelInfo[] {
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
