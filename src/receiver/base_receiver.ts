import {
  DataPacket,
  StreamMetadata,
  ProcessingStage,
  Modality,
  ChannelInfo,
  TypedArray,
  StreamIdentifier,
  StreamIdentifierLiteral,
} from "../data_stream.interface";
import { BehaviorSubject, Subject, Observable } from "rxjs";
import { streamIDToString, isValidStreamID, toInterleaved } from "../utility";

/** Per-packet overrides a receiver may supply when publishing. */
export interface PacketOptions {
  /**
   * Wall-clock time (ms UTC) the sample was produced.
   *
   * Supply this only when the source's clock is the same one `Date.now()`
   * reads — another context on this machine, which covers a script sharing the
   * page and anything arriving over postMessage or a BroadcastChannel. A
   * remote or hardware clock belongs in `deviceTime`, which stays in its own
   * domain and makes no claim to be comparable.
   */
  timestamp?: number;
  /** Categorical value per sample. See {@link DataPacket.labels}. */
  labels?: string[];
}

interface StreamOptions {
  modality: Modality;
  processingStage?: ProcessingStage;
  name?: string;
  deviceID?: string | number;
  additionalMetadata?: Partial<StreamMetadata>;
}

/**
 * Base class for all data receivers.
 * This class provides a common interface and basic functionality for receiving data streams.
 * It should be extended by specific device receivers to implement connection, disconnection,
 * and streaming logic.
 */
export abstract class BaseReceiver<DataType extends TypedArray = Float32Array> {
  /** Map of stream identifiers to their corresponding data subjects */
  public readonly streamData$: Map<
    StreamIdentifierLiteral,
    Subject<DataPacket<DataType>>
  > = new Map();
  /** Subject to track connection status */
  public readonly isConnected$: BehaviorSubject<boolean> = new BehaviorSubject(
    false
  );
  /** Base metadata for all streams, including device and modality information */
  public readonly streamMeta: Map<StreamIdentifierLiteral, StreamMetadata> =
    new Map();

  /**
   * Fan-in of every packet this receiver produces.
   *
   * Kept as a single long-lived Subject rather than a `merge()` computed on
   * demand, so that streams registered *after* a consumer subscribed — which
   * is the normal case, since most devices only learn their streams during
   * `connect()` — still reach that consumer.
   */
  private readonly allData$ = new Subject<DataPacket<DataType>>();

  /** Emits whenever the set of available streams changes. */
  public readonly streams$ = new BehaviorSubject<StreamIdentifierLiteral[]>([]);

  /** Abstract properties that must be defined by subclasses */
  abstract deviceName: string;
  /** List of modalities supported by this receiver */
  abstract modalities: Modality[];
  /** Unique identifier for this device instance */
  abstract deviceID: string | number | undefined;
  /** Optional time units the device uses, in case it keeps its own clock */
  protected timeUnits?: "ms_since_boot" | "ticks" | "iso8601" | "utc";
  /** False for lifecycle-only handles that never publish, so a graph source bound to one stays silent. */
  public readonly emitsPackets: boolean = true;

  public abstract connect(...args: any[]): void | Promise<void>;
  public abstract disconnect(...args: any[]): void | Promise<void>;
  public abstract startStream(...args: any[]): void | Promise<void>;
  public abstract stopStream(...args: any[]): void | Promise<void>;

  protected onInit(): void {}

  /**
   * Tears the receiver down and completes every subject.
   *
   * A destroyed receiver cannot be reused — construct a new one to reconnect.
   */
  public destroy(...args: any[]): void {
    this.onDestroy(...args);
  }

  protected onDestroy(..._args: any[]): void {
    this.streamData$.forEach((subject) => subject.complete());
    this.streamData$.clear();
    this.streamMeta.clear();
    this.streams$.next([]);
    this.isConnected$.next(false);
    this.allData$.complete();
    this.streams$.complete();
    this.isConnected$.complete();
  }

  constructor() {}

  /**
   * Observable of packets from every stream on this receiver, including
   * streams that appear after subscription.
   */
  get data(): Observable<DataPacket<DataType>> {
    return this.allData$.asObservable();
  }

  /** Stream identifiers currently registered on this receiver. */
  get streams(): StreamIdentifierLiteral[] {
    return Array.from(this.streamData$.keys());
  }

  /**
   * Gets connection status as boolean
   */
  get isConnected(): boolean {
    return this.isConnected$.getValue();
  }

  /** Sets connection status
   * This will emit a new value to all subscribers of isConnected$.
   * @param newValue - The new connection status to set.
   */
  protected set isConnected(newValue: boolean) {
    this.isConnected$.next(newValue);
  }

  /**
   *
   * @param modality - The modality of the stream (e.g., EEG, PPG).
   * @param processingStage - The processing stage of the stream (e.g., RAW, PROCESSED).
   * @param name - Optional name for the stream.
   * @returns ID of the stream that was initialized
   */
  protected initializeStream(options: StreamOptions): StreamIdentifierLiteral {
    const streamID = this.streamIDFor(options);

    if (this.streamData$.has(streamID))
      throw new Error(
        `Stream with ID ${streamID} already exists. Use a different name or modality.`
      );

    return this.upsertStream(streamID, options);
  }

  /**
   * Registers a stream, or reuses the existing one when a reconnect registers
   * it again, refreshing its metadata in case the device reports differently.
   *
   * Reusing rather than re-creating the subject is what keeps anyone
   * subscribed before a disconnect receiving packets after the reconnect.
   */
  protected ensureStream(options: StreamOptions): StreamIdentifierLiteral {
    return this.upsertStream(this.streamIDFor(options), options);
  }

  private upsertStream(
    streamID: StreamIdentifierLiteral,
    options: StreamOptions
  ): StreamIdentifierLiteral {
    if (!this.streamData$.has(streamID)) {
      const subject = new Subject<DataPacket<DataType>>();
      this.streamData$.set(streamID, subject);
      subject.subscribe(this.allData$);
    }

    const additional = options.additionalMetadata ?? {};

    this.streamMeta.set(streamID, {
      streamID: streamID,
      modality: options.modality,
      deviceInfo: {
        model: this.deviceName,
        id: this.deviceID || this.deviceName,
        modalities: this.modalities,
      },
      ...(options.name !== undefined ? { name: options.name } : {}),
      ...additional,
      // Channel count defaults to the number of labelled channels, so devices
      // that describe their electrodes get the right layout for free.
      channelCount:
        additional.channelCount ?? additional.channelInfo?.length ?? 1,
    });

    this.streams$.next(this.streams);

    return streamID;
  }

  private streamIDFor(options: StreamOptions): StreamIdentifierLiteral {
    return streamIDToString({
      deviceID: options.deviceID || this.deviceID || this.deviceName,
      modality: options.modality,
      processingStage: options.processingStage || ProcessingStage.RAW,
      name: options.name,
    });
  }

  public getStreamID(
    identifier: StreamIdentifier | StreamIdentifierLiteral | Modality,
    processingStage: ProcessingStage = ProcessingStage.RAW,
    name?: string
  ): StreamIdentifierLiteral {
    if (typeof identifier === "object") {
      return streamIDToString({
        deviceID: this.deviceID || this.deviceName,
        modality: identifier.modality,
        processingStage: identifier.processingStage,
        name: identifier?.name,
      });
    } else if (isValidStreamID(identifier)) {
      return identifier as StreamIdentifierLiteral;
    } else if (Object.values(Modality).includes(identifier as Modality)) {
      return streamIDToString({
        deviceID: this.deviceID || this.deviceName,
        modality: identifier as Modality,
        processingStage: processingStage,
        name: name,
      });
    } else {
      throw new Error(
        `Invalid identifier: ${identifier}. Expected StreamIdentifier, StreamIdentifierLiteral, or Modality.`
      );
    }
  }

  /**
   * Publishes a packet onto one of this receiver's streams.
   *
   * `data` may be a scalar, a flat interleaved array, or a channel-major
   * array-of-arrays; all three are normalized to the interleaved layout
   * described on {@link DataPacket.data}.
   */
  protected update(
    identifier: {
      modality: Modality;
      processingStage?: ProcessingStage;
      name?: string;
      /**
       * Overrides the receiver's device ID for this packet.
       *
       * Needed by relays that carry several physical devices over one
       * connection — an LSL bridge, say — where each stream has its own
       * source identity.
       */
      deviceID?: string | number;
    },
    data: number | ArrayLike<number> | ArrayLike<number>[],
    deviceTime?: number,
    options: PacketOptions = {}
  ): void {
    if (!this.isConnected) return;

    const streamIDString = streamIDToString({
      deviceID: identifier.deviceID || this.deviceID || this.deviceName,
      modality: identifier.modality || Modality.UNKNOWN,
      processingStage: identifier?.processingStage || ProcessingStage.RAW,
      name: identifier?.name,
    });

    const subject = this.streamData$.get(streamIDString);

    if (!subject) {
      console.warn(
        `Data subject not initialized or properly set for ${streamIDString}`
      );
      return;
    }

    const meta = this.streamMeta.get(streamIDString);
    if (!meta) {
      console.warn(
        `Metadata not initialized or properly set for ${streamIDString}`
      );
      return;
    }

    const currentData: DataPacket<DataType> = {
      streamID: streamIDString,
      // Ingest time, unless the source knows better. A device streaming
      // continuously has no better answer than "now", but an event marker does
      // — its onset is the moment the experiment recorded it, not the moment
      // the packet reached us, and those differ by however long the source
      // took to hand it over.
      timestamp: options.timestamp ?? Date.now(),
      data: toInterleaved(data) as DataType,
      metadata: meta,
    };

    if (options.labels !== undefined) {
      currentData.labels = options.labels;
    }

    if (deviceTime !== undefined) {
      currentData.deviceTime = deviceTime;
    }

    subject.next(currentData);
  }

  /**
   * Get data for a specific stream using StreamIdentifier or components
   * @param identifier - The identifier for the stream, which can be a StreamIdentifier, Modality, or StreamIdentifierLiteral.
   * @returns An observable that emits DataPacket objects for the specified stream.
   * If the stream is not found, it returns an empty observable.
   * @throws Will log a warning if the stream subject is not found.
   * @example
   * receiver.getData("muse-1:eeg:raw").subscribe(data => {
   *   console.log(data);
   * })
   */
  public getData(
    identifier: StreamIdentifier | Modality | StreamIdentifierLiteral
  ): Observable<DataPacket<DataType>> {
    const streamIDString: StreamIdentifierLiteral =
      this.getStreamID(identifier);

    const subject = this.streamData$.get(streamIDString);
    if (!subject) {
      console.warn(`Data subject not found for stream ${streamIDString}`);
      return new Subject<DataPacket<DataType>>().asObservable();
    }
    return subject.asObservable();
  }

  /**
   * Get metadata for a specific stream
   */
  public getStreamMeta(
    identifier: StreamIdentifier | Modality | StreamIdentifierLiteral
  ): StreamMetadata | undefined {
    const streamIDString: StreamIdentifierLiteral =
      this.getStreamID(identifier);
    return this.streamMeta.get(streamIDString);
  }

  public getSamplingRate(
    identifier: StreamIdentifier | Modality | StreamIdentifierLiteral
  ): number | undefined {
    return this.getStreamMeta(identifier)?.samplingRate;
  }

  public getChannelInfo(
    identifier: StreamIdentifier | Modality | StreamIdentifierLiteral
  ): ChannelInfo[] | undefined {
    return this.getStreamMeta(identifier)?.channelInfo;
  }

  public getChannelCount(
    identifier: StreamIdentifier | Modality | StreamIdentifierLiteral
  ): number | undefined {
    return this.getStreamMeta(identifier)?.channelCount;
  }

  protected redefineMetadata(
    identifier: StreamIdentifier | Modality | StreamIdentifierLiteral,
    newMetadata: Partial<StreamMetadata>
  ): void {
    const streamIDString: StreamIdentifierLiteral =
      this.getStreamID(identifier);
    const currentMeta = this.streamMeta.get(streamIDString);

    if (!currentMeta) {
      console.warn(
        `Metadata not found for stream ${streamIDString}. Cannot redefine metadata.`
      );
      return;
    }

    this.streamMeta.set(streamIDString, {
      ...currentMeta,
      ...newMetadata,
    });
  }

  /**
   * Names the channels of a stream, and sets its channel count to match.
   *
   * Devices often only learn their channel layout at connection time — a
   * microphone's channel count, or an LSL stream's description — so this is
   * the normal way to complete metadata after `initializeStream`.
   */
  protected setChannelNames(
    identifier: StreamIdentifier | Modality | StreamIdentifierLiteral,
    names: string[],
    unit?: string
  ): void {
    const channelInfo: ChannelInfo[] = names.map((label, index) => ({
      index,
      label,
      ...(unit ? { unit } : {}),
    }));
    this.redefineMetadata(identifier, {
      channelInfo,
      channelCount: channelInfo.length,
    });
  }

  protected setChannelInfo(
    identifier: StreamIdentifier | Modality | StreamIdentifierLiteral,
    channelInfo: ChannelInfo[]
  ): void {
    this.redefineMetadata(identifier, {
      channelInfo,
      channelCount: channelInfo.length,
    });
  }

  protected setSamplingRate(
    identifier: StreamIdentifier | Modality | StreamIdentifierLiteral,
    samplingRate: number
  ): void {
    this.redefineMetadata(identifier, { samplingRate });
  }

  protected setBufferSize(
    identifier: StreamIdentifier | Modality | StreamIdentifierLiteral,
    bufferSize: number
  ): void {
    this.redefineMetadata(identifier, { bufferSize });
  }
}
