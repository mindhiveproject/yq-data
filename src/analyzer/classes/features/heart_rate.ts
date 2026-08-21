import {
  AnalysisMethod,
  ChannelInfo,
  DataPacket,
  ProcessingStage,
} from "../../../data_stream.interface";
import { Accepts, BaseAnalyzer } from "../../base_analyzer";
import { getChannelCount, deinterleave } from "../../../utility";
import { designFilter, filtfiltCascade } from "../../methods/filter";
import { detrend } from "../../methods/stats";
import { spectrum, dominantFrequency } from "../../methods/fft";
import {
  adaptiveThresholdPeaks,
  rateFromPeaks,
  intervalVariability,
  rmssd,
} from "../../methods/peaks";

export interface HeartRateParameters {
  /**
   * How the rate is derived.
   *
   * `peaks` locates individual beats, which is what makes variability
   * measures available; `spectral` takes the dominant frequency of the pulse
   * band, which is steadier on noisy signals such as camera-derived rPPG but
   * cannot report beat-to-beat timing.
   */
  strategy?: "peaks" | "spectral";
  /** Channel to analyze when the input has more than one. */
  channel?: number;
  minRate?: number;
  maxRate?: number;
  /** Degree of the polynomial detrend removing baseline wander. */
  detrendDegree?: number;
  /** Also emit SDNN and RMSSD channels. Only meaningful for `peaks`. */
  includeVariability?: boolean;
  /**
   * Exponential smoothing applied across successive estimates, 0–1.
   *
   * Rate estimates from a short window are inherently jumpy; without
   * smoothing a visual bound to heart rate flickers between plausible values
   * several times a second.
   */
  smoothing?: number;
}

/**
 * Heart rate from a pulse waveform — Muse PPG, or the rPPG signal derived
 * from a camera.
 *
 * Expects a windowed input long enough to contain several beats; ten seconds
 * is the reference configuration and anything under about four will report
 * unstable rates.
 *
 * The `peaks` strategy detects beats with the adaptive-threshold method of
 * Shin, H.S., Lee, C. & Lee, M. (2009), Adaptive threshold method for the peak
 * detection of photoplethysmographic waveform, Computers in Biology and
 * Medicine, 39(12), 1145–1152, https://doi.org/10.1016/j.compbiomed.2009.10.006
 */
export class HeartRate extends BaseAnalyzer {
  readonly name = "HeartRate";
  readonly method = AnalysisMethod.HEART_RATE;
  readonly stage = ProcessingStage.FEATURES;

  private smoothed: number | null = null;

  constructor(parameters: HeartRateParameters = {}) {
    super({
      strategy: "peaks",
      channel: 0,
      minRate: 40,
      maxRate: 200,
      detrendDegree: 6,
      includeVariability: false,
      smoothing: 0.6,
      ...parameters,
    });
  }

  readonly accepts: Accepts = { requiresSamplingRate: true };

  public reset(): void {
    this.smoothed = null;
  }

  analyze(packet: DataPacket): DataPacket | null {
    const rate = packet.metadata.samplingRate;
    if (!rate) return null;

    const channels = getChannelCount(packet);
    const index = Math.min(this.parameters.channel, channels - 1);
    const signal = deinterleave(packet.data, channels)[index];

    // Needs at least a couple of seconds to hold more than one beat.
    if (!signal || signal.length < rate * 2) return null;

    const { minRate, maxRate } = this.parameters;
    const lowHz = minRate / 60;
    const highHz = Math.min(maxRate / 60, rate / 2 - 0.01);

    const detrended = detrend(signal, this.parameters.detrendDegree, rate);
    const sections = designFilter({
      kind: "bandpass",
      cutoff: [lowHz, highHz],
      samplingRate: rate,
      order: 4,
    });
    // Zero phase matters here: a phase shift moves the detected peaks, which
    // is exactly the quantity being measured.
    const pulse = filtfiltCascade(sections, detrended);

    let estimate = 0;
    let sdnn = 0;
    let rmssdValue = 0;

    if (this.parameters.strategy === "spectral") {
      const spec = spectrum(pulse, {
        samplingRate: rate,
        window: "hann",
        scaling: "magnitude",
        detrend: true,
      });
      const { frequency } = dominantFrequency(spec, lowHz, highHz);
      estimate = frequency * 60;
    } else {
      const { peaks } = adaptiveThresholdPeaks(pulse, {
        samplingRate: rate,
        refractoryPeriod: 60 / maxRate,
      });
      estimate = rateFromPeaks(peaks, rate, { minRate, maxRate });
      if (this.parameters.includeVariability) {
        sdnn = intervalVariability(peaks, rate);
        rmssdValue = rmssd(peaks, rate);
      }
    }

    // A zero estimate means "no confident reading"; hold the previous value
    // rather than dropping a visual to zero.
    if (estimate <= 0) {
      if (this.smoothed === null) return null;
      estimate = this.smoothed;
    }

    const alpha = this.parameters.smoothing;
    this.smoothed =
      this.smoothed === null
        ? estimate
        : this.smoothed * alpha + estimate * (1 - alpha);

    const channelInfo: ChannelInfo[] = [
      { index: 0, label: "Heart Rate", unit: "bpm" },
    ];
    const values = [this.smoothed];

    if (this.parameters.includeVariability) {
      channelInfo.push({ index: 1, label: "SDNN", unit: "ms" });
      channelInfo.push({ index: 2, label: "RMSSD", unit: "ms" });
      values.push(sdnn, rmssdValue);
    }

    return this.emit(packet, Float32Array.from(values), {
      name: "heart_rate",
      channelInfo,
      samplingRate: packet.metadata.additionalMetadata?.packetRate,
    });
  }
}
