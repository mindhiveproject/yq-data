import {
  AnalysisMethod,
  DataPacket,
  ProcessingStage,
} from "../../../data_stream.interface";
import { Accepts, BaseAnalyzer } from "../../base_analyzer";
import { getChannelCount, deinterleave, interleave } from "../../../utility";
import { spectrum, SpectrumScaling } from "../../methods/fft";
import { WindowType } from "../../methods/window";

export interface SpectrumParameters {
  window?: WindowType;
  scaling?: SpectrumScaling;
  detrend?: boolean;
  /** Discard bins above this frequency, which is usually most of them. */
  maxFrequency?: number;
}

/**
 * Per-channel frequency spectrum of a windowed signal.
 *
 * Emits the spectrum as an ordinary interleaved packet whose "samples" are
 * frequency bins; `additionalMetadata.frequencies` carries the bin centres so
 * a consumer can label an axis without recomputing them.
 *
 * Feed this from a {@link Windowing} node — a raw device packet is far too
 * short for meaningful frequency resolution.
 */
export class SpectrumAnalyzer extends BaseAnalyzer {
  readonly name = "Spectrum";
  readonly method = AnalysisMethod.PSD;
  readonly stage = ProcessingStage.TRANSFORMED;

  constructor(parameters: SpectrumParameters = {}) {
    super({
      window: "hamming",
      scaling: "magnitude",
      detrend: true,
      maxFrequency: undefined,
      ...parameters,
    });
  }

  readonly accepts: Accepts = { requiresSamplingRate: true };

  analyze(packet: DataPacket): DataPacket | null {
    const rate = packet.metadata.samplingRate;
    if (!rate) return null;

    const channels = getChannelCount(packet);
    const perChannel = deinterleave(packet.data, channels);
    if (perChannel.length === 0 || perChannel[0].length === 0) return null;

    const spectra = perChannel.map((signal) =>
      spectrum(signal, {
        samplingRate: rate,
        window: this.parameters.window,
        scaling: this.parameters.scaling,
        detrend: this.parameters.detrend,
      })
    );

    const reference = spectra[0];
    const limit = this.parameters.maxFrequency;
    const bins =
      limit === undefined
        ? reference.values.length
        : Math.min(
            reference.values.length,
            Math.ceil(limit / reference.resolution)
          );

    const trimmed = spectra.map((s) => s.values.subarray(0, bins));

    return this.emit(packet, interleave(trimmed), {
      name: this.parameters.scaling === "psd" ? "psd" : "spectrum",
      // One packet in, one packet out: the output arrives at the same rate the
      // windows do, not at the original sample rate.
      samplingRate: packet.metadata.additionalMetadata?.packetRate,
      additionalMetadata: {
        frequencies: Array.from(reference.frequencies.subarray(0, bins)),
        frequencyResolution: reference.resolution,
        fftLength: reference.fftLength,
        bins,
      },
    });
  }
}
