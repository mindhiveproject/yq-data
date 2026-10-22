/**
 * `resetOnDisconnect` in a graph with more than one source.
 *
 * A dropped receiver must reset what it feeds and nothing else — the point of
 * a two-headset patch is that one person's headset slipping off does not
 * restart the other's windows. These tests use two stub receivers and read the
 * effect through what the graph emits, which is the thing a bound visual sees.
 */
import {
  BaseReceiver,
  DataPacket,
  Modality,
  Pipeline,
  StreamIdentifierLiteral,
  Windowing,
} from "../../src";

class StubReceiver extends BaseReceiver {
  deviceName = "stub";
  modalities = [Modality.EEG];
  deviceID: string;

  private readonly streamID: StreamIdentifierLiteral;

  constructor(id: string) {
    super();
    this.deviceID = id;
    this.streamID = this.initializeStream({
      modality: Modality.EEG,
      additionalMetadata: {
        samplingRate: 10,
        channelCount: 1,
        channelInfo: [{ index: 0, label: "x" }],
      },
    });
    this.isConnected = true;
  }

  connect(): void {}
  disconnect(): void {}
  startStream(): void {}
  stopStream(): void {}

  /** Reports the device as gone or back, as the real receivers do. */
  setConnected(connected: boolean): void {
    this.isConnected = connected;
  }

  send(timestamp: number, ...values: number[]): void {
    const packet: DataPacket = {
      streamID: this.streamID,
      timestamp,
      data: Float32Array.from(values),
      metadata: this.streamMeta.get(this.streamID)!,
    };
    this.streamData$.get(this.streamID)!.next(packet);
  }
}

/** Three-sample windows, so two packets leave a window one sample short. */
const WINDOW = { size: 3, unit: "samples" };

describe("two headsets, independent branches", () => {
  function harness(options = {}) {
    const a = new StubReceiver("a");
    const b = new StubReceiver("b");
    const pipeline = new Pipeline(
      {
        nodes: [
          { id: "sa", receiver: "a" },
          { id: "sb", receiver: "b" },
          { id: "wa", method: "windowing", parameters: WINDOW },
          { id: "wb", method: "windowing", parameters: WINDOW },
        ],
        edges: [
          { from: ["sa"], to: ["wa"] },
          { from: ["sb"], to: ["wb"] },
        ],
      },
      options
    );

    const fromA: DataPacket[] = [];
    const fromB: DataPacket[] = [];
    pipeline.getOutput("wa").subscribe((p) => fromA.push(p));
    pipeline.getOutput("wb").subscribe((p) => fromB.push(p));
    pipeline.attachReceiver("a", a);
    pipeline.attachReceiver("b", b);
    pipeline.start();

    return { a, b, fromA, fromB };
  }

  it("clears the dropped branch and leaves the other one filling", () => {
    const { a, b, fromA, fromB } = harness();

    a.send(1000, 1, 2);
    b.send(1000, 1, 2);

    a.setConnected(false);
    a.setConnected(true);

    // One more sample each: B completes the window it was building, while A
    // starts from empty and is a long way from one.
    a.send(1200, 3);
    b.send(1200, 3);

    expect(fromB).toHaveLength(1);
    expect(Array.from(fromB[0].data)).toEqual([1, 2, 3]);
    expect(fromA).toHaveLength(0);
  });

  it("leaves every branch alone when the option is off", () => {
    const { a, fromA } = harness({ resetOnDisconnect: false });

    a.send(1000, 1, 2);
    a.setConnected(false);
    a.setConnected(true);
    a.send(1200, 3);

    expect(fromA).toHaveLength(1);
    expect(Array.from(fromA[0].data)).toEqual([1, 2, 3]);
  });

  it("resets each downstream node once however many source nodes name the receiver", () => {
    const a = new StubReceiver("a");
    const pipeline = new Pipeline({
      nodes: [
        { id: "s1", receiver: "a" },
        { id: "s2", receiver: "a" },
        { id: "w1", method: "windowing", parameters: WINDOW },
        { id: "w2", method: "windowing", parameters: WINDOW },
      ],
      edges: [
        { from: ["s1"], to: ["w1"] },
        { from: ["s2"], to: ["w2"] },
      ],
    });
    pipeline.attachReceiver("a", a);
    pipeline.start();

    const reset = jest.spyOn(Windowing.prototype, "reset");
    try {
      a.setConnected(false);
      expect(reset).toHaveBeenCalledTimes(2);
    } finally {
      reset.mockRestore();
    }
  });
});

describe("a node where the two headsets meet", () => {
  function harness() {
    const a = new StubReceiver("a");
    const b = new StubReceiver("b");
    const pipeline = new Pipeline({
      nodes: [
        { id: "sa", receiver: "a" },
        { id: "sb", receiver: "b" },
        { id: "diff", method: "difference", parameters: { mode: "signed" } },
      ],
      edges: [
        { from: ["sa"], to: ["diff", "a"] },
        { from: ["sb"], to: ["diff", "b"] },
      ],
    });

    const emitted: DataPacket[] = [];
    pipeline.getOutput("diff").subscribe((p) => emitted.push(p));
    pipeline.attachReceiver("a", a);
    pipeline.attachReceiver("b", b);
    pipeline.start();

    return { a, b, emitted };
  }

  it("keeps the survivor's last packet, so pairing resumes when the dropped side returns", () => {
    const { a, b, emitted } = harness();

    a.send(1000, 5);
    b.send(1000, 2);
    expect(emitted).toHaveLength(1);

    a.setConnected(false);
    a.setConnected(true);

    // A pairs at once with the packet B sent before the drop, rather than
    // waiting for B to send again — which for a windowing node is seconds.
    a.send(1200, 9);
    expect(emitted).toHaveLength(2);
    expect(Array.from(emitted[1].data)).toEqual([7]);
  });

  it("forgets the dropped side's last packet", () => {
    const { a, b, emitted } = harness();

    a.send(1000, 5);
    b.send(1000, 2);
    expect(emitted).toHaveLength(1);

    a.setConnected(false);

    // B alone no longer pairs against A's departed packet.
    b.send(1100, 2);
    expect(emitted).toHaveLength(1);
  });
});
