import {
  Modality,
  ProcessingStage,
  StreamIdentifierLiteral,
  StreamMetadata,
} from "../../data_stream.interface";
import { BaseReceiver } from "../base_receiver";
import { Transport } from "../../transport/transport";
import {
  Decoded,
  Protocol,
  StreamIdentity,
  identityFromStreamID,
} from "../../transport/protocol";
import { streamProtocol } from "../../transport/stream_protocol";
import { Subscription } from "rxjs";

export interface RemoteStreamOptions {
  /**
   * Device ID for streams whose incoming ID is not a well-formed
   * `deviceID:modality:stage[:name]`. Defaults to `"remote"`.
   */
  deviceID?: string;
  /**
   * The protocol to read. Defaults to the transport's own
   * (`transport.protocol`) and otherwise to yq-stream; pass another to bridge
   * a different one.
   */
  protocol?: Protocol;
  /**
   * Treat an incoming packet's `timestamp` as this machine's clock.
   *
   * Defaults to the transport's `structuredClone` flag — `true` for
   * `postMessage` / `BroadcastChannel` / memory (same machine), `false` for
   * `websocket`, where the original `timestamp` is filed under `deviceTime`
   * and ingest time is stamped instead. With a transport factory there is no
   * transport to ask yet, so it defaults to `false`.
   */
  trustRemoteClock?: boolean;
  /**
   * Close the transport when {@link RemoteStreamReceiver.disconnect} is called.
   * Default `true`. Set `false` when the transport is shared with a
   * `StreamTransmitter` in the same context. (A transport made by a factory is
   * the receiver's own and is always closed.)
   */
  closeTransportOnDisconnect?: boolean;
}

interface RemoteStream {
  streamID: StreamIdentifierLiteral;
  identity: StreamIdentity;
}

/**
 * Receives streams from another context over a {@link Transport}.
 *
 * The generic inbound counterpart to `StreamTransmitter`: give it a transport
 * and it registers and republishes whatever streams arrive, so a graph built
 * against a remote Muse looks exactly like one built against a local one. It
 * reads yq-stream by default; `ArduinoReceiver` is this with the yq-arduino
 * protocol and a handshake wired in.
 *
 * ```ts
 * const remote = new RemoteStreamReceiver(new WebSocketTransport("ws://host:9000"));
 * await remote.connect();
 * remote.startStream();
 * remote.data.subscribe((packet) => ...);
 * ```
 *
 * `connect()` opens the transport and begins registering streams;
 * `startStream()` / `stopStream()` gate the sample packets, so a graph can be
 * validated against the announced streams before any data is let through.
 *
 * Give it a **factory** instead of a transport when the address is not known
 * until `connect()`, or when the receiver should be able to connect again after
 * a `disconnect()`: each `connect()` calls the factory for a fresh transport,
 * and a failed connect closes it again. `LSLReceiver` is built this way.
 */
export class RemoteStreamReceiver extends BaseReceiver {
  deviceName = "Remote";
  modalities: Modality[] = [Modality.UNKNOWN];
  deviceID: string | number;

  private readonly makeTransport?: () => Transport;
  private current?: Transport;
  /** The protocol given at construction, if any. Unset means the transport's own. */
  readonly protocol?: Protocol;
  private readonly trustRemoteClock: boolean;
  private readonly closeTransportOnDisconnect: boolean;

  private readonly registered = new Map<string, RemoteStream>();
  private messageUnsub?: () => void;
  private openSub?: Subscription;
  private streaming = false;

  constructor(
    transport: Transport | (() => Transport),
    options: RemoteStreamOptions = {}
  ) {
    super();
    if (typeof transport === "function") {
      this.makeTransport = transport;
    } else {
      this.current = transport;
    }
    this.deviceID = options.deviceID ?? "remote";
    this.protocol = options.protocol;
    this.trustRemoteClock =
      options.trustRemoteClock ?? this.current?.structuredClone ?? false;
    this.closeTransportOnDisconnect =
      options.closeTransportOnDisconnect ?? true;
  }

  /**
   * The transport in use. With a factory it does not exist until `connect()`
   * has called it.
   */
  protected get transport(): Transport {
    if (!this.current) {
      throw new Error("This receiver has no transport until connect() creates one.");
    }
    return this.current;
  }

  /** Incoming stream IDs registered so far. */
  get discoveredStreams(): string[] {
    return Array.from(this.registered.keys());
  }

  public async connect(): Promise<void> {
    if (this.isConnected) return;

    if (this.makeTransport) this.current = this.makeTransport();
    try {
      await this.transport.ready();
    } catch (error) {
      // A transport the receiver made is the receiver's to clean up; one that
      // was handed in belongs to the caller.
      if (this.makeTransport) this.transport.close();
      throw error;
    }

    this.messageUnsub = this.transport.onMessage((value) => this.ingest(value));
    this.openSub = this.transport.isOpen$.subscribe((open) => {
      // Mirror the transport's liveness, but never flip back to connected on
      // our own after disconnect() has torn the listener down.
      if (this.messageUnsub) this.isConnected = open;
    });

    this.isConnected = true;
  }

  public startStream(): void {
    this.streaming = true;
  }

  public stopStream(): void {
    this.streaming = false;
  }

  public async disconnect(): Promise<void> {
    this.streaming = false;
    this.messageUnsub?.();
    this.messageUnsub = undefined;
    this.openSub?.unsubscribe();
    this.openSub = undefined;
    if (this.current && (this.closeTransportOnDisconnect || this.makeTransport)) {
      this.current.close();
    }
    this.isConnected = false;
  }

  private ingest(value: unknown): void {
    let updates: Decoded[];
    try {
      const protocol = this.protocol ?? this.transport.protocol ?? streamProtocol;
      updates = protocol.decode(value, { streaming: this.streaming });
    } catch {
      console.warn("RemoteStreamReceiver: dropping an undecodable message.");
      return;
    }

    for (const update of updates) {
      if (update.kind === "meta") {
        this.registerOrRefine(update.streamID, update.metadata);
        continue;
      }

      if (!this.streaming) continue;

      let stream = this.registered.get(update.streamID);
      if (!stream) {
        stream = this.registerOrRefine(update.streamID, update.metadata ?? {});
      }

      const remoteTime = update.timestamp;
      this.update(
        stream.identity,
        update.data,
        this.trustRemoteClock ? update.deviceTime : update.deviceTime ?? remoteTime,
        {
          timestamp: this.trustRemoteClock ? remoteTime : undefined,
          labels: update.labels,
        }
      );
    }
  }

  /**
   * Registers a stream from decoded metadata, or refines one already
   * registered when a later `meta` carries more than the first did.
   */
  private registerOrRefine(
    incomingID: string,
    metadata: Partial<StreamMetadata>
  ): RemoteStream {
    // `streamID` and `modality` are the stream's identity — derived here from
    // the incoming ID, not taken from the metadata body.
    const { streamID: _id, modality: _modality, ...extra } = metadata;

    const existing = this.registered.get(incomingID);
    if (existing) {
      if (Object.keys(extra).length > 0) {
        this.redefineMetadata(existing.streamID, extra);
      }
      return existing;
    }

    const identity = identityFromStreamID(incomingID, String(this.deviceID));
    if (metadata.modality && identity.modality === Modality.UNKNOWN) {
      identity.modality = metadata.modality;
    }

    const streamID = this.initializeStream({
      modality: identity.modality,
      processingStage: identity.processingStage ?? ProcessingStage.RAW,
      name: identity.name,
      deviceID: identity.deviceID,
      additionalMetadata: extra,
    });

    if (!this.modalities.includes(identity.modality)) {
      this.modalities.push(identity.modality);
    }

    const stream: RemoteStream = { streamID, identity };
    this.registered.set(incomingID, stream);
    return stream;
  }
}
