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
  StreamIdentity,
  TransportDecoder,
  identityFromStreamID,
  wireDecoder,
} from "../../transport/wire";
import { Subscription } from "rxjs";

export interface RemoteStreamOptions {
  /**
   * Device ID for streams whose incoming ID is not a well-formed
   * `deviceID:modality:stage[:name]`. Defaults to `"remote"`.
   */
  deviceID?: string;
  /**
   * Turns a transport value into decoded stream updates. Defaults to the
   * `yq-data/1` decoder; pass another to bridge a different protocol.
   */
  decode?: TransportDecoder;
  /**
   * Treat an incoming packet's `timestamp` as this machine's clock.
   *
   * Defaults to the transport's `structuredClone` flag — `true` for
   * `postMessage` / `BroadcastChannel` / memory (same machine), `false` for
   * `websocket`, where the original `timestamp` is filed under `deviceTime`
   * and ingest time is stamped instead.
   */
  trustRemoteClock?: boolean;
  /**
   * Close the transport when {@link RemoteStreamReceiver.disconnect} is called.
   * Default `true`. Set `false` when the transport is shared with a
   * `StreamTransmitter` in the same context.
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
 * against a remote Muse looks exactly like one built against a local one. The
 * default decoder reads the `yq-data/1` wire format; `LSLReceiver` is what this
 * looks like with a relay-specific decoder wired in instead.
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
 */
export class RemoteStreamReceiver extends BaseReceiver {
  deviceName = "Remote";
  modalities: Modality[] = [Modality.UNKNOWN];
  deviceID: string | number;

  private readonly transport: Transport;
  private readonly decode: TransportDecoder;
  private readonly trustRemoteClock: boolean;
  private readonly closeTransportOnDisconnect: boolean;

  private readonly registered = new Map<string, RemoteStream>();
  private messageUnsub?: () => void;
  private openSub?: Subscription;
  private streaming = false;

  constructor(transport: Transport, options: RemoteStreamOptions = {}) {
    super();
    this.transport = transport;
    this.deviceID = options.deviceID ?? "remote";
    this.decode = options.decode ?? wireDecoder();
    this.trustRemoteClock =
      options.trustRemoteClock ?? transport.structuredClone;
    this.closeTransportOnDisconnect =
      options.closeTransportOnDisconnect ?? true;
  }

  /** Incoming stream IDs registered so far. */
  get discoveredStreams(): string[] {
    return Array.from(this.registered.keys());
  }

  public async connect(): Promise<void> {
    if (this.isConnected) return;

    await this.transport.ready();

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
    if (this.closeTransportOnDisconnect) this.transport.close();
    this.isConnected = false;
  }

  private ingest(value: unknown): void {
    let updates: Decoded[];
    try {
      updates = this.decode(value);
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
