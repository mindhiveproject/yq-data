import { BaseTransport } from "./transport";

/** A target `postMessage` can be called on — a `Window`, a `Worker`, a `MessagePort`. */
export interface PostMessageTarget {
  postMessage(value: unknown, targetOrigin?: string): void;
}

/** A source `message` events arrive on. Defaults to `globalThis`. */
export interface PostMessageSource {
  addEventListener(
    type: "message",
    listener: (event: { data: unknown; origin?: string; source?: unknown }) => void
  ): void;
  removeEventListener(
    type: "message",
    listener: (event: { data: unknown; origin?: string; source?: unknown }) => void
  ): void;
}

export interface PostMessageOptions {
  /** Where messages are sent. An iframe's `contentWindow`, a `Worker`, a port. */
  target: PostMessageTarget;
  /** Where messages are received. Defaults to `globalThis` (the window/worker scope). */
  source?: PostMessageSource;
  /**
   * `targetOrigin` for cross-origin `Window.postMessage`.
   *
   * Left unset, `postMessage` is called with one argument — correct for a
   * `Worker` or `MessagePort` (where a second argument is a transfer list, not
   * an origin) and for a same-origin window. Set it to the exact origin string
   * when posting to a cross-origin frame.
   */
  targetOrigin?: string;
  /**
   * Which sender origins to accept. A string (exact match), a predicate, or
   * `"*"` for any. Defaults to `"*"`; set it when the source window is
   * cross-origin and untrusted.
   */
  acceptOrigin?: string | ((origin: string) => boolean);
}

/**
 * A transport over `postMessage`.
 *
 * Covers a page talking to an iframe, a `Worker`, or a `MessagePort`.
 * Structured clone carries a `DataPacket` unchanged.
 *
 * ```ts
 * // page -> worker
 * const worker = new Worker("processor.js");
 * const out = new StreamTransmitter(
 *   new PostMessageTransport({ target: worker, source: worker })
 * );
 * ```
 */
export class PostMessageTransport extends BaseTransport {
  readonly kind = "postMessage" as const;
  readonly structuredClone = true;

  private readonly target: PostMessageTarget;
  private readonly source: PostMessageSource;
  private readonly targetOrigin?: string;
  private readonly accepts: (origin: string) => boolean;
  private readonly listener: (event: {
    data: unknown;
    origin?: string;
  }) => void;

  constructor(options: PostMessageOptions) {
    super();
    this.target = options.target;
    this.source =
      options.source ?? (globalThis as unknown as PostMessageSource);
    this.targetOrigin = options.targetOrigin;

    const accept = options.acceptOrigin ?? "*";
    this.accepts =
      typeof accept === "function"
        ? accept
        : (origin: string) => accept === "*" || origin === accept;

    this.listener = (event) => {
      if (event.origin !== undefined && !this.accepts(event.origin)) return;
      this.emit(event.data);
    };
    this.source.addEventListener("message", this.listener);
    this.setOpen(true);
  }

  send(value: unknown): void {
    if (!this.isOpen) return;
    if (this.targetOrigin !== undefined) {
      this.target.postMessage(value, this.targetOrigin);
    } else {
      this.target.postMessage(value);
    }
  }

  close(): void {
    if (!this.isOpen) return;
    this.setOpen(false);
    this.source.removeEventListener("message", this.listener);
  }
}
