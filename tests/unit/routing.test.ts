/**
 * Routing nodes — splitting a shared wire apart, and joining wires together.
 *
 * The motivating case runs through most of these: a source node that names no
 * stream forwards everything its receiver produces, and until `stream_selection`
 * there was no way to separate those streams downstream.
 */
import {
  AnalysisMethod,
  BaseReceiver,
  DataPacket,
  MarkerReceiver,
  Merge,
  Modality,
  Pipeline,
  ProcessingStage,
  StreamIdentifierLiteral,
  StreamSelection,
  canConnect,
} from "../../src";

/** A receiver publishing several streams, as a Muse or an LSL relay does. */
class MultiStreamReceiver extends BaseReceiver {
  deviceName = "multi";
  modalities = [Modality.EEG, Modality.PPG];
  deviceID = "dev-1";

  readonly eeg: StreamIdentifierLiteral;
  readonly ppg: StreamIdentifierLiteral;

  constructor() {
    super();
    this.eeg = this.initializeStream({
      modality: Modality.EEG,
      additionalMetadata: {
        samplingRate: 256,
        channelCount: 2,
        channelInfo: [
          { index: 0, label: "AF7" },
          { index: 1, label: "AF8" },
        ],
      },
    });
    this.ppg = this.initializeStream({
      modality: Modality.PPG,
      additionalMetadata: {
        samplingRate: 64,
        channelCount: 1,
        channelInfo: [{ index: 0, label: "IR" }],
      },
    });
    this.isConnected = true;
  }

  connect(): void {}
  disconnect(): void {}
  startStream(): void {}
  stopStream(): void {}

  send(stream: StreamIdentifierLiteral, ...values: number[]): void {
    this.streamData$.get(stream)!.next({
      streamID: stream,
      timestamp: 1000,
      data: Float32Array.from(values),
      metadata: this.streamMeta.get(stream)!,
    });
  }
}

/** One packet on a named feature stream, for merge tests. */
function featurePacket(
  device: string,
  labels: string[],
  values: number[],
  options: { rate?: number; modality?: Modality } = {}
): DataPacket {
  const modality = options.modality ?? Modality.EEG;
  const streamID = `${device}:${modality}:features:x`;
  return {
    streamID,
    timestamp: 1000,
    data: Float32Array.from(values),
    metadata: {
      streamID,
      modality,
      channelCount: labels.length,
      channelInfo: labels.map((label, index) => ({ index, label })),
      deviceInfo: { model: device, id: device },
      ...(options.rate !== undefined ? { samplingRate: options.rate } : {}),
    },
  };
}

describe("StreamSelection", () => {
  it("passes matching packets and drops the rest", () => {
    const node = new StreamSelection({ modalities: [Modality.EEG] });
    const eeg = featurePacket("d", ["a"], [1], { modality: Modality.EEG });
    const ppg = featurePacket("d", ["a"], [1], { modality: Modality.PPG });

    expect(node.analyze(eeg)).toBe(eeg);
    expect(node.analyze(ppg)).toBeNull();
  });

  it("forwards the packet untouched, keeping its stream identity", () => {
    const node = new StreamSelection({ modalities: [Modality.EEG] });
    const packet = featurePacket("muse-1", ["AF7"], [0.5]);

    const out = node.analyze(packet)!;
    // Identity, not a copy: nothing was computed, so nothing is restamped.
    expect(out).toBe(packet);
    expect(out.streamID).toBe("muse-1:eeg:features:x");
    expect(out.metadata.processingHistory).toBeUndefined();
  });

  it("matches a full stream ID exactly", () => {
    const node = new StreamSelection({ streams: ["muse-1:eeg:features:x"] });
    expect(node.analyze(featurePacket("muse-1", ["a"], [1]))).not.toBeNull();
    expect(node.analyze(featurePacket("muse-2", ["a"], [1]))).toBeNull();
  });

  it("treats anything that is not a stream ID as a fragment", () => {
    const byDevice = new StreamSelection({ streams: ["muse-1"] });
    expect(byDevice.analyze(featurePacket("muse-1", ["a"], [1]))).not.toBeNull();
    expect(byDevice.analyze(featurePacket("muse-2", ["a"], [1]))).toBeNull();

    const byModality = new StreamSelection({ streams: ["EEG"] });
    expect(
      byModality.analyze(
        featurePacket("d", ["a"], [1], { modality: Modality.EEG })
      )
    ).not.toBeNull();
    expect(
      byModality.analyze(
        featurePacket("d", ["a"], [1], { modality: Modality.PPG })
      )
    ).toBeNull();
  });

  it("inverts the match when asked", () => {
    const node = new StreamSelection({
      modalities: [Modality.PPG],
      invert: true,
    });
    expect(
      node.analyze(featurePacket("d", ["a"], [1], { modality: Modality.EEG }))
    ).not.toBeNull();
    expect(
      node.analyze(featurePacket("d", ["a"], [1], { modality: Modality.PPG }))
    ).toBeNull();
  });

  it("is the identity when nothing is configured", () => {
    const node = new StreamSelection();
    const packet = featurePacket("d", ["a"], [1]);
    expect(node.analyze(packet)).toBe(packet);
  });

  it("is the one node that accepts a marker stream", () => {
    const markers = new MarkerReceiver();
    markers.connect();
    const meta = markers.getStreamMeta(Modality.EVENT_MARKER)!;

    expect(canConnect(meta, AnalysisMethod.STREAM_SELECTION)).toBe(true);
    expect(canConnect(meta, AnalysisMethod.MERGE, {}, "a")).not.toBe(true);
  });
});

describe("StreamSelection in a pipeline", () => {
  it("splits a receiver's merged output into separate branches", () => {
    const device = new MultiStreamReceiver();
    const pipeline = new Pipeline({
      nodes: [
        { id: "device", receiver: "muse" },
        {
          id: "eeg",
          method: AnalysisMethod.STREAM_SELECTION,
          parameters: { modalities: [Modality.EEG] },
        },
        {
          id: "pulse",
          method: AnalysisMethod.STREAM_SELECTION,
          parameters: { modalities: [Modality.PPG] },
        },
      ],
      edges: [
        { from: ["device"], to: ["eeg"] },
        { from: ["device"], to: ["pulse"] },
      ],
    });

    pipeline.attachReceiver("muse", device);
    pipeline.start();

    const eeg: DataPacket[] = [];
    const pulse: DataPacket[] = [];
    pipeline.getOutput("eeg").subscribe((p) => eeg.push(p));
    pipeline.getOutput("pulse").subscribe((p) => pulse.push(p));

    device.send(device.eeg, 1, 2);
    device.send(device.ppg, 9);
    device.send(device.eeg, 3, 4);

    expect(eeg).toHaveLength(2);
    expect(pulse).toHaveLength(1);
    expect(eeg[0].metadata.modality).toBe(Modality.EEG);
    expect(pulse[0].metadata.modality).toBe(Modality.PPG);
  });

  it("judges each stream on a shared port on its own terms", () => {
    // A marker arriving first must not block the EEG behind it.
    const device = new MultiStreamReceiver();
    const markers = new MarkerReceiver();
    markers.connect();

    const errors: unknown[] = [];
    const pipeline = new Pipeline(
      {
        nodes: [
          { id: "device", receiver: "muse" },
          { id: "markers", receiver: "markers" },
          { id: "rms", method: AnalysisMethod.RMS },
        ],
        edges: [
          { from: ["markers"], to: ["rms"] },
          { from: ["device"], to: ["rms"] },
        ],
      },
      { onError: (error) => errors.push(error) }
    );

    pipeline.attachReceiver("muse", device);
    pipeline.attachReceiver("markers", markers);
    pipeline.start();

    const seen: DataPacket[] = [];
    pipeline.getOutput("rms").subscribe((p) => seen.push(p));

    markers.mark("trial");     // refused: categorical
    device.send(device.eeg, 1, 2, 3, 4);   // must still get through

    expect(errors).toHaveLength(1);
    expect(seen).toHaveLength(1);
    expect(seen[0].metadata.modality).toBe(Modality.EEG);
  });
});

describe("Merge", () => {
  it("concatenates channels in port order", () => {
    const node = new Merge();
    const out = node.analyze({
      a: featurePacket("d1", ["Alpha", "Beta"], [1, 2]),
      b: featurePacket("d2", ["BPM"], [60]),
    })!;

    expect(Array.from(out.data)).toEqual([1, 2, 60]);
    expect(out.metadata.channelCount).toBe(3);
    expect(out.metadata.channelInfo?.map((c) => c.label)).toEqual([
      "Alpha",
      "Beta",
      "BPM",
    ]);
  });

  it("prefixes only the labels that would collide", () => {
    const node = new Merge();
    const out = node.analyze({
      a: featurePacket("muse-a", ["Alpha", "BPM"], [1, 60]),
      b: featurePacket("muse-b", ["Alpha"], [2]),
    })!;

    expect(out.metadata.channelInfo?.map((c) => c.label)).toEqual([
      "muse-a Alpha",
      "BPM",
      "muse-b Alpha",
    ]);
  });

  it("exposes as many ports as asked for", () => {
    const node = new Merge({ inputs: 3 });
    expect(node.ports).toEqual(["a", "b", "c"]);

    const out = node.analyze({
      a: featurePacket("d1", ["x"], [1]),
      b: featurePacket("d2", ["y"], [2]),
      c: featurePacket("d3", ["z"], [3]),
    })!;
    expect(Array.from(out.data)).toEqual([1, 2, 3]);
  });

  it("keeps a sampling rate the inputs agree on, and drops one they do not", () => {
    const agreeing = new Merge().analyze({
      a: featurePacket("d1", ["x"], [1], { rate: 4 }),
      b: featurePacket("d2", ["y"], [2], { rate: 4 }),
    })!;
    expect(agreeing.metadata.samplingRate).toBe(4);

    const disagreeing = new Merge().analyze({
      a: featurePacket("d1", ["x"], [1], { rate: 4 }),
      b: featurePacket("d2", ["y"], [2], { rate: 10 }),
    })!;
    // Absent rather than wrong: rate-dependent nodes downstream now refuse it.
    expect(disagreeing.metadata.samplingRate).toBeUndefined();
    expect(canConnect(disagreeing.metadata, AnalysisMethod.FILTERING)).toMatch(
      /no sampling rate/
    );
  });

  it("reports a shared modality, and unknown when they differ", () => {
    const same = new Merge().analyze({
      a: featurePacket("d1", ["x"], [1], { modality: Modality.EEG }),
      b: featurePacket("d2", ["y"], [2], { modality: Modality.EEG }),
    })!;
    expect(same.metadata.modality).toBe(Modality.EEG);

    const mixed = new Merge().analyze({
      a: featurePacket("d1", ["x"], [1], { modality: Modality.EEG }),
      b: featurePacket("d2", ["y"], [2], { modality: Modality.PPG }),
    })!;
    expect(mixed.metadata.modality).toBe(Modality.UNKNOWN);
  });

  it("truncates to the shortest input", () => {
    const long = featurePacket("d1", ["x"], [1, 2, 3]);
    const short = featurePacket("d2", ["y"], [9]);
    const out = new Merge().analyze({ a: long, b: short })!;
    expect(Array.from(out.data)).toEqual([1, 9]);
  });

  it("records the streams it merged", () => {
    const out = new Merge().analyze({
      a: featurePacket("d1", ["x"], [1]),
      b: featurePacket("d2", ["y"], [2]),
    })!;
    expect(out.metadata.additionalMetadata?.sources).toEqual([
      "d1:eeg:features:x",
      "d2:eeg:features:x",
    ]);
  });
});

describe("Merge in a pipeline", () => {
  it("rejoins two branches split off one receiver", () => {
    const device = new MultiStreamReceiver();
    const pipeline = new Pipeline({
      nodes: [
        { id: "device", receiver: "muse" },
        {
          id: "eeg",
          method: AnalysisMethod.STREAM_SELECTION,
          parameters: { modalities: [Modality.EEG] },
        },
        {
          id: "pulse",
          method: AnalysisMethod.STREAM_SELECTION,
          parameters: { modalities: [Modality.PPG] },
        },
        { id: "rmsA", method: AnalysisMethod.RMS },
        { id: "rmsB", method: AnalysisMethod.RMS },
        { id: "bundle", method: AnalysisMethod.MERGE },
      ],
      edges: [
        { from: ["device"], to: ["eeg"] },
        { from: ["device"], to: ["pulse"] },
        { from: ["eeg"], to: ["rmsA"] },
        { from: ["pulse"], to: ["rmsB"] },
        { from: ["rmsA"], to: ["bundle", "a"] },
        { from: ["rmsB"], to: ["bundle", "b"] },
      ],
    });

    pipeline.attachReceiver("muse", device);
    pipeline.start();
    expect(pipeline.issues()).toEqual([]);

    const merged: DataPacket[] = [];
    pipeline.getOutput("bundle").subscribe((p) => merged.push(p));

    device.send(device.ppg, 4);
    device.send(device.eeg, 3, 4);

    expect(merged.length).toBeGreaterThan(0);
    const last = merged[merged.length - 1];
    expect(last.metadata.channelCount).toBe(3);
    expect(last.metadata.channelInfo?.map((c) => c.label)).toEqual([
      "AF7 volume",
      "AF8 volume",
      "IR volume",
    ]);
  });
});
