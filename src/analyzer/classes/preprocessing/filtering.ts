import {
  AnalysisMethod,
  DataPacket,
  ProcessingStage,
} from "../../../data_stream.interface";
import { Accepts, BaseAnalyzer } from "../../base_analyzer";
import { getChannelCount, interleave, deinterleave } from "../../../utility";
import {
  FilterCoefficients,
  FilterKind,
  designFilter,
  firwin,
} from "../../methods/filter_design";
import { filtfilt, sosfilt, sosfiltfilt } from "../../methods/filter";
import { WindowSpec } from "../../methods/window";

export interface FilteringParameters {
  /** `"butterworth"` (IIR, default) or `"fir"` (windowed-sinc, linear phase). */
  method?: "butterworth" | "fir";
  kind?: FilterKind;
  /** Cutoff in Hz; `[low, high]` for band filters. */
  cutoff?: number | [number, number];
  /**
   * Butterworth order, as the `N` of `scipy.signal.butter(N, ...)`: lowpass and
   * highpass filters have N poles, band filters 2N.
   */
  order?: number;
  /**
   * FIR length. Default: one second of samples, made odd (`2 * floor(fs / 2) + 1`),
   * which gives roughly a 3 Hz transition band with a Hamming window. Highpass
   * and bandstop filters need an odd length. The filter delays the signal by
   * `(numtaps - 1) / 2` samples unless `zeroPhase` is set.
   */
  numtaps?: number;
  /**
   * FIR window, as in `scipy.signal.get_window`: a name such as `"hamming"`
   * (default), `"hann"`, `"blackman"`, or `["kaiser", beta]`. See `WindowSpec`.
   */
  window?: WindowSpec;
  /**
   * Run the filter forwards and backwards for zero phase distortion.
   *
   * Only valid on windowed input — it needs the whole segment at once and
   * cannot carry state between packets. On a continuous stream leave this off,
   * which keeps per-section state across packets so there is no discontinuity
   * at packet boundaries.
   */
  zeroPhase?: boolean;
}

/**
 * Digital filtering, applied per channel.
 *
 * The default is a Butterworth filter designed exactly as `scipy.signal.butter`
 * would, so results can be compared with SciPy or MNE. `method: "fir"` designs
 * a windowed-sinc filter as `scipy.signal.firwin` does.
 *
 * On a continuous stream the filter keeps its delay-line state between
 * packets; a naive per-packet filter would re-run its transient on every chunk
 * and inject a click at each boundary, which at Muse's 12-sample chunks means
 * 21 clicks a second.
 */
export class Filtering extends BaseAnalyzer {
  readonly name = "Filtering";
  readonly method = AnalysisMethod.FILTERING;
  readonly stage = ProcessingStage.PREPROCESSED;

  /** The designed filter as a cascade: biquads for IIR, one stage for FIR. */
  private stages: FilterCoefficients[] | null = null;
  private designedFor: { rate: number; channels: number } | null = null;
  private states: number[][][] = [];

  constructor(parameters: FilteringParameters = {}) {
    super({
      method: "butterworth",
      kind: "bandpass",
      cutoff: [1, 40],
      order: 4,
      zeroPhase: false,
      ...parameters,
    });
  }

  readonly accepts: Accepts = { requiresSamplingRate: true };

  public reset(): void {
    this.stages = null;
    this.designedFor = null;
    this.states = [];
  }

  private design(rate: number): FilterCoefficients[] {
    const { method, kind, cutoff, order, numtaps, window } = this.parameters;
    if (method === "fir") {
      const taps = numtaps ?? 2 * Math.floor(rate / 2) + 1;
      return [
        {
          b: firwin(taps, cutoff, { fs: rate, window, passZero: kind }),
          a: [1],
        },
      ];
    }
    return designFilter({ kind, cutoff, samplingRate: rate, order });
  }

  private ensureDesign(rate: number, channels: number): FilterCoefficients[] {
    if (
      this.stages &&
      this.designedFor &&
      this.designedFor.rate === rate &&
      this.designedFor.channels === channels
    ) {
      return this.stages;
    }

    this.stages = this.design(rate);
    this.designedFor = { rate, channels };
    // Zero initial state: the stream starts "from silence", as lfilter does.
    this.states = Array.from({ length: channels }, () =>
      this.stages!.map(({ b, a }) => new Array(Math.max(b.length, a.length) - 1).fill(0))
    );

    return this.stages;
  }

  analyze(packet: DataPacket): DataPacket | null {
    const rate = packet.metadata.samplingRate;
    if (!rate) return null;

    const channels = getChannelCount(packet);
    const stages = this.ensureDesign(rate, channels);
    const perChannel = deinterleave(packet.data, channels);

    const zeroPhase = (signal: Float32Array) =>
      this.parameters.method === "fir"
        ? filtfilt(stages[0].b, stages[0].a, signal)
        : sosfiltfilt(stages, signal);

    const filtered = perChannel.map((signal, index) =>
      this.parameters.zeroPhase ? zeroPhase(signal) : sosfilt(stages, signal, this.states[index])
    );

    return this.emit(packet, interleave(filtered), {
      name: `${this.parameters.kind}`,
      samplingRate: rate,
    });
  }
}
