import { BaseTransport } from "./transport";

/** The slice of `BroadcastChannel` this transport uses. */
export interface BroadcastChannelLike {
  postMessage(value: unknown): void;
  close(): void;
  onmessage: ((event: { data: unknown }) => void) | null;
}

type BroadcastChannelCtor = new (name: string) => BroadcastChannelLike;

function resolveBroadcastChannel(): BroadcastChannelCtor {
  const ctor = (globalThis as { BroadcastChannel?: BroadcastChannelCtor })
    .BroadcastChannel;
  if (!ctor) {
    throw new Error(
      "BroadcastChannel is not available in this environment. Pass a channel " +
        "object to BroadcastChannelTransport instead of a name."
    );
  }
  return ctor;
}

/**
 * A transport over `BroadcastChannel`.
 *
 * Every context on the same origin that opens a channel of the same name
 * receives every message — one producer, many consumers, no server. Structured
 * clone carries a `DataPacket` unchanged.
 *
 * A `BroadcastChannel` does not echo a sender its own messages, so a
 * transmitter and a receiver in the *same* context need two separate
 * `BroadcastChannelTransport`s on the same name, not one shared instance.
 *
 * ```ts
 * const out = new StreamTransmitter(new BroadcastChannelTransport("yq"));
 * // in another tab
 * const back = new RemoteStreamReceiver(new BroadcastChannelTransport("yq"));
 * ```
 */
export class BroadcastChannelTransport extends BaseTransport {
  readonly kind = "broadcastChannel" as const;
  readonly structuredClone = true;

  private readonly channel: BroadcastChannelLike;

  constructor(channel: string | BroadcastChannelLike) {
    super();
    this.channel =
      typeof channel === "string"
        ? new (resolveBroadcastChannel())(channel)
        : channel;
    this.channel.onmessage = (event) => this.emit(event.data);
    this.setOpen(true);
  }

  send(value: unknown): void {
    if (this.isOpen) this.channel.postMessage(value);
  }

  close(): void {
    if (!this.isOpen) return;
    this.setOpen(false);
    this.channel.onmessage = null;
    this.channel.close();
  }
}
