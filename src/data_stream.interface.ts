/**
 * Data Stream Interface Module
 *
 * Defines the core interfaces and types for biosignal and sensor data streams
 * used throughout the YQ platform. Includes data typing, metadata structures,
 * and processing information.
 */

/**
 * Supported typed arrays for holding sensor data
 */
export type TypedArray =
  | Float32Array
  | Int32Array
  | Uint8Array
  | Uint16Array
  | Uint32Array
  | Int16Array
  | Int8Array;

/**
 * Core interface that defines what data streams look like
 * @template DataType The array type for the data, defaults to Float32Array
 */
export interface DataPacket<DataType extends TypedArray = Float32Array> {
  /** Identifier for the data stream shown as:
   * deviceID:modality:processingStage[:name]
   */
  streamID: string;
  /** Latest timestamp in milliseconds (UTC)
   * This will be the time when the data was streamed from the host.
   */
  timestamp: number;

  /**
   * Raw or processed signal data, **sample-interleaved**.
   *
   * For a stream with `metadata.channelCount = C`, sample `i` of channel `c`
   * lives at `data[i * C + c]`, and the packet holds
   * `data.length / C` samples per channel. This is the same ordering used by
   * LSL, Web Audio and WAV, so most sources can be forwarded without a copy.
   *
   * Use {@link getChannel} / {@link deinterleave} from `utility` to pull a
   * single channel out for per-channel DSP.
   */
  data: DataType;

  /**
   * Categorical value of each sample, for streams that carry one.
   *
   * Parallel to {@link data}: entry `i` names sample `i`, so a packet with
   * `labels` holds one label per sample and `channelCount` is 1. Set only by
   * streams whose `metadata.valueType` is `"categorical"` — event markers, and
   * the argmax output of a classifier — and left undefined by every numeric
   * stream, which is nearly all of them.
   *
   * Numeric analyzers never read this field. A classifier that emits *scores*
   * does not need it either: score-per-class is an ordinary multi-channel
   * packet whose classes are named by `metadata.channelInfo`.
   */
  labels?: string[];

  /** Metadata about the data stream */
  metadata: StreamMetadata;

  /** Device time information */
  deviceTime?: number;
}

/**
 * Identifies a data stream by its modality and processing stage.
 */
export interface StreamIdentifier {
  /** Unique identifier for the device */
  deviceID: string | number;
  /** Modality of the data (e.g., EEG, PPG) */
  modality: Modality;
  /** Processing stage of the data (e.g., raw, preprocessed) */
  processingStage: ProcessingStage;
  /** Optional name for the stream */
  name?: string;
}

/**
 * A string literal representing a unique data stream.
 *
 * Format:
 * - Without name: `${deviceID}:${modality}:${processingStage}`
 * - With name:    `${deviceID}:${modality}:${processingStage}:${name}`
 *
 * Examples:
 * - "emotiv-123:EEG:raw"
 * - "muse-456:PPG:preprocessed:left-wrist"
 */
export type StreamIdentifierLiteral<
  M extends Modality = Modality,
  P extends ProcessingStage = ProcessingStage
> = `${string | number}:${M}:${P}:${string}` | `${string | number}:${M}:${P}`;

/**
 * Basic information about the device that produced the data.
 */
export interface DeviceMetadata {
  /** Device name or model */
  model: string;

  /** Unique identifier for the specific device */
  id: string | number;

  /** Possible modalities it can produce */
  modalities?: Modality[];

  /** This preserves the timing information exactly as reported by the hardware. */
  deviceTimeUnit?: "ms_since_boot" | "ticks" | "iso8601" | "utc";

  /** Optional additional properties for device metadata */
  [additionalProp: string]: any;
}

/**
 * The measurement scale of the values a stream carries.
 *
 * - `"numeric"` — values are measurements, and the arithmetic an analyzer
 *   performs on them means something. Nearly every stream.
 * - `"categorical"` — values name a category from a finite set. The string in
 *   {@link DataPacket.labels} is the value; the number beside it in
 *   {@link DataPacket.data} is an arbitrary code, so averaging or filtering it
 *   yields a number that means nothing.
 *
 * A union rather than a boolean because this is a scale of measurement, and
 * the scale that sits between these two — an ordinal rating, a sleep stage —
 * is neither free to average nor unordered.
 */
export type ValueType = "numeric" | "categorical";

/**
 * Metadata for data streams
 */
export interface StreamMetadata {
  /** Identifier for the data stream shown as:
   * deviceID:modality:processingStage[:name]
   */
  streamID: string;

  /** Original modality of the data */
  modality: Modality;

  /** Data sampling rate in Hz */
  samplingRate?: number;

  /**
   * Scale of measurement for the values on this stream. Defaults to
   * `"numeric"`; read it through {@link getValueType} rather than directly, so
   * a stream that predates the field still answers.
   *
   * Declared on the stream rather than inferred from a packet so that a graph
   * can be checked for compatibility before any data flows — which is what
   * lets a node editor refuse to draw an illegal edge instead of failing at
   * runtime.
   */
  valueType?: ValueType;

  /**
   * Number of interleaved channels in every packet on this stream.
   *
   * Defaults to `channelInfo.length` when channel info is supplied, and to 1
   * otherwise. Packets carry `data.length / channelCount` samples per channel.
   */
  channelCount?: number;

  /** Optional info for data channels */
  channelInfo?: ChannelInfo[];

  /** Size of the data buffer */
  bufferSize?: number;

  /** Optional processing information if data has been transformed */
  processingHistory?: ProcessingStep[];

  /** Original information of the data */
  deviceInfo?: DeviceMetadata;

  /** Additional metadata */
  additionalMetadata?: Record<string, any>;

  /** Optional name for the stream */
  name?: string;
}

/**
 * Describes a single step in the processing chain applied to the data.
 * A list of these can form the processing history.
 */
export interface ProcessingStep {
  /** Stage of processing */
  stage: ProcessingStage;

  /** Method or algorithm used. Can be from enum or a custom string */
  method?: AnalysisMethod | string;

  /** Parameters used for the method */
  parameters?: Record<string, any>;

  /** Name of the processing module, function, or software */
  moduleName?: string;

  /** Timestamp (milliseconds UTC) when data was received for processing. */
  receivedTime?: number;
}

export type ChannelInfo = {
  index: number; // 0-based
  label: string; // "AF7"
  unit?: string; // "µV"
};

/**
 * Available signal modalities supported by the platform
 */
export enum Modality {
  EEG = "eeg", // Electroencephalogram
  PPG = "ppg", // Photoplethysmogram
  ECG = "ecg", // Electrocardiogram
  EMG = "emg", // Electromyogram
  EDA = "eda", // Electrodermal Activity (also GSR)
  ACCELEROMETER = "accelerometer", // 3-axis acceleration
  GYROSCOPE = "gyroscope", // 3-axis angular velocity
  MAGNETOMETER = "magnetometer", // 3-axis magnetic field
  TEMPERATURE = "temperature", // Skin temp, ambient temp
  RESPIRATION = "respiration", // Breathing data
  VIDEO = "video", // Video stream data
  AUDIO = "audio", // Audio stream data
  GAZE = "gaze", // Eye-tracking data
  EVENT_MARKER = "event_marker", // Timed events, triggers
  UNKNOWN = "unknown", // For unclassified or custom data types
}

/**
 * Stages in the data processing pipeline
 */
export enum ProcessingStage {
  RAW = "raw", // Data directly from the sensor
  PREPROCESSED = "preprocessed", // Cleaned data (e.g., filtering, artifact removal)
  TRANSFORMED = "transformed", // Data transformed into another domain (e.g., FFT, spectrogram)
  FEATURES = "features", // Extracted features from the data
  INFERRED = "inferred", // Output of a model (e.g., classification, regression)
}

/**
 * Common analysis methods used in signal processing
 */
export enum AnalysisMethod {
  // Preprocessing & Cleaning
  FILTERING = "filtering",
  RESCALING = "rescaling",
  NORMALIZATION = "normalization",
  ARTIFACT_REJECTION = "artifact_rejection",
  ICA_CLEANING = "ica_cleaning",
  DETRENDING = "detrending",
  SMOOTHING = "smoothing",
  CHANNEL_SELECTION = "channel_selection",

  // Segmentation / Epoching
  EPOCHING = "epoching",
  WINDOWING = "windowing",

  // Transformation
  FFT = "fft",
  PSD = "psd",
  SPECTROGRAM = "spectrogram",
  WAVELET_TRANSFORM = "wavelet_transform",
  ICA_DECOMPOSITION = "ica_decomposition",

  // Feature Extraction
  BAND_POWER = "band_power",
  STATISTICAL_FEATURES = "statistical_features",
  PEAK_DETECTION = "peak_detection",
  CONNECTIVITY = "connectivity",
  RMS = "rms",
  HEART_RATE = "heart_rate",

  // Inference / Modeling
  CLASSIFICATION = "classification",
  REGRESSION = "regression",
  CLUSTERING = "clustering",
  EVENT_DETECTION = "event_detection",

  // Other
  CUSTOM = "custom",
}
