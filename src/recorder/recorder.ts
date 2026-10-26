import {
  DataPacket,
  StreamMetadata,
  ValueType,
} from "../data_stream.interface";
import { BaseReceiver } from "../receiver/base_receiver";
import { getChannelCount, getValueType } from "../utility";
import { Observable, Subscription } from "rxjs";

export interface RecorderOptions {
  /**
   * Stop recording after this many samples per stream.
   *
   * A guard against an unattended session filling memory: an hour of 256 Hz
   * EEG is roughly a million samples per channel.
   */
  maxSamplesPerStream?: number;
  /** Include a wall-clock timestamp column in each CSV. */
  includeTimestamps?: boolean;
}

/** log2 of the values held by one chunk of a {@link ChunkedStore}. */
const CHUNK_SHIFT = 14;
const CHUNK_SIZE = 1 << CHUNK_SHIFT;
const CHUNK_MASK = CHUNK_SIZE - 1;

/**
 * An append-only list of numbers kept in fixed-size typed-array chunks.
 *
 * A plain `number[]` costs 8 bytes a value and reallocates as it grows; this
 * costs 4 (as `Float32Array`) or 8 (as `Float64Array`) and never copies what
 * it already holds. Samples arrive as float32, so storing them as float32
 * loses nothing: the CSV is the same text either way.
 */
class ChunkedStore {
  private readonly chunks: Array<Float32Array | Float64Array> = [];
  private filled = CHUNK_SIZE;
  length = 0;

  constructor(private readonly kind: typeof Float32Array | typeof Float64Array) {}

  push(value: number): void {
    if (this.filled === CHUNK_SIZE) {
      this.chunks.push(new this.kind(CHUNK_SIZE));
      this.filled = 0;
    }
    this.chunks[this.chunks.length - 1][this.filled++] = value;
    this.length++;
  }

  get(index: number): number {
    return this.chunks[index >>> CHUNK_SHIFT][index & CHUNK_MASK];
  }
}

interface Track {
  metadata: StreamMetadata;
  channels: string[];
  /** Interleaved samples accumulated so far, as float32 unless the packets are 32-bit integers. */
  rows: ChunkedStore;
  /** Wall-clock time of each sample; float64, because epoch milliseconds need it. */
  timestamps: ChunkedStore;
  /** Categorical value per sample, for streams that carry one. */
  labels: string[];
  valueType: ValueType;
  sampleCount: number;
  truncated: boolean;
}

/** Rows encoded per chunk when writing a CSV. See {@link Recorder.toCSV}. */
const CSV_ROWS_PER_CHUNK = 4096;

const README = `Hi! I'm a small file describing the contents of this folder.

Each recorded stream is saved as its own CSV file, with one column per channel
and one row per sample. metadata.csv lists every file along with its device,
signal type and sampling rate.

Streams of timed events (event markers) have a "label" column holding the
event name, and no sampling rate — one row per event rather than one row per
tick. Their numeric column is a per-label code, listed in metadata.csv's
companion stream, and exists only so the file still parses as numbers.

Data gathered in a web browser can have unreliable timing and sampling rates.
Be careful about relying on it for research purposes without validating the
timing against a reference.

These archives can be replayed with yq-data's FileReplayReceiver.
`;

/**
 * Captures live streams to a zip archive of CSV files.
 *
 * The archive is exactly what {@link FileReplayReceiver} reads, so recording a
 * session once gives you a repeatable input for developing and testing
 * everything downstream without wearing a headset.
 *
 * ```ts
 * const recorder = new Recorder();
 * recorder.addReceiver(muse);
 * recorder.start();
 * // ...later
 * recorder.stop();
 * await recorder.download();
 * ```
 */
export class Recorder {
  private tracks = new Map<string, Track>();
  private subscriptions: Subscription[] = [];
  private sources: Array<Observable<DataPacket>> = [];
  private recording = false;
  private startedAt = 0;
  private options: Required<RecorderOptions>;

  constructor(options: RecorderOptions = {}) {
    this.options = {
      maxSamplesPerStream: 2_000_000,
      includeTimestamps: true,
      ...options,
    };
  }

  /** Whether capture is currently running. */
  get isRecording(): boolean {
    return this.recording;
  }

  /** Seconds elapsed since `start()`. */
  get elapsed(): number {
    return this.recording ? (Date.now() - this.startedAt) / 1000 : 0;
  }

  /** Streams captured so far, with their sample counts. */
  get summary(): Array<{ streamID: string; channels: number; samples: number }> {
    return Array.from(this.tracks.entries()).map(([streamID, track]) => ({
      streamID,
      channels: track.channels.length,
      samples: track.sampleCount,
    }));
  }

  /** Records every stream a receiver produces, including ones added later. */
  public addReceiver(receiver: BaseReceiver<any>): void {
    this.addSource(receiver.data as Observable<DataPacket>);
  }

  /** Records a single observable of packets — a pipeline output, for instance. */
  public addSource(source: Observable<DataPacket>): void {
    this.sources.push(source);
    if (this.recording) this.subscribe(source);
  }

  private subscribe(source: Observable<DataPacket>): void {
    this.subscriptions.push(
      source.subscribe((packet) => this.capture(packet))
    );
  }

  public start(): void {
    if (this.recording) return;
    this.recording = true;
    this.startedAt = Date.now();
    this.sources.forEach((source) => this.subscribe(source));
  }

  public stop(): void {
    this.recording = false;
    this.subscriptions.forEach((s) => s.unsubscribe());
    this.subscriptions = [];
  }

  /** Discards everything captured so far. */
  public clear(): void {
    this.tracks.clear();
  }

  private capture(packet: DataPacket): void {
    const channelCount = getChannelCount(packet);
    let track = this.tracks.get(packet.streamID);

    if (!track) {
      const info = packet.metadata.channelInfo;
      const channels =
        info && info.length === channelCount
          ? info.map((c) => c.label)
          : Array.from({ length: channelCount }, (_, i) => `channel ${i + 1}`);

      track = {
        metadata: packet.metadata,
        channels,
        // Every packet type but the 32-bit integers is exact in float32.
        rows: new ChunkedStore(
          packet.data instanceof Int32Array || packet.data instanceof Uint32Array
            ? Float64Array
            : Float32Array
        ),
        timestamps: new ChunkedStore(Float64Array),
        labels: [],
        valueType: getValueType(packet.metadata),
        sampleCount: 0,
        truncated: false,
      };
      this.tracks.set(packet.streamID, track);
    }

    if (track.sampleCount >= this.options.maxSamplesPerStream) {
      if (!track.truncated) {
        track.truncated = true;
        console.warn(
          `Recorder reached its sample limit for ${packet.streamID}; further samples are dropped.`
        );
      }
      return;
    }

    const samples = Math.floor(packet.data.length / channelCount);
    const rate = packet.metadata.samplingRate;

    for (let i = 0; i < samples; i++) {
      for (let c = 0; c < channelCount; c++) {
        track.rows.push(packet.data[i * channelCount + c]);
      }
      if (track.valueType === "categorical") {
        track.labels.push(packet.labels?.[i] ?? "");
      }
      if (this.options.includeTimestamps) {
        // Packets carry one timestamp for the whole chunk; interpolate within
        // it so the column is monotonic rather than a staircase.
        track.timestamps.push(
          rate ? packet.timestamp + (i / rate) * 1000 : packet.timestamp
        );
      }
    }

    track.sampleCount += samples;
  }

  /** Builds the zip archive. */
  public async export(): Promise<Blob> {
    if (this.tracks.size === 0) {
      throw new Error("Nothing has been recorded yet.");
    }

    const { default: JSZip } = await loadJSZip();
    const zip = new JSZip();
    const metadataRows: Record<string, string | number>[] = [];

    for (const [streamID, track] of this.tracks) {
      const fileName = `${streamID.replace(/[:\s]+/g, "_")}.csv`;
      zip.file(fileName, this.toCSV(track));

      const device = track.metadata.deviceInfo;
      metadataRows.push({
        "recording id": track.metadata.name ?? streamID,
        "file name": fileName,
        "device id": String(device?.id ?? ""),
        "device name": device?.model ?? "",
        type: track.metadata.modality,
        sampling_rate: track.metadata.samplingRate ?? "",
        value_type: track.valueType,
        channels: track.channels.length,
        samples: track.sampleCount,
        stream_id: streamID,
      });
    }

    zip.file("metadata.csv", toCSVRows(metadataRows));
    zip.file("README.txt", README);

    return zip.generateAsync({ type: "blob" });
  }

  /** Builds the archive and hands it to the browser as a download. */
  public async download(fileName?: string): Promise<void> {
    const blob = await this.export();
    const url = URL.createObjectURL(blob);

    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = fileName ?? `yq_rec_${timestampSlug()}.zip`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();

    URL.revokeObjectURL(url);
  }

  /**
   * The track as CSV bytes.
   *
   * Encoded a few thousand rows at a time rather than joined into one string:
   * a JavaScript string tops out at about 536 million characters, which a
   * 32-channel recording at 1 kHz passes after fourteen minutes. The failure
   * would arrive as `RangeError: Invalid string length` when the session was
   * over and the data could only be saved, so the file is never held as text.
   */
  private toCSV(track: Track): Uint8Array {
    const channels = track.channels.length;
    // The label column comes first on a categorical track: it is the value
    // being recorded, and the numeric code beside it is only there so the file
    // still reads as numbers to anything that expects them.
    const categorical = track.valueType === "categorical";
    const header = [
      ...(this.options.includeTimestamps ? ["timestamp"] : []),
      ...(categorical ? ["label"] : []),
      ...track.channels,
    ];

    const encoder = new TextEncoder();
    const parts: Uint8Array[] = [];
    let size = 0;
    let lines: string[] = [header.map(escapeCSV).join(",")];

    const flush = () => {
      // Rows are separated by a newline and the file does not end in one, so
      // every chunk after the first opens with the separator.
      const bytes = encoder.encode((parts.length ? "\n" : "") + lines.join("\n"));
      parts.push(bytes);
      size += bytes.length;
      lines = [];
    };

    for (let i = 0; i < track.sampleCount; i++) {
      const values: (string | number)[] = [];
      if (this.options.includeTimestamps) values.push(track.timestamps.get(i));
      if (categorical) values.push(escapeCSV(track.labels[i] ?? ""));
      for (let c = 0; c < channels; c++) {
        values.push(track.rows.get(i * channels + c));
      }
      lines.push(values.join(","));
      if (lines.length >= CSV_ROWS_PER_CHUNK) flush();
    }
    if (lines.length > 0) flush();

    const out = new Uint8Array(size);
    let offset = 0;
    for (const part of parts) {
      out.set(part, offset);
      offset += part.length;
    }
    return out;
  }
}

function escapeCSV(value: string | number): string {
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function toCSVRows(rows: Record<string, string | number>[]): string {
  if (rows.length === 0) return "";
  const fields = Array.from(new Set(rows.flatMap((row) => Object.keys(row))));
  const lines = [fields.map(escapeCSV).join(",")];
  for (const row of rows) {
    lines.push(fields.map((field) => escapeCSV(row[field] ?? "")).join(","));
  }
  return lines.join("\n");
}

/** `YYYYMMDDThhmm`, matching the original recorder's file naming. */
function timestampSlug(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    "T",
    pad(date.getHours()),
    pad(date.getMinutes()),
  ].join("");
}

async function loadJSZip(): Promise<{ default: any }> {
  try {
    return (await import("jszip")) as any;
  } catch {
    throw new Error(
      "jszip is required to export recordings. Install it alongside yq-data: npm install jszip"
    );
  }
}
