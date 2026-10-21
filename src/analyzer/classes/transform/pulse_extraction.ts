import {
  AnalysisMethod,
  ChannelInfo,
  DataPacket,
  Modality,
  ProcessingStage,
  StreamMetadata,
} from "../../../data_stream.interface";
import { Accepts, BaseAnalyzer } from "../../base_analyzer";
import { GapDetector, getChannelCount, getSampleCount } from "../../../utility";
import {
  PulseAlgorithm,
  pulseWindow,
  pulseWindowLength,
} from "../../methods/rppg";

export interface PulseExtractionParameters {
  /**
   * How the three colour channels become one pulse. `pos` (default) is
   * Plane-Orthogonal-to-Skin (Wang et al., 2017); `green` is the green channel
   * alone, the baseline it improves on. See `methods/rppg.ts`.
   */
  algorithm?: PulseAlgorithm;
  /**
   * Length of the sliding window the colour is normalised over, in seconds.
   * Wang et al. use 1.6 s, long enough to hold one beat at 40 bpm and short
   * enough to follow a change in the light.
   */
  windowSeconds?: number;
  /**
   * Indices of the red, green and blue channels. By default they are found
   * by label (`red`/`green`/`blue`, or `r`/`g`/`b`), falling back to 0, 1, 2.
   */
  channels?: [number, number, number];
  /**
   * Missing time, in seconds, after which the node starts again rather than
   * normalising across the gap. As on `Windowing`; `"auto"` (default) acts on
   * streams that declare a sample clock, which `RPPGReceiver` does.
   */
  maxGap?: number | "auto";
}

const LABELS: Record<string, number> = {
  red: 0, r: 0,
  green: 1, g: 1,
  blue: 2, b: 2,
};

/**
 * Pulse waveform from a stream of skin colour: the camera's PPG.
 *
 * Takes the three-channel mean skin colour that `RPPGReceiver` emits and
 * emits a one-channel `ppg` stream named `pulse`, at the input's rate. From
 * there it is an ordinary pulse waveform, and the same `Windowing` →
 * `HeartRate` chain that serves a Muse PPG sensor turns it into a rate.
 *
 * Streaming, and exactly Wang et al.'s batch algorithm: every window of
 * `windowSeconds` is normalised, projected and overlap-added into the output,
 * and a sample is emitted once the last window covering it has been added.
 * The output therefore runs `windowSeconds` behind the input, and each packet
 * is stamped with the time of its own last sample, not the time it was
 * computed.
 *
 * The output's sign is flipped from the paper's so that, as on a contact PPG
 * sensor, each systole is a peak rather than a dip. Its scale is relative
 * colour change, so roughly 1e-3 for a real face.
 *
 * Wang, W., den Brinker, A.C., Stuijk, S. & de Haan, G. (2017). Algorithmic
 * principles of remote PPG. IEEE Trans Biomed Eng 64(7):1479–1491.
 * https://doi.org/10.1109/TBME.2016.2609282
 */
export class PulseExtraction extends BaseAnalyzer {
  readonly name = "PulseExtraction";
  readonly method = AnalysisMethod.PULSE_EXTRACTION;
  readonly stage = ProcessingStage.PREPROCESSED;

  readonly accepts: Accepts = { requiresSamplingRate: true };

  /** The newest `windowLength` samples of each colour channel. */
  private red: number[] = [];
  private green: number[] = [];
  private blue: number[] = [];
  /** Overlap-add sums for the samples not yet final, oldest first. */
  private pending: number[] = [];
  private windowLength = 0;
  private gaps: GapDetector;

  constructor(parameters: PulseExtractionParameters = {}) {
    super({
      algorithm: "pos",
      windowSeconds: 1.6,
      maxGap: "auto",
      ...parameters,
    });
    this.gaps = new GapDetector(this.parameters.maxGap);
  }

  public reset(): void {
    this.clear();
    this.gaps.reset();
  }

  private clear(): void {
    this.red = [];
    this.green = [];
    this.blue = [];
    this.pending = [];
  }

  private channelIndices(meta: StreamMetadata, count: number): number[] | null {
    let indices: number[] = this.parameters.channels ?? [0, 1, 2];
    if (!this.parameters.channels && meta.channelInfo) {
      const found = [-1, -1, -1];
      for (const { index, label } of meta.channelInfo) {
        const colour = LABELS[label.trim().toLowerCase()];
        if (colour !== undefined) found[colour] = index;
      }
      indices = indices.map((fallback, colour) =>
        found[colour] >= 0 ? found[colour] : fallback
      );
    }
    if (this.parameters.algorithm === "green") {
      // Only green is read, so a one-channel green stream is enough.
      if (indices[1] >= 0 && indices[1] < count) return indices;
      return count === 1 ? [0, 0, 0] : null;
    }
    return indices.every((i) => i >= 0 && i < count) ? indices : null;
  }

  analyze(packet: DataPacket): DataPacket | null {
    const rate = packet.metadata.samplingRate;
    if (!rate) return null;

    const channels = getChannelCount(packet);
    const indices = this.channelIndices(packet.metadata, channels);
    if (!indices) return null;
    const [ri, gi, bi] = indices;

    if (this.gaps.next(packet)) this.clear();

    const length = pulseWindowLength(this.parameters.windowSeconds, rate);
    if (length !== this.windowLength) {
      this.clear();
      this.windowLength = length;
    }

    const algorithm: PulseAlgorithm = this.parameters.algorithm;
    const data = packet.data;
    const samples = getSampleCount(packet);
    const out: number[] = [];

    for (let i = 0; i < samples; i++) {
      const base = i * channels;
      this.red.push(data[base + ri]);
      this.green.push(data[base + gi]);
      this.blue.push(data[base + bi]);
      this.pending.push(0);
      if (this.green.length > length) {
        this.red.shift();
        this.green.shift();
        this.blue.shift();
      }
      if (this.green.length < length) continue;

      // `pending` now lines up with the window: both end at this sample.
      const h = pulseWindow(this.red, this.green, this.blue, algorithm);
      for (let j = 0; j < length; j++) this.pending[j] += h[j];
      // No later window reaches the oldest sample, so it is final.
      out.push(-this.pending.shift()!);
    }

    if (out.length === 0) return null;

    const channelInfo: ChannelInfo[] = [{ index: 0, label: "pulse" }];
    return this.emit(packet, Float32Array.from(out), {
      modality: Modality.PPG,
      name: "pulse",
      channelInfo,
      timestamp: packet.timestamp - ((length - 1) * 1000) / rate,
    });
  }
}
