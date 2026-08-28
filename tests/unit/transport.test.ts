/**
 * Transport plumbing: the in-process link, the JSON codec, and the WebSocket
 * transport's lifecycle. The structured-clone transports (postMessage,
 * BroadcastChannel) are exercised through small fakes, since jsdom is not in
 * play here.
 */
import {
  BroadcastChannelTransport,
  MemoryTransport,
  PostMessageTransport,
  WebSocketTransport,
  jsonCodec,
  type WebSocketLike,
} from "../../src";

describe("MemoryTransport", () => {
  it("delivers values in both directions", () => {
    const [a, b] = MemoryTransport.pair();
    const atB: unknown[] = [];
    const atA: unknown[] = [];
    b.onMessage((v) => atB.push(v));
    a.onMessage((v) => atA.push(v));

    a.send({ n: 1 });
    b.send({ n: 2 });

    expect(atB).toEqual([{ n: 1 }]);
    expect(atA).toEqual([{ n: 2 }]);
  });

  it("passes a Float32Array through untouched — no codec", () => {
    const [a, b] = MemoryTransport.pair();
    const seen: unknown[] = [];
    b.onMessage((v) => seen.push(v));

    const payload = new Float32Array([1.5, 2.5, 3.5]);
    a.send(payload);

    expect(seen[0]).toBe(payload);
  });

  it("stops delivering after unsubscribe", () => {
    const [a, b] = MemoryTransport.pair();
    const seen: unknown[] = [];
    const off = b.onMessage((v) => seen.push(v));

    a.send(1);
    off();
    a.send(2);

    expect(seen).toEqual([1]);
  });

  it("closes both halves together", () => {
    const [a, b] = MemoryTransport.pair();
    const openState: boolean[] = [];
    b.isOpen$.subscribe((o) => openState.push(o));

    expect(a.isOpen).toBe(true);
    a.close();

    expect(a.isOpen).toBe(false);
    expect(b.isOpen).toBe(false);
    expect(openState).toEqual([true, false]);
  });
});

describe("jsonCodec", () => {
  it("round-trips a wire message", () => {
    const message = { protocol: "yq-data/1", type: "packet", data: [1, 2, 3] };
    expect(jsonCodec.decode(jsonCodec.encode(message))).toEqual(message);
  });

  it("decodes a binary frame as UTF-8 JSON", () => {
    const bytes = new TextEncoder().encode('{"ok":true}');
    expect(jsonCodec.decode(bytes.buffer)).toEqual({ ok: true });
  });
});

/** A hand-driven WebSocket stand-in. */
class FakeSocket implements WebSocketLike {
  static instances: FakeSocket[] = [];
  readyState = 0;
  sent: Array<string | ArrayBufferLike | ArrayBufferView> = [];
  onopen: ((event?: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event?: unknown) => void) | null = null;
  onerror: ((event?: unknown) => void) | null = null;

  constructor() {
    FakeSocket.instances.push(this);
  }
  send(data: string | ArrayBufferLike | ArrayBufferView): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = 3;
    this.onclose?.();
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }
  receive(data: unknown): void {
    this.onmessage?.({ data });
  }
}

describe("WebSocketTransport", () => {
  beforeEach(() => {
    FakeSocket.instances = [];
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it("resolves ready() on open and encodes what it sends", async () => {
    const transport = new WebSocketTransport(() => new FakeSocket());
    const socket = FakeSocket.instances[0];

    let opened = false;
    transport.ready().then(() => {
      opened = true;
    });
    expect(opened).toBe(false);

    socket.open();
    await Promise.resolve();
    expect(opened).toBe(true);
    expect(transport.isOpen).toBe(true);

    transport.send({ hello: "world" });
    expect(socket.sent).toEqual([JSON.stringify({ hello: "world" })]);
  });

  it("decodes incoming frames through the codec", () => {
    const transport = new WebSocketTransport(() => new FakeSocket());
    FakeSocket.instances[0].open();

    const seen: unknown[] = [];
    transport.onMessage((v) => seen.push(v));
    FakeSocket.instances[0].receive('{"type":"packet","n":7}');

    expect(seen).toEqual([{ type: "packet", n: 7 }]);
  });

  it("drops before-open sends rather than throwing", () => {
    const transport = new WebSocketTransport(() => new FakeSocket());
    expect(() => transport.send({ n: 1 })).not.toThrow();
    expect(FakeSocket.instances[0].sent).toEqual([]);
  });

  it("reconnects with backoff after an unexpected close", () => {
    const transport = new WebSocketTransport(() => new FakeSocket(), {
      reconnectDelay: 1000,
    });
    FakeSocket.instances[0].open();
    expect(transport.isOpen).toBe(true);

    // Socket drops on its own.
    FakeSocket.instances[0].onclose?.();
    expect(transport.isOpen).toBe(false);

    jest.advanceTimersByTime(1000);
    expect(FakeSocket.instances).toHaveLength(2);

    FakeSocket.instances[1].open();
    expect(transport.isOpen).toBe(true);
  });

  it("does not reconnect after close()", () => {
    const transport = new WebSocketTransport(() => new FakeSocket());
    FakeSocket.instances[0].open();

    transport.close();
    jest.advanceTimersByTime(60000);

    expect(FakeSocket.instances).toHaveLength(1);
    expect(transport.isOpen).toBe(false);
  });
});

/** A pair of fake BroadcastChannels sharing a bus, not echoing the sender. */
function fakeBroadcastPair() {
  type Ch = {
    onmessage: ((e: { data: unknown }) => void) | null;
    postMessage(value: unknown): void;
    close(): void;
  };
  const bus: Ch[] = [];
  const make = (): Ch => {
    const ch: Ch = {
      onmessage: null,
      postMessage(value: unknown) {
        for (const other of bus) {
          if (other !== ch) other.onmessage?.({ data: value });
        }
      },
      close() {},
    };
    bus.push(ch);
    return ch;
  };
  return [make(), make()];
}

describe("BroadcastChannelTransport", () => {
  it("fans a message out to the other channel but not the sender", () => {
    const [chA, chB] = fakeBroadcastPair();
    const a = new BroadcastChannelTransport(chA);
    const b = new BroadcastChannelTransport(chB);

    const atA: unknown[] = [];
    const atB: unknown[] = [];
    a.onMessage((v) => atA.push(v));
    b.onMessage((v) => atB.push(v));

    a.send({ n: 1 });

    expect(atB).toEqual([{ n: 1 }]);
    expect(atA).toEqual([]);
  });
});

describe("PostMessageTransport", () => {
  it("sends to the target and receives from the source", () => {
    const target = { posted: [] as unknown[], postMessage(v: unknown) { this.posted.push(v); } };
    let handler: ((e: { data: unknown; origin?: string }) => void) | undefined;
    const source = {
      addEventListener: (_t: "message", h: (e: { data: unknown }) => void) => {
        handler = h;
      },
      removeEventListener: () => {
        handler = undefined;
      },
    };

    const transport = new PostMessageTransport({ target, source });
    const seen: unknown[] = [];
    transport.onMessage((v) => seen.push(v));

    transport.send({ out: 1 });
    expect(target.posted).toEqual([{ out: 1 }]);

    handler?.({ data: { in: 2 }, origin: "https://example.test" });
    expect(seen).toEqual([{ in: 2 }]);
  });

  it("rejects a message from an origin it was told not to accept", () => {
    let handler: ((e: { data: unknown; origin?: string }) => void) | undefined;
    const source = {
      addEventListener: (_t: "message", h: (e: { data: unknown }) => void) => {
        handler = h;
      },
      removeEventListener: () => {},
    };
    const transport = new PostMessageTransport({
      target: { postMessage() {} },
      source,
      acceptOrigin: "https://trusted.test",
    });

    const seen: unknown[] = [];
    transport.onMessage((v) => seen.push(v));

    handler?.({ data: "nope", origin: "https://evil.test" });
    handler?.({ data: "yes", origin: "https://trusted.test" });

    expect(seen).toEqual(["yes"]);
  });
});
