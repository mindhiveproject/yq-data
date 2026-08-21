/**
 * Synchronisation tests for multi-input nodes.
 *
 * These drive the pipeline with hand-stamped packets, because the properties
 * under test — how stale an input may be, how far apart two stamps may sit —
 * are invisible when the timestamps come from the wall clock.
 */
import {
  BaseReceiver,
  Correlation,
  DataPacket,
  Difference,
  Modality,
  Pipeline,
  ProcessingStage,
  StreamIdentifierLiteral,
} from "../../src";

/**
 * A receiver whose packets the test writes in full.
 *
 * `update()` on the real base class stamps with `Date.now()`, which is exactly
 * the freedom these tests need to take away.
 */
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

  /** Pushes one single-channel packet with an explicit timestamp. */
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

/**
 * Builds a two-source graph feeding one Difference node, and collects whatever
 * that node emits.
 */
function harness(parameters: Record<string, any> = {}) {
  const a = new StubReceiver("a");
  const b = new StubReceiver("b");

  const pipeline = new Pipeline({
    nodes: [
      { id: "sa", receiver: "a" },
      { id: "sb", receiver: "b" },
      { id: "diff", method: "difference", parameters },
    ],
    edges: [
      { from: ["sa"], to: ["diff", "a"] },
      { from: ["sb"], to: ["diff", "b"] },
    ],
  });

  const emitted: DataPacket[] = [];
  pipeline.getOutput("diff").subscribe((packet) => emitted.push(packet));
  pipeline.attachReceiver("a", a);
  pipeline.attachReceiver("b", b);
  pipeline.start();

  return { a, b, emitted };
}

describe("sync parameters", () => {
  it("reads the policy from constructor parameters", () => {
    const analyzer = new Correlation({
      syncPolicy: "timestamp",
      tolerance: 5,
      maxAge: 250,
    });

    expect(analyzer.syncPolicy).toBe("timestamp");
    expect(analyzer.tolerance).toBe(5);
    expect(analyzer.maxAge).toBe(250);
  });

  it("defaults to pairing on the latest packet", () => {
    const analyzer = new Difference();
    expect(analyzer.syncPolicy).toBe("latest");
    expect(analyzer.maxAge).toBe("auto");
  });
});

describe("staleness guard", () => {
  it("stops emitting once a port falls silent", () => {
    const { a, b, emitted } = harness({ mode: "signed", maxAge: 500 });

    a.send(1000, 1);
    b.send(1000, 0);
    expect(emitted).toHaveLength(1);

    // Still fresh: b is 400 ms behind, inside the limit.
    a.send(1400, 1);
    expect(emitted).toHaveLength(2);

    // b has now been gone longer than maxAge, so the pairing lapses rather
    // than correlating live packets against a departed device's last one.
    a.send(1600, 1);
    a.send(2000, 1);
    expect(emitted).toHaveLength(2);

    // b comes back and pairing resumes.
    b.send(2050, 0);
    expect(emitted).toHaveLength(3);
  });

  it("applies under the timestamp policy too", () => {
    const { a, b, emitted } = harness({
      mode: "signed",
      syncPolicy: "timestamp",
      tolerance: 1000,
      maxAge: 200,
    });

    a.send(1000, 1);
    b.send(1000, 0);
    expect(emitted).toHaveLength(1);

    // Inside `tolerance` but past `maxAge`: the two guards are independent.
    a.send(1500, 1);
    expect(emitted).toHaveLength(1);
  });

  it("derives a limit from the port's own cadence when set to auto", () => {
    const { a, b, emitted } = harness({ mode: "signed" });

    // Establish a 100 ms cadence on both ports.
    for (let t = 1000; t <= 1400; t += 100) {
      a.send(t, 1);
      b.send(t, 0);
    }
    const paired = emitted.length;
    expect(paired).toBeGreaterThan(0);

    // A gap far beyond the 1000 ms floor lapses even though neither port was
    // ever configured with a limit.
    a.send(4000, 1);
    expect(emitted).toHaveLength(paired);
  });
});

describe("timestamp policy", () => {
  it("drops pairings whose stamps sit further apart than the tolerance", () => {
    const { a, b, emitted } = harness({
      mode: "signed",
      syncPolicy: "timestamp",
      tolerance: 50,
    });

    a.send(1000, 1);
    b.send(1200, 0);
    expect(emitted).toHaveLength(0);

    b.send(1020, 0);
    expect(emitted).toHaveLength(1);
  });
});

describe("nearest policy", () => {
  it("pairs against the closest buffered packet, not merely the newest", () => {
    const { a, b, emitted } = harness({
      mode: "signed",
      syncPolicy: "nearest",
      tolerance: 50,
    });

    // b runs ahead of a in stamp order, which is what a faster transport looks
    // like. Its newest packet is 100 ms past the arriving one; its previous
    // packet lines up exactly.
    b.send(1000, 10);
    b.send(1100, 20);
    b.send(1200, 30);

    a.send(1100, 5);

    expect(emitted).toHaveLength(1);
    // Picked b@1100 (value 20), so the signed difference is 5 - 20.
    expect(emitted[0].data[0]).toBeCloseTo(-15, 5);
  });

  it("finds nothing to pair with when no buffered packet is close enough", () => {
    const { a, b, emitted } = harness({
      mode: "signed",
      syncPolicy: "nearest",
      tolerance: 20,
    });

    b.send(1000, 10);
    b.send(1200, 30);
    a.send(1100, 5);

    expect(emitted).toHaveLength(0);
  });
});

describe("pipeline plumbing", () => {
  it("keeps the multi-input port names addressable from a JSON graph", () => {
    const { emitted } = harness({ mode: "signed" });
    expect(emitted).toHaveLength(0);
    expect(ProcessingStage.FEATURES).toBe("features");
  });
});
