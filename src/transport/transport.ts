import { BehaviorSubject, Observable } from "rxjs";

/**
 * How a {@link Transport} moves values between two endpoints.
 *
 * - `"memory"` — an in-process link between two `MemoryTransport` halves. No
 *   serialization; used for tests and for wiring a pipeline output back to a
 *   source in the same page.
 * - `"postMessage"` — `window.postMessage` / `Worker.postMessage`. Structured
 *   clone, so a {@link import("../data_stream.interface").DataPacket} crosses
 *   with its `Float32Array` intact.
 * - `"broadcastChannel"` — `BroadcastChannel`. Structured clone, and fans out
 *   to every other context on the same origin listening on the channel name.
 * - `"websocket"` — a `WebSocket`. The one transport that must encode: values
 *   are put through a {@link WireCodec} (JSON by default) on the way out and
 *   back on the way in.
 */
export type TransportKind =
  | "memory"
  | "postMessage"
  | "broadcastChannel"
  | "websocket";

/**
 * A bidirectional channel for values, with no knowledge of what they mean.
 *
 * `send` / `onMessage` / `close` are the whole contract. Serialization lives
 * here rather than in the packet layer: structured-clone transports carry a
 * value unchanged, and only `WebSocketTransport` reduces it to text — so a
 * caller hands the same object to every transport and the transport decides
 * whether it needs a codec.
 */
export interface Transport {
  /** Which mechanism this transport is built on. */
  readonly kind: TransportKind;

  /**
   * Whether a value handed to {@link send} reaches the other side unchanged.
   *
   * `true` for structured-clone transports (`memory`, `postMessage`,
   * `broadcastChannel`): a typed array survives, and the two endpoints are on
   * the same machine so a timestamp read by `Date.now()` on one is comparable
   * on the other. `false` for `websocket`: values are encoded, and the far end
   * is a different clock domain.
   */
  readonly structuredClone: boolean;

  /**
   * Resolves once the transport can carry traffic.
   *
   * Immediate for every transport but `websocket`, which resolves on the
   * socket's first `open` and rejects if the first connection attempt fails.
   */
  ready(): Promise<void>;

  /** Sends one value. A no-op while the transport is not open. */
  send(value: unknown): void;

  /**
   * Registers a listener for incoming values. Returns a function that removes
   * it — several listeners may be attached at once.
   */
  onMessage(handler: (value: unknown) => void): () => void;

  /** Open state, as a stream. Flips to `false` on `close()` and on socket loss. */
  readonly isOpen$: Observable<boolean>;

  /** Current open state. */
  readonly isOpen: boolean;

  /** Closes the transport. Idempotent. */
  close(): void;
}

/**
 * Shared plumbing for the concrete transports: the listener set, the open-state
 * subject, and the two protected calls (`emit`, `setOpen`) a subclass drives.
 */
export abstract class BaseTransport implements Transport {
  abstract readonly kind: TransportKind;
  abstract readonly structuredClone: boolean;

  private readonly handlers = new Set<(value: unknown) => void>();
  protected readonly openSubject = new BehaviorSubject<boolean>(false);

  get isOpen$(): Observable<boolean> {
    return this.openSubject.asObservable();
  }

  get isOpen(): boolean {
    return this.openSubject.getValue();
  }

  ready(): Promise<void> {
    return Promise.resolve();
  }

  abstract send(value: unknown): void;

  onMessage(handler: (value: unknown) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  close(): void {
    this.setOpen(false);
  }

  /** Delivers one value to every registered listener. */
  protected emit(value: unknown): void {
    // Iterate a copy: a listener may unsubscribe itself on delivery.
    for (const handler of Array.from(this.handlers)) {
      handler(value);
    }
  }

  /** Sets open state, emitting only on an actual change. */
  protected setOpen(open: boolean): void {
    if (this.openSubject.getValue() !== open) this.openSubject.next(open);
  }
}

/**
 * Turns a value into something a `WebSocket` can send, and back.
 *
 * The default is JSON. A binary codec — MessagePack, or a compact framing of
 * the packet's `Float32Array` — is a drop-in replacement, and is the intended
 * path if the JSON array of numbers ever proves too heavy on the wire.
 */
export interface WireCodec {
  encode(value: unknown): string | ArrayBufferLike | ArrayBufferView;
  decode(data: unknown): unknown;
}

/** JSON codec: `JSON.stringify` out, `JSON.parse` in. */
export const jsonCodec: WireCodec = {
  encode(value: unknown): string {
    return JSON.stringify(value);
  },
  decode(data: unknown): unknown {
    if (typeof data === "string") return JSON.parse(data);
    // A binary frame arrived on a JSON socket — decode as UTF-8 text and retry.
    if (data instanceof ArrayBuffer) {
      return JSON.parse(new TextDecoder().decode(data));
    }
    if (ArrayBuffer.isView(data)) {
      return JSON.parse(new TextDecoder().decode(data as ArrayBufferView));
    }
    throw new Error("jsonCodec cannot decode a message of this type.");
  },
};
