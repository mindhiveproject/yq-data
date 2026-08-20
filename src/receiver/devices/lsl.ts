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
    timeseries?: number[];
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
}

/**
 * Lab Streaming Layer receiver, over a WebSocket relay.
 *
 * LSL itself is a native protocol with no browser binding, so this expects a
 * relay that forwards streams as JSON of the form
 * `{ "<streamKey>": { info: {...}, timeseries: [...], timestamp: n } }` —
 * the shape the reference You-Quantified bridge produces. The first message
 * for a stream carries its `info` and registers it; later messages carry
 * samples.
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
      this.update(
        {
          modality: stream.modality,
          processingStage: ProcessingStage.RAW,
          name: stream.name,
          deviceID: stream.deviceID,
        },
        entry.timeseries,
        // LSL timestamps are seconds in the sender's clock domain.
        entry.timestamp !== undefined ? entry.timestamp * 1000 : undefined
      );
    }
  }

  private register(streamKey: string, info: LSLStreamInfo): void {
    const format = info.channel_format;
    if (format !== undefined && !NUMERIC_FORMATS.has(format)) {
      console.warn(
        `LSL stream "${streamKey}" uses a non-numeric channel format (${format}) and cannot be streamed as packets.`
      );
      return;
    }

    const channelCount = info.channel_count ?? 1;
    const modality = modalityFor(info.type);
    const name = (info.name ?? streamKey).replace(/:/g, "_");
    const deviceID = (info.source_id || info.name || streamKey).replace(
      /:/g,
      "_"
    );

    const streamID = this.initializeStream({
      modality,
      processingStage: ProcessingStage.RAW,
      name,
      deviceID,
      additionalMetadata: {
        samplingRate: info.nominal_srate || undefined,
        channelCount,
        channelInfo: channelInfoFrom(info, channelCount),
        additionalMetadata: { lsl: info, streamKey },
      },
    });

    if (!this.modalities.includes(modality)) this.modalities.push(modality);

    this.registered.set(streamKey, {
      streamID,
      modality,
      name,
      deviceID,
      channelCount,
    });
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
