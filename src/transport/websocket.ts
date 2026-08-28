import { BaseTransport, WireCodec, jsonCodec } from "./transport";

/** The slice of `WebSocket` this transport drives. */
export interface WebSocketLike {
  send(data: string | ArrayBufferLike | ArrayBufferView): void;
  close(code?: number): void;
  readyState: number;
  onopen: ((event?: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event?: unknown) => void) | null;
  onerror: ((event?: unknown) => void) | null;
}

export interface WebSocketTransportOptions {
  /** Value <-> wire codec. Defaults to {@link jsonCodec}. */
  codec?: WireCodec;
  /** Subprotocols, when constructing from a URL. */
  protocols?: string | string[];
  /** Reconnect after an unexpected close. Default `true` (off if given a socket instance). */
  autoReconnect?: boolean;
  /** First reconnect delay in ms; doubles up to `maxReconnectDelay`. Default 1000. */
  reconnectDelay?: number;
  /** Ceiling for the reconnect backoff, in ms. Default 15000. */
  maxReconnectDelay?: number;
}

type Target = string | WebSocketLike | (() => WebSocketLike);

type WebSocketCtor = new (
  url: string,
  protocols?: string | string[]
) => WebSocketLike;

function resolveWebSocket(): WebSocketCtor {
  const ctor = (globalThis as { WebSocket?: WebSocketCtor }).WebSocket;
  if (!ctor) {
    throw new Error(
      "WebSocket is not available in this environment. Pass a socket instance " +
        "or a factory to WebSocketTransport instead of a URL."
    );
  }
  return ctor;
}

/**
 * A transport over a `WebSocket`.
 *
 * The only transport that encodes: every value goes through a {@link WireCodec}
 * (JSON by default), because the far end is a different process and often a
 * different language. It also owns reconnection — same backoff as
 * `LSLReceiver` — so a `StreamTransmitter` or `RemoteStreamReceiver` on top of
 * it does not have to.
 *
 * `structuredClone` is `false`: the two ends do not share a clock, which is
 * why `RemoteStreamReceiver` files an incoming `timestamp` under `deviceTime`
 * rather than trusting it as local time.
 *
 * ```ts
 * const out = new StreamTransmitter(new WebSocketTransport("ws://localhost:9000"));
 * ```
 *
 * Accepts a URL, a live socket, or a factory (called on every reconnect). A
 * bare socket instance cannot be reconnected, so `autoReconnect` defaults off
 * in that case.
 */
export class WebSocketTransport extends BaseTransport {
  readonly kind = "websocket" as const;
  readonly structuredClone = false;

  private readonly codec: WireCodec;
  private readonly factory: () => WebSocketLike;
  private readonly options: Required<
    Omit<WebSocketTransportOptions, "codec" | "protocols">
  >;

  private socket: WebSocketLike | undefined;
  private closedByUs = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private currentDelay: number;
  private readyResolvers: Array<{
    resolve: () => void;
    reject: (error: unknown) => void;
  }> = [];
  private everOpened = false;

  constructor(target: Target, options: WebSocketTransportOptions = {}) {
    super();
    this.codec = options.codec ?? jsonCodec;

    let canReconnect = true;
    if (typeof target === "string") {
      const url = target;
      const protocols = options.protocols;
      this.factory = () => new (resolveWebSocket())(url, protocols);
    } else if (typeof target === "function") {
      this.factory = target;
    } else {
      // A single socket instance: usable once, no way to make another.
      this.factory = () => target;
      canReconnect = false;
    }

    this.options = {
      autoReconnect: (options.autoReconnect ?? true) && canReconnect,
      reconnectDelay: options.reconnectDelay ?? 1000,
      maxReconnectDelay: options.maxReconnectDelay ?? 15000,
    };
    this.currentDelay = this.options.reconnectDelay;

    this.openSocket();
  }

  ready(): Promise<void> {
    if (this.isOpen) return Promise.resolve();
    if (this.closedByUs) {
      return Promise.reject(new Error("Transport has been closed."));
    }
    return new Promise((resolve, reject) => {
      this.readyResolvers.push({ resolve, reject });
    });
  }

  send(value: unknown): void {
    if (!this.isOpen || !this.socket) return;
    this.socket.send(this.codec.encode(value));
  }

  close(): void {
    this.closedByUs = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.teardownSocket(1000);
    this.setOpen(false);
    this.rejectReady(new Error("Transport closed before it opened."));
  }

  private openSocket(): void {
    if (this.closedByUs) return;

    let socket: WebSocketLike;
    try {
      socket = this.factory();
    } catch (error) {
      this.rejectReady(error);
      if (this.options.autoReconnect && !this.closedByUs) this.scheduleReconnect();
      return;
    }
    this.socket = socket;

    socket.onopen = () => {
      this.everOpened = true;
      this.currentDelay = this.options.reconnectDelay;
      this.setOpen(true);
      const waiting = this.readyResolvers;
      this.readyResolvers = [];
      waiting.forEach((r) => r.resolve());
    };

    socket.onmessage = (event) => {
      let decoded: unknown;
      try {
        decoded = this.codec.decode(event.data);
      } catch {
        console.warn("WebSocketTransport: dropping an undecodable message.");
        return;
      }
      this.emit(decoded);
    };

    socket.onerror = (event) => {
      if (!this.everOpened) {
        console.error("WebSocketTransport: connection error", event);
        this.rejectReady(new Error("WebSocket connection failed."));
      }
    };

    socket.onclose = () => {
      this.setOpen(false);
      this.socket = undefined;
      if (!this.closedByUs && this.options.autoReconnect) {
        this.scheduleReconnect();
      }
    };
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    const delay = this.currentDelay;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.currentDelay = Math.min(
        this.currentDelay * 2,
        this.options.maxReconnectDelay
      );
      this.openSocket();
    }, delay);
  }

  private teardownSocket(code?: number): void {
    const socket = this.socket;
    if (!socket) return;
    socket.onopen = null;
    socket.onmessage = null;
    socket.onerror = null;
    socket.onclose = null;
    try {
      socket.close(code);
    } catch {
      /* already closing */
    }
    this.socket = undefined;
  }

  private rejectReady(error: unknown): void {
    if (this.readyResolvers.length === 0) return;
    const waiting = this.readyResolvers;
    this.readyResolvers = [];
    waiting.forEach((r) => r.reject(error));
  }
}
