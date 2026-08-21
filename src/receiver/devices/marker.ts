import { Modality, ProcessingStage } from "../../data_stream.interface";
import { BaseReceiver } from "../base_receiver";

export interface MarkerOptions {
  /** Device ID for the marker stream. Defaults to `"markers"`. */
  deviceID?: string;
  /** Name segment of the stream ID, for running several marker sources. */
  name?: string;
  /** Label shown for the stream's single channel. */
  channelLabel?: string;
}

export interface MarkOptions {
  /**
   * Numeric code for this marker.
   *
   * Left out, the receiver assigns one per distinct label, counting from 1 in
   * first-seen order.
   */
  value?: number;
  /**
   * When the event happened, in ms UTC.
   *
   * Pass `Date.now()` captured at the moment of the event rather than letting
   * it default — see the note on latency below.
   */
  timestamp?: number;
}

/**
 * A stream of timed events pushed in by hand.
 *
 * Every other receiver pulls from something — a socket, a headset, a camera.
 * This one is driven by whatever code is running alongside the pipeline, which
 * is what makes it the bridge to an experiment: a jsPsych trial calls
 * {@link mark} in its `on_start`, and the resulting packet is timestamped and
 * recorded on the same clock as the EEG next to it.
 *
 * ```ts
 * const markers = new MarkerReceiver();
 * markers.connect();
 *
 * // in a jsPsych trial
 * on_start: () => markers.mark("stimulus_onset", { timestamp: Date.now() }),
 * ```
 *
 * Markers are categorical: each packet carries one sample whose meaning is
 * the string in `labels`, with the numeric code in `data` so that a CSV column
 * and any numeric consumer still see something sensible. Because the stream is
 * irregular it has no `samplingRate`, and the compatibility layer uses that
 * plus its `valueType` to keep it out of analyzers that would silently produce
 * nonsense from it.
 *
 * On timing: `mark()` defaults to stamping the moment it is called, which is
 * already after whatever work happened between the event and the call. Passing
 * an explicit `timestamp` captured at the event itself is the difference
 * between millisecond and best-effort alignment, so it is worth doing wherever
 * the onset is what you will analyse against.
 */
export class MarkerReceiver extends BaseReceiver {
  deviceName = "Markers";
  modalities: Modality[] = [Modality.EVENT_MARKER];
  deviceID: string | number;

  private readonly name?: string;
  private readonly channelLabel: string;
  private streaming = false;

  /**
   * Label to numeric code, mutated in place as new labels appear.
   *
   * The same object is handed to the stream's metadata, so every packet — and
   * therefore the recorder's copy of it — sees the table grow. That is what
   * makes an exported recording self-describing without the caller having to
   * declare their markers up front, which is exactly what a pre-registered
   * code table would force them to do.
   */
  private readonly codes: Record<string, number> = {};

  constructor(options: MarkerOptions = {}) {
    super();
    this.deviceID = options.deviceID ?? "markers";
    this.name = options.name;
    this.channelLabel = options.channelLabel ?? "marker";
  }

  /** Codes assigned so far, keyed by label. */
  get markerCodes(): Readonly<Record<string, number>> {
    return this.codes;
  }

  /**
   * Opens the stream. There is no device to reach, so this cannot fail.
   *
   * Marking begins immediately; `stopStream()` is there for pausing a run
   * without tearing the stream down.
   */
  public connect(): void {
    if (this.isConnected) return;

    this.isConnected = true;
    this.streaming = true;

    this.initializeStream({
      modality: Modality.EVENT_MARKER,
      processingStage: ProcessingStage.RAW,
      name: this.name,
      additionalMetadata: {
        valueType: "categorical",
        channelCount: 1,
        channelInfo: [{ index: 0, label: this.channelLabel }],
        // No samplingRate: markers are sporadic by nature, and claiming a rate
        // would let rate-dependent analyzers accept the stream.
        additionalMetadata: { markerCodes: this.codes },
      },
    });
  }

  public disconnect(): void {
    this.streaming = false;
    this.isConnected = false;
  }

  public startStream(): void {
    this.streaming = true;
  }

  public stopStream(): void {
    this.streaming = false;
  }

  /**
   * Emits one marker.
   *
   * Silently does nothing while disconnected or stopped, so an experiment can
   * run start to finish whether or not anyone attached a headset — the markers
   * simply go nowhere.
   */
  public mark(label: string, options: MarkOptions = {}): void {
    if (!this.streaming) return;

    const value = options.value ?? this.codeFor(label);

    this.update(
      {
        modality: Modality.EVENT_MARKER,
        processingStage: ProcessingStage.RAW,
        name: this.name,
      },
      value,
      undefined,
      { timestamp: options.timestamp, labels: [label] }
    );
  }

  private codeFor(label: string): number {
    if (!(label in this.codes)) {
      this.codes[label] = Object.keys(this.codes).length + 1;
    }
    return this.codes[label];
  }
}
