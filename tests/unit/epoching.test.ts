/**
 * Epoching: cutting signal around event markers.
 *
 * The signal is driven with hand-stamped packets so that a window's *content*
 * can be asserted, not just its length — an off-by-one in the pre-window is
 * invisible if you only check that something came out.
 */
import {
  AnalysisMethod,
  BaseReceiver,
  DataPacket,
  EpochInfo,
  Epoching,
  MarkerReceiver,
  Modality,
  Pipeline,
  StreamIdentifierLiteral,
  canConnect,
} from "../../src";

const RATE = 10; // Hz — one sample every 100 ms, so windows are easy to read

/** A signal source whose packets the test stamps itself. */
class SignalStub extends BaseReceiver {
  deviceName = "stub";
  modalities = [Modality.EEG];
  deviceID = "stub";

  private readonly streamID: StreamIdentifierLiteral;

  constructor(channels = 1) {
    super();
    this.streamID = this.initializeStream({
      modality: Modality.EEG,
      additionalMetadata: {
        samplingRate: RATE,
        channelCount: channels,
        channelInfo: Array.from({ length: channels }, (_, index) => ({
          index,
          label: `ch${index}`,
        })),
      },
    });
    this.isConnected = true;
  }

  connect(): void {}
  disconnect(): void {}
  startStream(): void {}
  stopStream(): void {}

  send(timestamp: number, values: number[]): void {
    this.streamData$.get(this.streamID)!.next({
      streamID: this.streamID,
      timestamp,
      data: Float32Array.from(values),
      metadata: this.streamMeta.get(this.streamID)!,
    });
  }
}

interface Harness {
  signal: SignalStub;
  markers: MarkerReceiver;
  epochs: DataPacket[];
  pipeline: Pipeline;
  /** Sends `count` samples, one per tick, starting at `from` ms. */
  ramp(from: number, count: number, value?: (i: number) => number): void;
}

function harness(parameters: Record<string, any> = {}, channels = 1): Harness {
  const signal = new SignalStub(channels);
  const markers = new MarkerReceiver();
  markers.connect();

  const pipeline = new Pipeline({
    nodes: [
      { id: "sig", receiver: "signal" },
      { id: "mrk", receiver: "markers" },
      { id: "ep", method: AnalysisMethod.EPOCHING, parameters },
    ],
    edges: [
      { from: ["sig"], to: ["ep", "signal"] },
      { from: ["mrk"], to: ["ep", "marker"] },
    ],
  });

  pipeline.attachReceiver("signal", signal);
  pipeline.attachReceiver("markers", markers);
  pipeline.start();

  const epochs: DataPacket[] = [];
  pipeline.getOutput("ep").subscribe((p) => epochs.push(p));

  return {
    signal,
    markers,
    epochs,
    pipeline,
    ramp(from, count, value = (i) => i) {
      for (let i = 0; i < count; i++) {
        const at = from + i * (1000 / RATE);
        const sample = Array.from({ length: channels }, () => value(i));
        signal.send(at, sample);
      }
    },
  };
}

const infoOf = (packet: DataPacket): EpochInfo =>
  packet.metadata.additionalMetadata!.epoch;

describe("Epoching", () => {
  it("cuts a window of the requested length around the marker", () => {
    const h = harness({ pre: 0.2, post: 0.3, baseline: "none" });

    // Signal flows, the marker lands mid-stream, and the epoch closes once the
    // rest of its window has arrived — the order a live session produces.
    h.ramp(1000, 6);
    h.markers.mark("cue", { timestamp: 1500 });
    h.ramp(1600, 10, (i) => 6 + i);

    expect(h.epochs).toHaveLength(1);
    // 0.5 s at 10 Hz
    expect(h.epochs[0].data.length).toBe(5);
  });

  it("takes the window from before and after the marker", () => {
    const h = harness({ pre: 0.2, post: 0.3, baseline: "none" });

    // Sample i sits at 1000 + 100i ms and holds the value i.
    h.ramp(1000, 6);
    h.markers.mark("cue", { timestamp: 1500 });
    h.ramp(1600, 10, (i) => 6 + i);

    // Marker at 1500 ms is sample 5. pre=0.2 s reaches back to 1300 ms
    // (sample 3), post=0.3 s runs to 1800 ms — so samples 3,4,5,6,7.
    expect(Array.from(h.epochs[0].data)).toEqual([3, 4, 5, 6, 7]);
  });

  it("stamps the epoch at the marker, not at the moment it was cut", () => {
    const h = harness({ pre: 0.2, post: 0.3, baseline: "none" });

    h.ramp(1000, 30);
    h.markers.mark("cue", { timestamp: 1500 });

    expect(h.epochs[0].timestamp).toBe(1500);
    expect(infoOf(h.epochs[0]).markerTime).toBe(1500);
  });

  it("carries the marker label, which is what a classifier trains against", () => {
    const h = harness({ pre: 0.1, post: 0.2, baseline: "none" });

    h.ramp(1000, 30);
    h.markers.mark("left_hand", { timestamp: 1500 });
    h.markers.mark("right_hand", { timestamp: 2000 });

    expect(h.epochs.map((p) => infoOf(p).label)).toEqual([
      "left_hand",
      "right_hand",
    ]);
    expect(h.epochs.map((p) => infoOf(p).code)).toEqual([1, 2]);
    expect(h.epochs.map((p) => infoOf(p).index)).toEqual([1, 2]);
  });

  it("fires once per marker, because the trigger port is consumed", () => {
    const h = harness({ pre: 0.1, post: 0.1, baseline: "none" });

    h.ramp(1000, 10);
    h.markers.mark("once", { timestamp: 1300 });
    // Many more signal packets, but no further markers.
    h.ramp(2000, 20, (i) => 50 + i);

    expect(h.epochs).toHaveLength(1);
  });

  it("subtracts the pre-marker mean when baselining", () => {
    const h = harness({ pre: 0.2, post: 0.2, baseline: "mean" });

    h.ramp(1000, 30, () => 7); // a flat signal at 7
    h.markers.mark("cue", { timestamp: 1500 });

    // Baseline is the mean of the pre-window, which for a flat signal is the
    // signal, so every sample lands on zero.
    expect(Array.from(h.epochs[0].data)).toEqual([0, 0, 0, 0]);
  });

  it("baselines each channel independently", () => {
    const h = harness({ pre: 0.2, post: 0.2, baseline: "mean" }, 2);

    // Channel 0 flat at 5, channel 1 flat at 50 — send explicitly.
    for (let i = 0; i < 30; i++) h.signal.send(1000 + i * 100, [5, 50]);
    h.markers.mark("cue", { timestamp: 1500 });

    expect(Array.from(h.epochs[0].data)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it("ignores a marker arriving mid-epoch by default", () => {
    const h = harness({ pre: 0, post: 1.0, baseline: "none" });

    h.ramp(1000, 5);
    h.markers.mark("first", { timestamp: 1100 });
    h.markers.mark("swallowed", { timestamp: 1300 });
    h.ramp(1500, 30, (i) => 5 + i);

    expect(h.epochs.map((p) => infoOf(p).label)).toEqual(["first"]);
  });

  it("opens overlapping epochs when told to", () => {
    const h = harness({ pre: 0, post: 1.0, baseline: "none", overlap: "allow" });

    h.ramp(1000, 5);
    h.markers.mark("first", { timestamp: 1100 });
    h.markers.mark("second", { timestamp: 1300 });
    h.ramp(1500, 40, (i) => 5 + i);

    expect(h.epochs.map((p) => infoOf(p).label)).toEqual(["first", "second"]);
  });

  it("epochs only the requested labels", () => {
    const h = harness({
      pre: 0.1,
      post: 0.1,
      baseline: "none",
      labels: ["target"],
    });

    h.ramp(1000, 30);
    h.markers.mark("distractor", { timestamp: 1400 });
    h.markers.mark("target", { timestamp: 1800 });
    h.markers.mark("distractor", { timestamp: 2200 });

    expect(h.epochs.map((p) => infoOf(p).label)).toEqual(["target"]);
  });

  it("drops a marker whose pre-window predates the buffer", () => {
    const h = harness({ pre: 1.0, post: 0.2, baseline: "none" });

    // Only 300 ms of history exists when the marker lands.
    h.ramp(1000, 3);
    h.markers.mark("too_early", { timestamp: 1200 });
    h.ramp(1300, 30, (i) => 20 + i);

    expect(h.epochs).toHaveLength(0);
  });

  it("keeps producing full-length epochs once history exists", () => {
    const h = harness({ pre: 0.3, post: 0.3, baseline: "none" });

    h.ramp(1000, 60);
    for (const at of [2000, 3000, 4000]) {
      h.markers.mark("cue", { timestamp: at });
    }
    h.ramp(7000, 10, (i) => 200 + i);

    expect(h.epochs).toHaveLength(3);
    for (const epoch of h.epochs) expect(epoch.data.length).toBe(6);
  });

  it("emits a numeric stream, so downstream analysis is unblocked", () => {
    const h = harness({ pre: 0.2, post: 0.3, baseline: "none" });

    h.ramp(1000, 30);
    h.markers.mark("cue", { timestamp: 1500 });

    const meta = h.epochs[0].metadata;
    expect(meta.valueType).toBe("numeric");
    expect(meta.samplingRate).toBe(RATE);
    expect(h.epochs[0].labels).toBeUndefined();
    expect(canConnect(meta, AnalysisMethod.BAND_POWER)).toBe(true);
  });

  it("discards buffered signal on reset", () => {
    const h = harness({ pre: 0.2, post: 0.2, baseline: "none" });

    h.ramp(1000, 30);
    h.pipeline.reset();
    h.markers.mark("after_reset", { timestamp: 1500 });
    h.ramp(4000, 10, (i) => 99 + i);

    expect(h.epochs).toHaveLength(0);
  });
});

describe("Epoching compatibility", () => {
  const markerMeta = () => {
    const markers = new MarkerReceiver();
    markers.connect();
    return markers.getStreamMeta(Modality.EVENT_MARKER)!;
  };

  const eegMeta = {
    streamID: "muse-1:eeg:raw",
    modality: Modality.EEG,
    samplingRate: 256,
    channelCount: 4,
  };

  it("accepts a sampled signal on the signal port", () => {
    expect(canConnect(eegMeta, AnalysisMethod.EPOCHING, {}, "signal")).toBe(true);
  });

  it("accepts markers on the marker port", () => {
    expect(canConnect(markerMeta(), AnalysisMethod.EPOCHING, {}, "marker")).toBe(
      true
    );
  });

  it("refuses markers on the signal port", () => {
    expect(
      canConnect(markerMeta(), AnalysisMethod.EPOCHING, {}, "signal")
    ).toMatch(/labels rather than measurements/);
  });

  it("refuses a plain signal on the marker port", () => {
    expect(canConnect(eegMeta, AnalysisMethod.EPOCHING, {}, "marker")).toMatch(
      /accepts only categorical/
    );
  });

  it("is the one method markers can now reach", () => {
    const usable = ["band_power", "filtering", AnalysisMethod.EPOCHING].filter(
      (m) => canConnect(markerMeta(), m, {}, "marker") === true
    );
    expect(usable).toEqual([AnalysisMethod.EPOCHING]);
  });

  it("validates a correctly wired epoching graph", () => {
    const signal = new SignalStub();
    const markers = new MarkerReceiver();
    markers.connect();

    const pipeline = new Pipeline({
      nodes: [
        { id: "sig", receiver: "signal" },
        { id: "mrk", receiver: "markers" },
        { id: "ep", method: AnalysisMethod.EPOCHING },
      ],
      edges: [
        { from: ["sig"], to: ["ep", "signal"] },
        { from: ["mrk"], to: ["ep", "marker"] },
      ],
    });
    pipeline.attachReceiver("signal", signal);
    pipeline.attachReceiver("markers", markers);

    expect(pipeline.issues()).toEqual([]);
    expect(() => pipeline.validate()).not.toThrow();
  });

  it("reports the ports swapped", () => {
    const signal = new SignalStub();
    const markers = new MarkerReceiver();
    markers.connect();

    const pipeline = new Pipeline({
      nodes: [
        { id: "sig", receiver: "signal" },
        { id: "mrk", receiver: "markers" },
        { id: "ep", method: AnalysisMethod.EPOCHING },
      ],
      edges: [
        { from: ["sig"], to: ["ep", "marker"] },
        { from: ["mrk"], to: ["ep", "signal"] },
      ],
    });
    pipeline.attachReceiver("signal", signal);
    pipeline.attachReceiver("markers", markers);

    const issues = pipeline.issues();
    expect(issues).toHaveLength(2);
    expect(issues.map((i) => i.port).sort()).toEqual(["marker", "signal"]);
  });

  it("forces the event policy even if a stored graph asks otherwise", () => {
    const node = new Epoching({ syncPolicy: "latest" });
    expect(node.syncPolicy).toBe("event");
  });
});
