import { DataPacket, StreamMetadata } from "../data_stream.interface";
import { BaseReceiver } from "../receiver/base_receiver";
import { Transport } from "../transport/transport";
import { metaToWire, packetToWire } from "../transport/wire";
import { Observable, Subscription } from "rxjs";

export interface StreamTransmitterOptions {
  /** Turns a packet into a wire message. Defaults to {@link packetToWire}. */
  encodePacket?: (packet: DataPacket) => unknown;
  /** Turns stream metadata into a wire message. Defaults to {@link metaToWire}. */
  encodeMeta?: (metadata: StreamMetadata) => unknown;
  /**
   * Send a `meta` message before a stream's first packet and whenever its
   * metadata changes. Default `true`. Turn it off only if the consumer learns
   * the layout some other way.
   */
  announceMeta?: boolean;
  /**
   * Re-announce every active stream's metadata on this interval, in ms, so a
   * consumer that connected late to a fan-out transport can still catch up.
   * `0` disables it. Default 5000.
   */
  reannounceInterval?: number;
}

interface StreamState {
  /** The metadata object last announced, by reference — the cheap change check. */
  announcedRef?: StreamMetadata;
  /** Serialized form of the last announced metadata — the exact change check. */
  announcedJSON?: string;
  /** When it was last announced, for the re-announce timer. */
  announcedAt: number;
  packets: number;
  samples: number;
}

/**
 * Streams packets out over a {@link Transport}.
 *
 * The outbound counterpart to `Recorder`, and it takes the same input: any
 * `Observable<DataPacket>` — a receiver's merged output, one pipeline node's
 * output, several at once. Every packet becomes a `yq-data/1` wire message and
 * goes out the transport; a `meta` message precedes each stream and repeats on
 * change and on a timer so a late or reconnecting consumer stays in sync.
 *
 * ```ts
 * const out = new StreamTransmitter(new WebSocketTransport("ws://localhost:9000"));
 * out.addReceiver(muse);
 * out.addSource(pipeline.getOutput("bands"));
 * out.start();
 * // ...later
 * out.stop();
 * ```
 *
 * It does not own the transport: `stop()` detaches the sources but leaves the
 * transport open, matching `Recorder.stop()`. Close the transport yourself
 * when you are done with it.
 */
export class StreamTransmitter {
  private readonly transport: Transport;
  private readonly encodePacket: (packet: DataPacket) => unknown;
  private readonly encodeMeta: (metadata: StreamMetadata) => unknown;
  private readonly announceMeta: boolean;
  private readonly reannounceInterval: number;

  private readonly sources: Array<Observable<DataPacket>> = [];
  private readonly subscriptions: Subscription[] = [];
  private readonly streams = new Map<string, StreamState>();
  private openSub?: Subscription;
  private transmitting = false;

  constructor(transport: Transport, options: StreamTransmitterOptions = {}) {
    this.transport = transport;
    this.encodePacket = options.encodePacket ?? packetToWire;
    this.encodeMeta = options.encodeMeta ?? metaToWire;
    this.announceMeta = options.announceMeta ?? true;
    this.reannounceInterval = options.reannounceInterval ?? 5000;
  }

  /** Whether packets are currently being sent. */
  get isTransmitting(): boolean {
    return this.transmitting;
  }

  /** What has gone out so far, per stream. */
  get summary(): Array<{ streamID: string; packets: number; samples: number }> {
    return Array.from(this.streams.entries()).map(([streamID, state]) => ({
      streamID,
      packets: state.packets,
      samples: state.samples,
    }));
  }

  /** Transmits every stream a receiver produces, including ones added later. */
  addReceiver(receiver: BaseReceiver<any>): void {
    this.addSource(receiver.data as Observable<DataPacket>);
  }

  /** Transmits one observable of packets — a pipeline output, for instance. */
  addSource(source: Observable<DataPacket>): void {
    this.sources.push(source);
    if (this.transmitting) this.subscribe(source);
  }

  /** Begins sending. Safe to call before the transport has opened. */
  start(): void {
    if (this.transmitting) return;
    this.transmitting = true;

    // A consumer that connects after a reconnect has lost every announcement,
    // so a fresh open forces the next packet on each stream to re-announce.
    this.openSub = this.transport.isOpen$.subscribe((open) => {
      if (open) {
        for (const state of this.streams.values()) {
          state.announcedRef = undefined;
          state.announcedJSON = undefined;
        }
      }
    });

    this.sources.forEach((source) => this.subscribe(source));
  }

  /** Stops sending and detaches the sources. Leaves the transport open. */
  stop(): void {
    this.transmitting = false;
    this.subscriptions.forEach((s) => s.unsubscribe());
    this.subscriptions.length = 0;
    this.openSub?.unsubscribe();
    this.openSub = undefined;
  }

  /** Forgets the per-stream counters and announcement state. */
  clear(): void {
    this.streams.clear();
  }

  private subscribe(source: Observable<DataPacket>): void {
    this.subscriptions.push(source.subscribe((packet) => this.forward(packet)));
  }

  private forward(packet: DataPacket): void {
    if (!this.transport.isOpen) return;

    let state = this.streams.get(packet.streamID);
    if (!state) {
      state = { announcedAt: 0, packets: 0, samples: 0 };
      this.streams.set(packet.streamID, state);
    }

    if (this.announceMeta && this.shouldAnnounce(state, packet.metadata)) {
      this.transport.send(this.encodeMeta(packet.metadata));
      state.announcedRef = packet.metadata;
      state.announcedJSON = JSON.stringify(packet.metadata);
      state.announcedAt = Date.now();
    }

    this.transport.send(this.encodePacket(packet));

    state.packets += 1;
    const channels = packet.metadata.channelCount ?? 1;
    state.samples += Math.floor(packet.data.length / Math.max(1, channels));
  }

  private shouldAnnounce(state: StreamState, metadata: StreamMetadata): boolean {
    if (state.announcedRef === undefined) return true;
    if (state.announcedRef !== metadata) {
      // A different object — only actually re-announce if the content moved,
      // since some receivers rebuild metadata each packet.
      return JSON.stringify(metadata) !== state.announcedJSON;
    }
    if (this.reannounceInterval <= 0) return false;
    return Date.now() - state.announcedAt >= this.reannounceInterval;
  }
}
