import {
  DataPacket,
  StreamMetadata,
  AnalysisMethod,
  ProcessingStage,
  Modality,
  StreamIdentifierLiteral,
  ChannelInfo,
  TypedArray,
  ValueType,
} from "../data_stream.interface";
import { stringToStreamID, streamIDToString } from "../utility";

/**
 * What a node will accept on one of its inputs.
 *
 * Declarative rather than a predicate, because the question a node editor asks
 * is "may I draw this edge?" — asked before any data exists, and needing an
 * answer it can render. Every field is checked against {@link StreamMetadata},
 * which a receiver publishes at `initializeStream()`, so the whole graph can
 * be validated the moment its sources are known.
 *
 * A node whose rules depend on its own configuration implements `accepts` as a
 * getter over `this.parameters`; the result is still a plain object, just one
 * computed per configured node.
 */
export interface Accepts {
  /**
   * Reject streams with no `samplingRate`.
   *
   * Set by everything that interprets samples as a time series — filters,
   * spectra, anything measuring rate — and it is what excludes irregular
   * sources such as event markers without naming them.
   */
  requiresSamplingRate?: boolean;

  /** Restrict to particular modalities. Unset accepts any. */
  modalities?: Modality[];

  /**
   * Which scales of measurement this input will take. Defaults to
   * `["numeric"]` — unlike {@link modalities}, leaving it unset restricts
   * rather than admits, because accepting a scale a node cannot interpret is
   * the failure worth defaulting against.
   *
   * Numeric nodes leave it alone: averaging marker codes or filtering them
   * produces a number, which is worse than an error because nothing
   * downstream can tell it is meaningless.
   */
  valueTypes?: ValueType[];
}

/** Overrides an analyzer may apply to the packet it emits. */
export interface EmitOptions {
  /** Modality of the output, when it differs from the input. */
  modality?: Modality;
  /** Name segment of the output stream ID. Defaults to the analysis method. */
  name?: string;
  /** Channel labels of the output, when the analyzer changes them. */
  channelInfo?: ChannelInfo[];
  /** Output rate in Hz, when the analyzer resamples. */
  samplingRate?: number;
  /** Explicit channel count, when there is no channel info to infer it from. */
  channelCount?: number;
  /** Metadata merged into `additionalMetadata` on the output. */
  additionalMetadata?: Record<string, any>;
  /** Overrides the packet timestamp. Defaults to the input's. */
  timestamp?: number;
  /** Categorical value per sample, for nodes that emit labels. */
  labels?: string[];
}

/**
 * Shared machinery for every node that transforms packets: identity, output
 * stream derivation, and processing-history bookkeeping.
 *
 * Concrete nodes extend either {@link BaseAnalyzer} (one input) or
 * {@link MultiInputAnalyzer} (several named inputs).
 */
export abstract class AbstractAnalyzer {
  abstract readonly name: string;
  abstract readonly method: AnalysisMethod;
  abstract readonly stage: ProcessingStage;

  /** Parameters for analysis, initialized via constructor */
  protected readonly parameters: Record<string, any>;

  constructor(parameters: Record<string, any> = {}) {
    this.parameters = parameters;
  }

  /**
   * Clears any internal state (buffers, running statistics).
   *
   * Called by the pipeline when a stream disconnects, so a reconnect does not
   * inherit samples from the previous session.
   */
  public reset(): void {}

  protected createMetadata(
    meta: StreamMetadata,
    additionalMetadata: Record<string, any> = {}
  ): StreamMetadata {
    return {
      ...meta,
      processingHistory: [
        ...(meta.processingHistory || []),
        {
          stage: this.stage,
          method: this.method,
          parameters: this.parameters, // Include analysis parameters
          moduleName: this.name,
          receivedTime: Date.now(),
        },
      ],
      additionalMetadata: {
        ...meta.additionalMetadata,
        ...additionalMetadata,
      },
    };
  }

  /** Helper method to build a StreamIdentifierLiteral */
  protected buildStreamID(
    deviceID: string | number,
    modality: Modality,
    processingStage: ProcessingStage,
    name?: string
  ): StreamIdentifierLiteral {
    return streamIDToString({ deviceID, modality, processingStage, name });
  }

  /**
   * Builds the output packet for a transformation.
   *
   * The output stream ID keeps the input's device but takes this analyzer's
   * processing stage and (by default) its method as the name — so a Muse EEG
   * stream through band power becomes `muse-1:eeg:features:band_power`, which
   * is exactly what a binding elsewhere can address.
   */
  protected emit<Out extends TypedArray>(
    input: DataPacket<any>,
    data: Out,
    options: EmitOptions = {}
  ): DataPacket<Out> {
    const source = stringToStreamID(input.streamID as StreamIdentifierLiteral);
    const modality = options.modality ?? source.modality;
    const name = options.name ?? this.method;

    const streamID = this.buildStreamID(
      source.deviceID,
      modality,
      this.stage,
      name
    );

    const channelInfo = options.channelInfo ?? input.metadata.channelInfo;
    const channelCount =
      options.channelCount ??
      options.channelInfo?.length ??
      input.metadata.channelCount ??
      channelInfo?.length ??
      1;

    const metadata: StreamMetadata = {
      ...this.createMetadata(input.metadata, options.additionalMetadata),
      streamID,
      modality,
      name,
      channelCount,
      // Declared from what this node actually emits rather than inherited, so
      // a node that turns labels into numbers — or numbers into labels — ends
      // up describing its own output instead of its input's.
      valueType: options.labels !== undefined ? "categorical" : "numeric",
      ...(channelInfo ? { channelInfo } : {}),
      ...(options.samplingRate !== undefined
        ? { samplingRate: options.samplingRate }
        : {}),
    };

    const packet: DataPacket<Out> = {
      streamID,
      timestamp: options.timestamp ?? input.timestamp,
      data,
      metadata,
    };

    if (options.labels !== undefined) packet.labels = options.labels;
    if (input.deviceTime !== undefined) packet.deviceTime = input.deviceTime;

    return packet;
  }
}

/**
 * A single-input, single-output processing node.
 *
 * `analyze` returns `null` when the node has consumed the packet but has
 * nothing to emit yet — the normal case for buffering nodes such as
 * windowing, which only produce output once a full window has accumulated.
 */
export abstract class BaseAnalyzer<
  In extends TypedArray = Float32Array,
  Out extends TypedArray = Float32Array
> extends AbstractAnalyzer {
  /** What this analyzer will accept on its single input. */
  abstract readonly accepts: Accepts;

  abstract analyze(packet: DataPacket<In>): DataPacket<Out> | null;
}

/** How a multi-input node pairs packets arriving on different ports. */
export type SyncPolicy =
  /**
   * Pair each arriving packet with the most recent packet held on every other
   * port, and emit on every arrival.
   *
   * The default, because the intended inputs are feature streams — band-power
   * envelopes, blendshape scores — carried in windows of a second or more,
   * where a few hundred milliseconds of skew moves the result far less than
   * dropping half the pairings would.
   */
  | "latest"
  /**
   * As `latest`, but emit only when the paired packets were stamped within
   * `tolerance` ms of each other.
   *
   * This gates on alignment; it does not create it. Two windows stamped 5 ms
   * apart still hold samples on different time grids if their streams run at
   * different rates, and the analyzer will still zip them index to index.
   */
  | "timestamp"
  /**
   * Keep a short history per port, pair against the packet *closest* in time
   * to the arriving one, then apply the `tolerance` gate.
   *
   * Differs from `timestamp` only where arrival order and timestamp order
   * disagree, which happens when two transports buffer by different amounts —
   * a BLE headset alongside a webcam is the usual pairing. It never waits for
   * a better match to show up, since that would add latency to a live signal.
   */
  | "nearest";

/**
 * Synchronisation settings every multi-input node accepts.
 *
 * Node parameters travel as JSON, so these are read from the same parameter
 * object as the analyzer's own settings rather than being set in code.
 */
export interface SyncParameters {
  /** How packets on different ports are paired. Defaults to `latest`. */
  syncPolicy?: SyncPolicy;
  /** Maximum timestamp spread, in ms, for `timestamp` and `nearest`. */
  tolerance?: number;
  /** How long a packet stays eligible for pairing. See {@link MultiInputAnalyzer.maxAge}. */
  maxAge?: number | "auto";
  /** Packets retained per port under `nearest`. */
  historyDepth?: number;
}

/**
 * A node that combines several named input streams — synchrony between two
 * headsets, connectivity across devices, or any comparison of two signals.
 *
 * The pipeline routes an edge's target port to one of {@link ports}.
 */
export abstract class MultiInputAnalyzer<
  In extends TypedArray = Float32Array,
  Out extends TypedArray = Float32Array
> extends AbstractAnalyzer {
  /** Named input ports, in declaration order. */
  abstract readonly ports: string[];

  /** How packets on different ports are paired. */
  public syncPolicy: SyncPolicy = "latest";

  /** Maximum timestamp spread, in ms, for the `timestamp` and `nearest` policies. */
  public tolerance: number = 100;

  /**
   * How long a packet stays eligible for pairing, in ms.
   *
   * Applies under every policy, because without it a departed stream is
   * invisible: the pipeline would go on pairing live packets with the last
   * window a disconnected device sent, and a bound visual would look alive
   * while one of its inputs was gone.
   *
   * `"auto"` derives the limit from each port's own observed cadence, which is
   * the only setting that suits both a 60 Hz face stream and a windowing node
   * emitting once every four seconds.
   */
  public maxAge: number | "auto" = "auto";

  /** Packets retained per port under the `nearest` policy. */
  public historyDepth: number = 8;

  /**
   * Subclasses merge their own defaults into `parameters` and pass the result
   * through, so a policy chosen in a stored JSON graph arrives here alongside
   * the analyzer's own settings.
   */
  constructor(parameters: Record<string, any> = {}) {
    super(parameters);

    const { syncPolicy, tolerance, maxAge, historyDepth } =
      parameters as SyncParameters;

    if (syncPolicy !== undefined) this.syncPolicy = syncPolicy;
    if (tolerance !== undefined) this.tolerance = tolerance;
    if (maxAge !== undefined) this.maxAge = maxAge;
    if (historyDepth !== undefined) this.historyDepth = historyDepth;
  }

  /** Port whose stream identity and metadata seed the output packet. */
  public get primaryPort(): string {
    return this.ports[0];
  }

  /**
   * What each named port will accept, keyed by port name.
   *
   * Per port rather than per node, so a future marker-driven node can require
   * a categorical stream on one input and a sampled signal on another. Whether
   * every port is actually connected is a property of the graph, checked by
   * the pipeline rather than restated here.
   */
  abstract readonly accepts: Record<string, Accepts>;

  abstract analyze(
    packets: Record<string, DataPacket<In>>
  ): DataPacket<Out> | null;
}

/** Any node the pipeline can evaluate. */
export type AnyAnalyzer = BaseAnalyzer<any, any> | MultiInputAnalyzer<any, any>;

/** Narrowing helper used by the pipeline evaluator. */
export function isMultiInput(
  analyzer: AnyAnalyzer
): analyzer is MultiInputAnalyzer<any, any> {
  return analyzer instanceof MultiInputAnalyzer;
}
