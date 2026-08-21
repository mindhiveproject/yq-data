import { Modality, ProcessingStage } from "../../../data_stream.interface";
import { BaseReceiver } from "../../base_receiver";
import { ML5Classifier } from "./ml5_model";

/**
 * Where the emotion classifier's weights are fetched from.
 *
 * The model is a 125 KB dense network trained on MSP-PODCAST, carried in this
 * repository rather than the npm tarball so that an application which never
 * touches voice does not pay for it on install.
 */
export const DEFAULT_VOICE_EMOTION_MODEL =
  "https://cdn.jsdelivr.net/gh/mindhiveproject/yq-data@main/models/voice-emotion";

/**
 * Feature extractor settings passed through to formantanalyzer.
 *
 * These are the values the original Speech Emotion Analyzer ran with. The
 * segmentation ones are the interesting knobs: `pauseLength` decides how long
 * a silence has to be before a phrase is considered finished, and therefore
 * how often this receiver emits at all.
 */
export interface VoiceAnalyzerOptions {
  /** Silence, in ms, that ends the current speech segment. */
  pauseLength?: number;
  /** Segments shorter than this, in ms, are discarded. */
  minSegmentLength?: number;
  /** Track the noise floor automatically instead of using fixed thresholds. */
  autoNoiseGate?: boolean;
  /** Amplitude in dB below which sound counts as silence. */
  voicedMinDb?: number;
  /** Amplitude in dB above which sound is clipped. */
  voicedMaxDb?: number;
  /** Lowest frequency of the mel filterbank, in Hz. */
  fMin?: number;
  /** Highest frequency of the mel filterbank, in Hz. */
  fMax?: number;
  /** Analysis window width, in ms. */
  windowWidth?: number;
  /** Hop between analysis windows, in ms. */
  windowStep?: number;
  /** FFT bins between 0 Hz and `fMax`. */
  fftBins?: number;
  /** Mel filters, at most `fftBins`. */
  melBins?: number;
}

export interface VoiceEmotionOptions extends VoiceAnalyzerOptions {
  /** Directory holding `model.json`, `model.weights.bin` and `model_meta.json`. */
  modelPath?: string;
  /**
   * Also emit the valence/arousal pair the old platform derived.
   *
   * See {@link VoiceEmotionReceiver} for what those numbers actually are.
   */
  emitAffect?: boolean;
  /**
   * Half-life, in seconds, of the smoothing behind the affect stream.
   *
   * Speech arrives in bursts separated by pauses, so an unsmoothed valence
   * jumps between phrases. Larger values are steadier and slower to turn.
   */
  affectHalfLife?: number;
}

const ANALYZER_DEFAULTS: Required<VoiceAnalyzerOptions> = {
  pauseLength: 200,
  minSegmentLength: 250,
  autoNoiseGate: true,
  voicedMinDb: 10,
  voicedMaxDb: 100,
  fMin: 50,
  fMax: 4000,
  windowWidth: 40,
  windowStep: 25,
  fftBins: 128,
  melBins: 64,
};

/** formantanalyzer's "Syllable Features 53x" output. */
const SYLLABLE_FEATURES_LEVEL = 13;
/** Stream from the microphone rather than a file or an audio element. */
const MIC_SOURCE = 3;

/**
 * Speech emotion recognition from the microphone.
 *
 * Speech is segmented into syllables, 53 formant-based statistical features
 * are extracted from each, and a small dense network scores them as one of
 * four emotions — `N` neutral, `A` angry, `S` sad, `H` happy. Scores for the
 * syllables of a phrase are pooled, weighted by the square root of each
 * syllable's duration, and emitted once per phrase.
 *
 * **This receiver is event-driven, not periodic.** Nothing is emitted while
 * nobody is speaking, and a packet arrives at the end of each phrase — so
 * `samplingRate` is left undefined and consumers should expect gaps.
 *
 * Two streams:
 * - `emotion` — four probabilities summing to 1, labelled `N`, `A`, `S`, `H`.
 * - `affect` — `valence` and `arousal`, off by default.
 *
 * The affect stream reproduces the formula the old platform's popup used:
 * `valence = 3 × H`, `arousal = 1 − N`, computed over a smoothed distribution.
 * It is a crude reading of a four-class classifier rather than a measurement
 * of the circumplex, and valence is **not bounded by 1** — the ×3 was chosen
 * to make the number move visibly. It exists for compatibility with visuals
 * built against the old device; new work should bind to `emotion` directly.
 *
 * Feature extraction comes from `formantanalyzer`, an *optional* peer
 * dependency imported on `connect()`. It opens its own microphone and its own
 * AudioContext, so this receiver runs independently of
 * {@link MicrophoneReceiver} — both can be connected at once.
 *
 * ```ts
 * const voice = new VoiceEmotionReceiver({ emitAffect: true });
 * await voice.connect();
 * await voice.startStream();
 *
 * voice.data.subscribe((packet) => console.log(packet.streamID, packet.data));
 * ```
 */
export class VoiceEmotionReceiver extends BaseReceiver {
  deviceName = "Voice Emotion";
  modalities: Modality[] = [Modality.AUDIO];
  deviceID: string | number = "voice-emotion";

  private analyzer: any;
  private classifier: ML5Classifier | undefined;
  private options: Required<Omit<VoiceEmotionOptions, keyof VoiceAnalyzerOptions>> &
    Required<VoiceAnalyzerOptions>;
  private streaming = false;

  /** Decayed sum of class scores, and the time it was last decayed. */
  private smoothed: Float32Array | undefined;
  private smoothedAt = 0;

  constructor(options: VoiceEmotionOptions = {}) {
    super();
    this.options = {
      ...ANALYZER_DEFAULTS,
      emitAffect: false,
      affectHalfLife: 4,
      ...options,
      modelPath: options.modelPath ?? DEFAULT_VOICE_EMOTION_MODEL,
    };
  }

  /** Loads formantanalyzer, with a helpful error when it is missing. */
  private async loadAnalyzer(): Promise<any> {
    try {
      // Imported by explicit path, not by bare specifier: the package's
      // `main` field names a file that does not exist in the tarball. Node
      // quietly falls back to `index.js`, but Vite, Rollup and webpack all
      // fail to resolve the package at all. Naming the bundle directly works
      // everywhere, and the package declares no `exports` map that would
      // forbid the deep path.
      const module: any = await import("formantanalyzer/index.js");
      return module.default ?? module;
    } catch (error) {
      throw new Error(
        "formantanalyzer is required for VoiceEmotionReceiver. " +
          "Install it alongside yq-data: npm install formantanalyzer"
      );
    }
  }

  async connect(): Promise<void> {
    if (this.isConnected) return;

    const [analyzer, classifier] = await Promise.all([
      this.loadAnalyzer(),
      ML5Classifier.load(this.options.modelPath),
    ]);

    this.analyzer = analyzer;
    this.classifier = classifier;

    this.analyzer.configure({
      output_level: SYLLABLE_FEATURES_LEVEL,
      spec_type: 1, // mel-bands, the input the 53 features are built from
      plot_enable: false,
      plot_canvas: null,
      f_min: this.options.fMin,
      f_max: this.options.fMax,
      N_fft_bins: this.options.fftBins,
      N_mel_bins: this.options.melBins,
      window_width: this.options.windowWidth,
      window_step: this.options.windowStep,
      pause_length: this.options.pauseLength,
      min_seg_length: this.options.minSegmentLength,
      auto_noise_gate: this.options.autoNoiseGate,
      voiced_min_dB: this.options.voicedMinDb,
      voiced_max_dB: this.options.voicedMaxDb,
      pre_norm_gain: 1000,
      high_f_emph: 0.0,
    });

    const classes = classifier.classes;

    this.initializeStream({
      modality: Modality.AUDIO,
      processingStage: ProcessingStage.INFERRED,
      name: "emotion",
      additionalMetadata: {
        channelInfo: classes.map((label, index) => ({ index, label })),
        additionalMetadata: {
          classes: { N: "neutral", A: "angry", S: "sad", H: "happy" },
          emissionPolicy: "one packet per detected phrase",
        },
      },
    });

    if (this.options.emitAffect) {
      this.initializeStream({
        modality: Modality.AUDIO,
        processingStage: ProcessingStage.INFERRED,
        name: "affect",
        additionalMetadata: {
          channelInfo: [
            { index: 0, label: "valence" },
            { index: 1, label: "arousal" },
          ],
          additionalMetadata: { halfLifeSeconds: this.options.affectHalfLife },
        },
      });
    }

    this.smoothed = new Float32Array(classes.length);
    this.smoothedAt = 0;
    this.isConnected = true;
  }

  async startStream(): Promise<void> {
    if (!this.isConnected || this.streaming) return;
    this.streaming = true;

    // Resolves only when the microphone stops, so it is deliberately not
    // awaited — a rejection here means the stream ended, not that starting
    // failed.
    this.analyzer
      .LaunchAudioNodes(
        MIC_SOURCE,
        null,
        (
          _segmentIndex: number,
          _labels: any[],
          segmentTimes: number[][],
          features: number[][]
        ) => this.onSegment(segmentTimes, features),
        [],
        false, // not offline: there is no file to play silently
        false // not a test run: we want the callback
      )
      .catch((error: unknown) => {
        console.error("Voice emotion capture stopped:", error);
        this.streaming = false;
      });
  }

  async stopStream(): Promise<void> {
    if (!this.streaming) return;
    this.streaming = false;
    this.analyzer?.StopAudioNodes?.("stopStream");
  }

  async disconnect(): Promise<void> {
    await this.stopStream();
    this.isConnected = false;
    this.analyzer = undefined;
    this.classifier = undefined;
    this.smoothed = undefined;
  }

  /**
   * Scores the syllables of one finished phrase.
   *
   * @param segmentTimes `[startTime, duration]` per syllable, in ms.
   * @param features 53 features per syllable.
   */
  private onSegment(segmentTimes: number[][], features: number[][]): void {
    if (!this.classifier || !this.streaming) return;
    if (!Array.isArray(features) || features.length === 0) return;

    const classes = this.classifier.classes.length;
    const pooled = new Float32Array(classes);
    let totalWeight = 0;

    for (let i = 0; i < features.length; i++) {
      const vector = features[i];
      if (!vector || vector.length !== this.classifier.inputSize) continue;

      // Longer syllables carry more evidence, but not proportionally more —
      // the square root is the weighting the original analyzer used, and it
      // keeps one drawn-out vowel from deciding the whole phrase.
      const duration = Number(segmentTimes?.[i]?.[1] ?? 0);
      const weight = duration > 0 ? Math.sqrt(duration) : 1;

      let scores: { label: string; confidence: number }[];
      try {
        scores = this.classifier.classify(vector);
      } catch (error) {
        console.warn("Voice emotion prediction failed for a syllable:", error);
        continue;
      }

      for (let c = 0; c < classes; c++) pooled[c] += scores[c].confidence * weight;
      totalWeight += weight;
    }

    if (totalWeight === 0) return;
    for (let c = 0; c < classes; c++) pooled[c] /= totalWeight;

    this.update(
      {
        modality: Modality.AUDIO,
        processingStage: ProcessingStage.INFERRED,
        name: "emotion",
      },
      pooled
    );

    if (this.options.emitAffect) this.emitAffect(pooled);
  }

  /**
   * Emits the compatibility valence/arousal pair.
   *
   * The distribution is smoothed with an exponential decay keyed to wall
   * clock rather than to packet count, so a long pause fades the previous
   * phrase out instead of leaving it to be averaged with whatever is said
   * next.
   */
  private emitAffect(distribution: Float32Array): void {
    if (!this.smoothed || !this.classifier) return;

    const now = Date.now();
    const elapsed = this.smoothedAt === 0 ? 0 : (now - this.smoothedAt) / 1000;
    const decay =
      this.smoothedAt === 0
        ? 0
        : Math.pow(0.5, elapsed / this.options.affectHalfLife);
    this.smoothedAt = now;

    let total = 0;
    for (let c = 0; c < this.smoothed.length; c++) {
      this.smoothed[c] = this.smoothed[c] * decay + distribution[c];
      total += this.smoothed[c];
    }
    if (total === 0) return;

    const classes = this.classifier.classes;
    const share = (label: string) => {
      const index = classes.indexOf(label);
      return index === -1 ? 0 : this.smoothed![index] / total;
    };

    // Preserved verbatim from the old platform, ×3 scaling and all, so that
    // visuals mapped against it keep the same feel.
    const valence = share("H") * 3;
    const arousal = 1 - share("N");

    this.update(
      {
        modality: Modality.AUDIO,
        processingStage: ProcessingStage.INFERRED,
        name: "affect",
      },
      [valence, arousal]
    );
  }
}
