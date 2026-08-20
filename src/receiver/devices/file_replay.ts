import {
  ChannelInfo,
  Modality,
  ProcessingStage,
  StreamIdentifierLiteral,
} from "../../data_stream.interface";
import { BaseReceiver } from "../base_receiver";
import { BehaviorSubject } from "rxjs";

/** One row of the archive's `metadata.csv`. */
export interface RecordingMetadata {
  "recording id"?: string;
  "file name"?: string;
  "device id"?: string;
  "device name"?: string;
  type?: string;
  sampling_rate?: string | number;
  [key: string]: any;
}

interface LoadedTrack {
  streamID: StreamIdentifierLiteral;
  modality: Modality;
  name: string;
  deviceID: string;
  channels: string[];
  /** Interleaved samples for the whole recording. */
  data: Float32Array;
  sampleCount: number;
  samplingRate: number;
  /** Fractional read position, in samples. */
  cursor: number;
}

export interface ReplayOptions {
  /** Restart from the beginning when the recording ends. */
  loop?: boolean;
  /** Playback speed multiplier. */
  speed?: number;
  /** How often the playback clock ticks, in ms. */
  tickInterval?: number;
}

const MODALITY_ALIASES: Record<string, Modality> = {
  eeg: Modality.EEG,
  "eeg metrics": Modality.EEG,
  "raw eeg channels": Modality.EEG,
  "band powers": Modality.EEG,
  ppg: Modality.PPG,
  ecg: Modality.ECG,
  emg: Modality.EMG,
  eda: Modality.EDA,
  "heart rate": Modality.PPG,
  hr: Modality.PPG,
  video: Modality.VIDEO,
  audio: Modality.AUDIO,
  gaze: Modality.GAZE,
  movement: Modality.ACCELEROMETER,
};

function modalityFor(type: string | undefined): Modality {
  if (!type) return Modality.UNKNOWN;
  return MODALITY_ALIASES[type.toLowerCase().trim()] ?? Modality.UNKNOWN;
}

function sanitize(value: string): string {
  return value.replace(/:/g, "_").trim();
}

/**
 * Replays a recorded session as if it were a live device.
 *
 * This is the only receiver that needs no hardware, no permissions and no
 * network, which makes it the one to develop and test everything else
 * against — a pipeline driven by a replayed Muse session behaves exactly as
 * it will with the headset on someone's head.
 *
 * Reads the archive format {@link Recorder} writes, which is also what the
 * original You-Quantified recorder produced: a zip containing `metadata.csv`
 * plus one CSV per stream, each with a header row of channel names.
 *
 * `jszip` and `papaparse` are optional peer dependencies, imported only when
 * an archive is actually loaded.
 */
export class FileReplayReceiver extends BaseReceiver {
  deviceName = "Recording";
  modalities: Modality[] = [];
  deviceID: string | number;

  /** Playback position as a fraction of the recording's length, 0–1. */
  public readonly progress$ = new BehaviorSubject<number>(0);
  /** Whether playback is currently advancing. */
  public readonly isPlaying$ = new BehaviorSubject<boolean>(false);

  private tracks: LoadedTrack[] = [];
  private timer: ReturnType<typeof setInterval> | undefined;
  private lastTick = 0;
  private options: Required<ReplayOptions>;

  constructor(options: ReplayOptions = {}) {
    super();
    this.deviceID = "recording";
    this.options = {
      loop: false,
      speed: 1,
      tickInterval: 40,
      ...options,
    };
  }

  get loop(): boolean {
    return this.options.loop;
  }
  set loop(value: boolean) {
    this.options.loop = value;
  }

  get speed(): number {
    return this.options.speed;
  }
  set speed(value: number) {
    this.options.speed = Math.max(0.01, value);
  }

  /** Longest track's duration in seconds. */
  get duration(): number {
    return this.tracks.reduce(
      (longest, track) =>
        Math.max(longest, track.sampleCount / track.samplingRate),
      0
    );
  }

  /** Summary of the loaded tracks, for a UI to list. */
  get trackInfo(): Array<{
    streamID: string;
    channels: string[];
    samplingRate: number;
    samples: number;
  }> {
    return this.tracks.map((t) => ({
      streamID: t.streamID,
      channels: t.channels,
      samplingRate: t.samplingRate,
      samples: t.sampleCount,
    }));
  }

  /**
   * `connect` on this receiver means "load an archive".
   *
   * @param source A zip Blob/File, or a URL to fetch one from.
   */
  public async connect(source: Blob | string): Promise<void> {
    const blob =
      typeof source === "string" ? await (await fetch(source)).blob() : source;

    const [{ default: JSZip }, papa] = await Promise.all([
      loadJSZip(),
      loadPapaparse(),
    ]);

    const zip = await JSZip.loadAsync(blob);
    const paths = Object.keys(zip.files);

    // Archives are sometimes wrapped in a single top-level folder, depending
    // on how they were zipped or re-zipped by the OS.
    const metadataPath = paths.find((p) => p.endsWith("metadata.csv"));
    if (!metadataPath) {
      throw new Error(
        "Archive is missing metadata.csv and cannot be interpreted."
      );
    }
    const prefix = metadataPath.slice(0, metadataPath.length - "metadata.csv".length);

    const metadataText = await zip.files[metadataPath].async("string");
    const metadataRows: RecordingMetadata[] = papa.parse(metadataText, {
      header: true,
      skipEmptyLines: true,
    }).data;

    this.tracks = [];

    for (const row of metadataRows) {
      const fileName = row["file name"];
      if (!fileName) continue;

      const entry = zip.files[prefix + fileName] ?? zip.files[fileName];
      if (!entry) {
        console.warn(`Archive lists "${fileName}" but does not contain it.`);
        continue;
      }

      const text = await entry.async("string");
      const parsed = papa.parse(text, { header: true, skipEmptyLines: true });
      const rows: Record<string, string>[] = parsed.data;
      if (rows.length === 0) continue;

      const channels = (parsed.meta?.fields ?? Object.keys(rows[0])).filter(
        // Timestamp columns are bookkeeping, not signal.
        (field: string) => !/^(timestamp|time|lsl timestamp)$/i.test(field)
      );
      if (channels.length === 0) continue;

      const data = new Float32Array(rows.length * channels.length);
      for (let i = 0; i < rows.length; i++) {
        for (let c = 0; c < channels.length; c++) {
          const value = Number(rows[i][channels[c]]);
          data[i * channels.length + c] = Number.isFinite(value) ? value : 0;
        }
      }

      const samplingRate = Number(row.sampling_rate) || 60;
      const modality = modalityFor(row.type);
      const deviceID = sanitize(
        row["device id"] || row["device name"] || "recording"
      );
      const name = sanitize(
        row["recording id"] || fileName.replace(/\.csv$/i, "")
      );

      const channelInfo: ChannelInfo[] = channels.map(
        (label: string, index: number) => ({ index, label })
      );

      const streamID = this.initializeStream({
        modality,
        processingStage: ProcessingStage.RAW,
        name,
        deviceID,
        additionalMetadata: {
          samplingRate,
          channelInfo,
          additionalMetadata: {
            source: "recording",
            deviceName: row["device name"],
          },
        },
      });

      if (!this.modalities.includes(modality)) this.modalities.push(modality);

      this.tracks.push({
        streamID,
        modality,
        name,
        deviceID,
        channels,
        data,
        sampleCount: rows.length,
        samplingRate,
        cursor: 0,
      });
    }

    if (this.tracks.length === 0) {
      throw new Error("Archive contained no readable data files.");
    }

    this.isConnected = true;
  }

  /** Begins (or resumes) playback. */
  public startStream(): void {
    if (!this.isConnected || this.timer !== undefined) return;

    this.lastTick = performance.now();
    this.isPlaying$.next(true);
    this.timer = setInterval(() => this.tick(), this.options.tickInterval);
  }

  /** Pauses playback, keeping the current position. */
  public stopStream(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.isPlaying$.next(false);
  }

  /** Jumps to a position given as a fraction of the recording, 0–1. */
  public seek(fraction: number): void {
    const clamped = Math.min(1, Math.max(0, fraction));
    for (const track of this.tracks) {
      track.cursor = clamped * track.sampleCount;
    }
    this.progress$.next(clamped);
  }

  /** Returns to the start without changing play/pause state. */
  public restart(): void {
    this.seek(0);
  }

  public async disconnect(): Promise<void> {
    this.stopStream();
    this.tracks = [];
    this.progress$.next(0);
    this.isConnected = false;
  }

  /**
   * Advances every track by the elapsed wall-clock time.
   *
   * Tracks are advanced independently against a shared clock rather than each
   * getting its own timer, so a 256 Hz EEG track and a 10 Hz feature track
   * recorded together stay aligned during playback.
   */
  private tick(): void {
    const now = performance.now();
    const elapsed = ((now - this.lastTick) / 1000) * this.options.speed;
    this.lastTick = now;

    let finished = true;

    for (const track of this.tracks) {
      const advance = elapsed * track.samplingRate;
      const start = Math.floor(track.cursor);
      const end = Math.floor(track.cursor + advance);
      track.cursor += advance;

      const available = Math.min(end, track.sampleCount) - start;
      if (available > 0) {
        const channels = track.channels.length;
        this.update(
          {
            modality: track.modality,
            processingStage: ProcessingStage.RAW,
            name: track.name,
            deviceID: track.deviceID,
          },
          track.data.subarray(start * channels, (start + available) * channels)
        );
      }

      if (track.cursor < track.sampleCount) finished = false;
    }

    const longest = this.tracks.reduce(
      (max, t) => Math.max(max, t.cursor / t.sampleCount),
      0
    );
    this.progress$.next(Math.min(1, longest));

    if (!finished) return;

    if (this.options.loop) {
      this.seek(0);
    } else {
      this.stopStream();
    }
  }
}

async function loadJSZip(): Promise<{ default: any }> {
  try {
    return (await import("jszip")) as any;
  } catch {
    throw new Error(
      "jszip is required to read recordings. Install it alongside yq-data: npm install jszip"
    );
  }
}

async function loadPapaparse(): Promise<any> {
  try {
    const mod: any = await import("papaparse");
    return mod.default ?? mod;
  } catch {
    throw new Error(
      "papaparse is required to read recordings. Install it alongside yq-data: npm install papaparse"
    );
  }
}
