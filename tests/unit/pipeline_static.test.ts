/**
 * What a graph can say about itself before any data flows.
 *
 * Each analyzer declares how it shapes its output (`describeOutput()`), so
 * `describe()` can name output channels and `issues()` can refuse a bad edge
 * with no headset on. Three things are held here: that the declaration is the
 * truth (conformance against live output), that the questions a node editor
 * asks are answered ahead of data, and that where something cannot be known
 * the answer is "not judged" rather than a false error.
 */
import {
  AnalysisMethod,
  BaseAnalyzer,
  BaseReceiver,
  DataPacket,
  Modality,
  Pipeline,
  PipelineGraph,
  ProcessingStage,
  StreamMetadata,
  UNRESOLVED,
  createAnalyzer,
  registerAnalyzer,
  streamIDToString,
  Accepts,
  AnyAnalyzer,
  isMultiInput,
  StreamIdentifierLiteral,
} from "../../src";

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

const MUSE = ["TP9", "AF7", "AF8", "TP10"];

interface StubOptions {
  labels?: string[];
  rate?: number;
  samplesPerChannel?: number;
  modality?: Modality;
}

/** A device that has announced one stream and sent nothing. */
class StubReceiver extends BaseReceiver {
  deviceName = "stub";
  modalities = [Modality.EEG];
  deviceID = "dev";

  private readonly streamID: StreamIdentifierLiteral;

  constructor({
    labels = MUSE,
    rate = 256,
    samplesPerChannel,
    modality = Modality.EEG,
  }: StubOptions = {}) {
    super();
    this.streamID = this.initializeStream({
      modality,
      additionalMetadata: {
        samplingRate: rate,
        channelCount: labels.length,
        channelInfo: labels.map((label, index) => ({ index, label })),
        ...(samplesPerChannel !== undefined ? { samplesPerChannel } : {}),
      },
    });
    this.isConnected = true;
  }

  connect(): void {}
  disconnect(): void {}
  startStream(): void {}
  stopStream(): void {}

  send(timestamp: number, ...values: number[]): void {
    this.streamData$.get(this.streamID)!.next({
      streamID: this.streamID,
      timestamp,
      data: Float32Array.from(values),
      metadata: this.streamMeta.get(this.streamID)!,
    });
  }
}

/** Metadata for a windowed EEG stream, as `windowing` would hand it on. */
function windowedMeta(over: Partial<StreamMetadata> = {}): StreamMetadata {
  const labels = over.channelInfo?.map((c) => c.label) ?? MUSE;
  return {
    streamID: streamIDToString({
      deviceID: "dev",
      modality: Modality.EEG,
      processingStage: ProcessingStage.PREPROCESSED,
      name: "windowed",
    }),
    modality: Modality.EEG,
    samplingRate: 256,
    channelCount: labels.length,
    channelInfo: labels.map((label, index) => ({ index, label })),
    samplesPerChannel: 512,
    deviceInfo: { model: "stub", id: "dev" },
    additionalMetadata: { packetRate: 20 },
    ...over,
  };
}

/** A packet of sines, one per channel, matching `meta`. */
function packetFor(meta: StreamMetadata, samples: number): DataPacket {
  const channels = meta.channelCount ?? 1;
  const rate = meta.samplingRate ?? 1;
  const data = new Float32Array(samples * channels);
  for (let i = 0; i < samples; i++) {
    for (let c = 0; c < channels; c++) {
      data[i * channels + c] = Math.sin((2 * Math.PI * (1.2 + c) * i) / rate) + 0.1 * c;
    }
  }
  return {
    streamID: meta.streamID as StreamIdentifierLiteral,
    timestamp: 1000,
    data,
    metadata: meta,
  };
}

/* -------------------------------------------------------------------------- */
/* Conformance: the declaration is the truth                                   */
/* -------------------------------------------------------------------------- */

/**
 * Holds a declared output to what the node really emits.
 *
 * Every field a consumer might act on is compared, and the declared packet
 * size is held against the packet in hand — the check that would catch a node
 * promising a waveform and sending a feature.
 */
function expectConforms(declared: StreamMetadata, live: DataPacket): void {
  const meta = live.metadata;

  expect(declared.streamID).toBe(meta.streamID);
  expect(declared.modality).toBe(meta.modality);
  expect(declared.name).toBe(meta.name);
  expect(declared.channelCount).toBe(meta.channelCount);
  expect(declared.channelInfo).toEqual(meta.channelInfo);
  expect(declared.valueType).toBe(meta.valueType);

  if (!declared.unresolved?.includes("samplingRate")) {
    expect(declared.samplingRate).toBe(meta.samplingRate);
  }

  if (declared.samplesPerChannel !== undefined) {
    expect(live.data.length / (meta.channelCount ?? 1)).toBe(declared.samplesPerChannel);
  }

  for (const [key, value] of Object.entries(declared.additionalMetadata ?? {})) {
    if (value === undefined) continue;
    if (key === "packetRate" && declared.unresolved?.includes("packetRate")) continue;
    expect(meta.additionalMetadata?.[key]).toEqual(value);
  }

  // Nothing is unresolved once a packet is in hand.
  expect(meta.unresolved).toBeUndefined();
}

/** Declares, runs, compares. */
function conforms(
  method: string,
  parameters: Record<string, any>,
  input: StreamMetadata,
  samples: number,
  packets = 1
): StreamMetadata {
  const analyzer = createAnalyzer(method, parameters) as AnyAnalyzer & {
    describeOutput(meta: StreamMetadata): StreamMetadata | null | undefined;
  };

  const declared = analyzer.describeOutput(input);
  expect(declared).toBeTruthy();

  let live: DataPacket | DataPacket[] | null = null;
  for (let i = 0; i < packets; i++) {
    live = (analyzer as any).analyze(packetFor(input, samples));
  }
  const last = Array.isArray(live) ? live[live.length - 1] : live;
  expect(last).toBeTruthy();

  expectConforms(declared!, last!);
  return declared!;
}

describe("a declared output is the output", () => {
  const windowed = windowedMeta();

  it.each([
    ["band_power", {}],
    ["band_power", { perChannel: true, relative: true }],
    ["statistical_features", {}],
    ["statistical_features", { features: ["rms", "max"] }],
    ["channel_selection", { indices: [1, 2] }],
    ["channel_selection", { labels: ["AF8", "AF7"] }],
    ["channel_selection", { indices: [0, 1, 2], average: true }],
    ["normalization", {}],
    ["filtering", {}],
    ["psd", {}],
    ["psd", { scaling: "psd", maxFrequency: 40 }],
  ])("%s %j", (method, parameters) => {
    conforms(method, parameters, windowed, 512);
  });

  it("rms", () => {
    conforms(AnalysisMethod.RMS, { decibels: true }, windowed, 512);
  });

  it("heart_rate, with and without variability", () => {
    const ppg = windowedMeta({
      modality: Modality.PPG,
      samplingRate: 64,
      channelCount: 1,
      channelInfo: [{ index: 0, label: "PPG" }],
      samplesPerChannel: 640,
    });
    conforms("heart_rate", {}, ppg, 640);
    conforms("heart_rate", { includeVariability: true }, ppg, 640);
  });

  it("pulse_extraction", () => {
    const rgb = windowedMeta({
      modality: Modality.PPG,
      samplingRate: 30,
      channelCount: 3,
      channelInfo: ["red", "green", "blue"].map((label, index) => ({ index, label })),
      samplesPerChannel: undefined,
    });
    conforms("pulse_extraction", {}, rgb, 200);
  });

  it("windowing, whether or not the packet size is declared", () => {
    const raw = windowedMeta({
      streamID: "dev:eeg:raw",
      samplesPerChannel: undefined,
      additionalMetadata: {},
    });
    const params = { size: 24, hop: 12, unit: "samples" };

    // The device does not say how big its packets are, so the cadence is not
    // known ahead of data — and the declaration says so rather than guessing.
    const open = conforms("windowing", params, raw, 12, 2);
    expect(open.unresolved).toEqual(["packetRate"]);
    expect(open.samplesPerChannel).toBe(24);

    // Declared, it is worked out exactly, and matches what the node then does.
    const sized = windowedMeta({
      streamID: "dev:eeg:raw",
      samplesPerChannel: 12,
      additionalMetadata: {},
    });
    const known = conforms("windowing", params, sized, 12, 2);
    expect(known.unresolved).toBeUndefined();
    expect(known.additionalMetadata?.packetRate).toBeCloseTo(256 / 12);

    // Emitting every window, the hop alone sets the cadence.
    const all = conforms("windowing", { ...params, frames: "all" }, raw, 12, 2);
    expect(all.unresolved).toBeUndefined();
  });

  describe("nodes with two inputs", () => {
    function two(method: string, parameters: Record<string, any>, over: Partial<StreamMetadata> = {}) {
      const a = windowedMeta({ streamID: "a:eeg:preprocessed:windowed", ...over });
      const b = windowedMeta({
        streamID: "b:eeg:preprocessed:windowed",
        deviceInfo: { model: "stub", id: "b" },
        ...over,
      });
      const analyzer: any = createAnalyzer(method, parameters);
      const declared = analyzer.describeOutput({ a, b });
      expect(declared).toBeTruthy();
      const live = analyzer.analyze({ a: packetFor(a, 512), b: packetFor(b, 512) });
      expect(live).toBeTruthy();
      expectConforms(declared, live);
      return declared as StreamMetadata;
    }

    it.each([
      ["connectivity", {}],
      ["connectivity", { mode: "matrix" }],
      ["connectivity", { mode: "mean", absolute: true }],
      ["difference", { mode: "similarity" }],
      ["difference", { mode: "signed", summaryOnly: true }],
      ["merge", {}],
      ["merge", { prefixLabels: true }],
    ])("%s %j", (method, parameters) => {
      two(method, parameters);
    });

    it("difference keeps the shorter input's length, and only claims it when both say", () => {
      const declared = two("difference", {});
      expect(declared.samplesPerChannel).toBe(512);

      const analyzer: any = createAnalyzer("difference", {});
      const open = analyzer.describeOutput({
        a: windowedMeta(),
        b: windowedMeta({ samplesPerChannel: undefined }),
      });
      expect(open.samplesPerChannel).toBeUndefined();
    });

    it("merge declares no rate where its inputs disagree", () => {
      const analyzer: any = createAnalyzer("merge", {});
      const declared = analyzer.describeOutput({
        a: windowedMeta({ samplingRate: 256 }),
        b: windowedMeta({ samplingRate: 64 }),
      });
      expect(declared.samplingRate).toBeUndefined();
      expect(declared.unresolved).toBeUndefined();
    });
  });

  it("never carries a packet size across a node that does not state one", () => {
    // Band power inherits `samplesPerChannel: 512` from its window in every
    // field but this one — a stale count here would make a feature stream
    // pass for a waveform.
    const declared = createAnalyzer("band_power", {}) as any;
    expect(declared.describeOutput(windowedMeta()).samplesPerChannel).toBe(1);

    const spectrum = createAnalyzer("psd", {}) as any;
    expect(spectrum.describeOutput(windowedMeta()).samplesPerChannel).toBeUndefined();
  });

  it("a channel selection that matches nothing declares no output", () => {
    const analyzer = createAnalyzer("channel_selection", { labels: ["Fz"] }) as any;
    expect(analyzer.describeOutput(windowedMeta())).toBeNull();
  });

  it("is not available from a node that declares nothing", () => {
    expect((createAnalyzer("stream_selection", {}) as any).describeOutput(windowedMeta())).toBeUndefined();
  });
});

/* -------------------------------------------------------------------------- */
/* describe() before data                                                      */
/* -------------------------------------------------------------------------- */

describe("describe() before any data flows", () => {
  function chain(parameters: Record<string, any>, receiver?: StubReceiver) {
    const pipeline = new Pipeline({
      nodes: [
        { id: "eeg", receiver: "dev" },
        { id: "win", method: "windowing", parameters: { size: 2 } },
        { id: "power", method: "band_power", parameters },
      ],
      edges: [
        { from: ["eeg"], to: ["win"] },
        { from: ["win"], to: ["power"] },
      ],
    });
    if (receiver) pipeline.attachReceiver("dev", receiver);
    return pipeline;
  }

  it("names the bands the moment the device is attached", () => {
    const [power] = chain({}, new StubReceiver()).describe();

    expect(power.nodeId).toBe("power");
    expect(power.channels.map((c) => c.label)).toEqual([
      "Delta",
      "Theta",
      "Alpha",
      "Low beta",
      "High beta",
      "Gamma",
    ]);
  });

  it("names band × electrode with perChannel, band-major", () => {
    const [power] = chain({ perChannel: true }, new StubReceiver()).describe();

    expect(power.channels).toHaveLength(6 * 4);
    expect(power.channels.slice(0, 5).map((c) => c.label)).toEqual([
      "Delta TP9",
      "Delta AF7",
      "Delta AF8",
      "Delta TP10",
      "Theta TP9",
    ]);
  });

  it("agrees with what the pipeline then emits", () => {
    const device = new StubReceiver();
    const pipeline = chain({ perChannel: true }, device);
    const before = pipeline.describe()[0];

    const out: DataPacket[] = [];
    pipeline.getOutput("power").subscribe((p) => out.push(p));
    pipeline.start();
    const samples = 2 * 256;
    for (let i = 0; i < samples; i += 12) {
      const frame: number[] = [];
      for (let j = 0; j < 12; j++) for (let c = 0; c < 4; c++) frame.push(Math.sin((i + j) / 5 + c));
      device.send(1000 + i, ...frame);
    }

    expect(out.length).toBeGreaterThan(0);
    const live = pipeline.describe()[0];
    expect(before.channels).toEqual(live.channels);
    expect(before.streamID).toBe(live.streamID);
    expect(out[0].metadata.channelInfo).toEqual(before.channels);
  });

  it("says nothing about the rate when it cannot know it, and the number when it can", () => {
    // Windows skipped to stay current arrive at the packet rate, which the
    // device has not said.
    expect(chain({}, new StubReceiver()).describe()[0].samplingRate).toBeUndefined();

    // Declared, the rate follows: windows of 2 s hopping 2 s at 256 Hz.
    const [sized] = chain({}, new StubReceiver({ samplesPerChannel: 12 })).describe();
    expect(sized.samplingRate).toBeCloseTo(256 / 512);
  });

  it("reports an empty channel list, as before, while nothing is known", () => {
    expect(chain({}).describe()).toEqual([
      expect.objectContaining({ nodeId: "power", channels: [] }),
    ]);
  });

  it("lists every stream a bare source carries", () => {
    const pipeline = new Pipeline({ nodes: [{ id: "eeg", receiver: "dev" }], edges: [] });
    pipeline.attachReceiver("dev", new StubReceiver());

    const [eeg] = pipeline.describe();
    expect(eeg.streamID).toBe("dev:eeg:raw");
    expect(eeg.channels.map((c) => c.label)).toEqual(MUSE);
  });
});

/* -------------------------------------------------------------------------- */
/* issues() before data                                                        */
/* -------------------------------------------------------------------------- */

describe("issues() before any data flows", () => {
  function graph(feed: [string, string][]) {
    return new Pipeline({
      nodes: [
        { id: "eeg", receiver: "dev" },
        { id: "win", method: "windowing", parameters: { size: 2 } },
        { id: "power", method: "band_power" },
        { id: "sync", method: AnalysisMethod.CONNECTIVITY },
      ],
      edges: [
        { from: ["eeg"], to: ["win"] },
        { from: ["win"], to: ["power"] },
        ...feed.map(([from, port]) => ({ from: [from] as [string], to: ["sync", port] as [string, string] })),
      ],
    });
  }

  it("refuses a feature stream where a waveform is needed, with no headset on", () => {
    const pipeline = graph([["power", "a"], ["power", "b"]]);
    pipeline.attachReceiver("dev", new StubReceiver());

    const issues = pipeline.issues();
    expect(issues.map((i) => [i.nodeId, i.port, i.severity])).toEqual([
      ["sync", "a", "error"],
      ["sync", "b", "error"],
    ]);
    expect(issues[0].reason).toMatch(/1 sample per channel/);
    expect(issues[0].reason).toMatch(/windowed waveform/);
  });

  it("is happy with a waveform", () => {
    const pipeline = graph([["win", "a"], ["win", "b"]]);
    pipeline.attachReceiver("dev", new StubReceiver());
    expect(pipeline.issues()).toEqual([]);
  });

  it("judges nothing while the device is unknown", () => {
    expect(graph([["power", "a"], ["power", "b"]]).issues()).toEqual([]);
  });

  it("does not judge a raw device stream that does not say how big its packets are", () => {
    const pipeline = new Pipeline({
      nodes: [
        { id: "eeg", receiver: "dev" },
        { id: "sync", method: AnalysisMethod.CONNECTIVITY },
      ],
      edges: [
        { from: ["eeg"], to: ["sync", "a"] },
        { from: ["eeg"], to: ["sync", "b"] },
      ],
    });
    pipeline.attachReceiver("dev", new StubReceiver());
    expect(pipeline.issues()).toEqual([]);
  });

  it("judges a raw device stream that does", () => {
    const pipeline = new Pipeline({
      nodes: [
        { id: "eeg", receiver: "dev" },
        { id: "sync", method: AnalysisMethod.CONNECTIVITY },
      ],
      edges: [
        { from: ["eeg"], to: ["sync", "a"] },
        { from: ["eeg"], to: ["sync", "b"] },
      ],
    });
    pipeline.attachReceiver("dev", new StubReceiver({ samplesPerChannel: 1 }));
    expect(pipeline.issues().map((i) => i.severity)).toEqual(["error", "error"]);
  });

  it("sees through a selector and a chain of analyzers", () => {
    const pipeline = new Pipeline({
      nodes: [
        { id: "dev", receiver: "dev" },
        { id: "eeg", method: "stream_selection", parameters: { modalities: ["eeg"] } },
        { id: "win", method: "windowing", parameters: { size: 2 } },
        { id: "filt", method: "filtering" },
        { id: "power", method: "band_power" },
        { id: "sync", method: AnalysisMethod.CONNECTIVITY },
      ],
      edges: [
        { from: ["dev"], to: ["eeg"] },
        { from: ["eeg"], to: ["win"] },
        { from: ["win"], to: ["filt"] },
        { from: ["filt"], to: ["power"] },
        { from: ["power"], to: ["sync", "a"] },
        { from: ["power"], to: ["sync", "b"] },
      ],
    });
    pipeline.attachReceiver("dev", new StubReceiver());

    expect(pipeline.issues().map((i) => i.nodeId)).toEqual(["sync", "sync"]);
  });

  it("derives the same verdict once data has flowed", () => {
    const device = new StubReceiver();
    const pipeline = graph([["power", "a"], ["power", "b"]]);
    pipeline.attachReceiver("dev", device);
    const before = pipeline.issues().map((i) => i.reason);

    pipeline.start();
    for (let i = 0; i < 2 * 256; i += 12) {
      const frame: number[] = [];
      for (let j = 0; j < 12; j++) for (let c = 0; c < 4; c++) frame.push(Math.sin((i + j) / 5 + c));
      device.send(1000 + i, ...frame);
    }

    expect(pipeline.issues().map((i) => i.reason)).toEqual(before);
  });
});

/* -------------------------------------------------------------------------- */
/* Not known is not refused                                                    */
/* -------------------------------------------------------------------------- */

describe("what cannot be known ahead of data is not refused", () => {
  const next = (mode: "latest" | "all"): PipelineGraph => ({
    nodes: [
      { id: "eeg", receiver: "dev" },
      { id: "win", method: "windowing", parameters: { size: 2, frames: mode } },
      { id: "power", method: "band_power" },
      // Needs a rate, and band power's rate is the packet rate of its window.
      { id: "later", method: "windowing", parameters: { size: 4 } },
    ],
    edges: [
      { from: ["eeg"], to: ["win"] },
      { from: ["win"], to: ["power"] },
      { from: ["power"], to: ["later"] },
    ],
  });

  it.each(["latest", "all"] as const)(
    "a feature stream whose rate is %s is not read as irregular",
    (mode) => {
      const pipeline = new Pipeline(next(mode));
      pipeline.attachReceiver("dev", new StubReceiver());
      expect(pipeline.issues()).toEqual([]);
    }
  );

  it("an absent rate that really is absent is still refused", () => {
    // Merging two streams at different rates leaves one with no rate, which is
    // a verdict, not a gap.
    const pipeline = new Pipeline({
      nodes: [
        { id: "a", receiver: "slow" },
        { id: "b", receiver: "fast" },
        { id: "both", method: "merge" },
        { id: "win", method: "windowing", parameters: { size: 2 } },
      ],
      edges: [
        { from: ["a"], to: ["both", "a"] },
        { from: ["b"], to: ["both", "b"] },
        { from: ["both"], to: ["win"] },
      ],
    });
    pipeline.attachReceiver("slow", new StubReceiver({ rate: 64 }));
    pipeline.attachReceiver("fast", new StubReceiver({ rate: 256 }));

    const issues = pipeline.issues();
    expect(issues).toHaveLength(1);
    expect(issues[0].nodeId).toBe("win");
    expect(issues[0].reason).toMatch(/no sampling rate/);
  });

  it("falls back to what a node last emitted if it declares nothing", () => {
    class Undeclared extends BaseAnalyzer {
      readonly name = "Undeclared";
      readonly method = AnalysisMethod.CUSTOM;
      readonly stage = ProcessingStage.FEATURES;
      readonly accepts: Accepts = {};
      analyze(packet: DataPacket) {
        return this.emit(packet, Float32Array.of(1), {
          name: "mystery",
          channelInfo: [{ index: 0, label: "Surprise" }],
          samplesPerChannel: 1,
        });
      }
    }
    registerAnalyzer("undeclared_for_test", () => new Undeclared());

    const device = new StubReceiver({ labels: ["x"] });
    const pipeline = new Pipeline({
      nodes: [
        { id: "eeg", receiver: "dev" },
        { id: "odd", method: "undeclared_for_test" },
        { id: "sync", method: AnalysisMethod.CONNECTIVITY },
      ],
      edges: [
        { from: ["eeg"], to: ["odd"] },
        { from: ["odd"], to: ["sync", "a"] },
        { from: ["odd"], to: ["sync", "b"] },
      ],
    });
    pipeline.attachReceiver("dev", device);

    // Nothing to go on yet: not judged, not crashed.
    expect(pipeline.issues()).toEqual([]);
    expect(pipeline.describe()).toEqual([
      expect.objectContaining({ nodeId: "sync", channels: [] }),
    ]);

    // After it has emitted, what it said is what is known.
    pipeline.start();
    device.send(1000, 1);
    expect(pipeline.issues().map((i) => i.nodeId)).toEqual(["sync", "sync"]);
  });

  it("exposes a way for a custom node to say its rate is not known yet", () => {
    expect(typeof UNRESOLVED).toBe("symbol");
    expect(isMultiInput(createAnalyzer("merge", {}))).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* expects                                                                     */
/* -------------------------------------------------------------------------- */

describe("a source that declares what it expects", () => {
  const eeg = (over: Partial<StreamMetadata> = {}): StreamMetadata => ({
    streamID: "peer:eeg:raw",
    modality: Modality.EEG,
    samplingRate: 256,
    channelCount: 4,
    channelInfo: MUSE.map((label, index) => ({ index, label })),
    ...over,
  });

  const graph = (expects: StreamMetadata[]) =>
    new Pipeline({
      nodes: [
        { id: "wire", receive: { transport: "cloud" }, expects },
        { id: "win", method: "windowing", parameters: { size: 2 } },
        { id: "power", method: "band_power" },
        { id: "sync", method: AnalysisMethod.CONNECTIVITY },
      ],
      edges: [
        { from: ["wire"], to: ["win"] },
        { from: ["win"], to: ["power"] },
        { from: ["power"], to: ["sync", "a"] },
        { from: ["power"], to: ["sync", "b"] },
      ],
    });

  it("lets a pipeline be described before the transport exists", () => {
    const pipeline = new Pipeline({
      nodes: [
        { id: "wire", receive: { transport: "cloud" }, expects: [eeg()] },
        { id: "win", method: "windowing", parameters: { size: 2 } },
        { id: "power", method: "band_power" },
      ],
      edges: [
        { from: ["wire"], to: ["win"] },
        { from: ["win"], to: ["power"] },
      ],
    });

    expect(pipeline.describe()[0].channels.map((c) => c.label)).toEqual([
      "Delta",
      "Theta",
      "Alpha",
      "Low beta",
      "High beta",
      "Gamma",
    ]);
  });

  it("lets a graph be checked before the transport exists", () => {
    expect(graph([eeg()]).issues().map((i) => i.nodeId)).toEqual(["sync", "sync"]);
  });

  it("is the whole of what is known while nothing has been announced", () => {
    expect(graph([]).issues()).toEqual([]);
  });

  it("is replaced by what the device really announces", () => {
    const pipeline = new Pipeline({
      nodes: [
        {
          id: "eeg",
          receiver: "dev",
          expects: [eeg({ channelInfo: [{ index: 0, label: "Stale" }], channelCount: 1 })],
        },
        { id: "stats", method: "statistical_features", parameters: { features: ["rms"] } },
      ],
      edges: [{ from: ["eeg"], to: ["stats"] }],
    });

    expect(pipeline.describe()[0].channels.map((c) => c.label)).toEqual(["Stale rms"]);

    pipeline.attachReceiver("dev", new StubReceiver());
    expect(pipeline.describe()[0].channels.map((c) => c.label)).toEqual(
      MUSE.map((label) => `${label} rms`)
    );
  });

  it("is narrowed by the node's `stream`", () => {
    const pipeline = new Pipeline({
      nodes: [
        {
          id: "eeg",
          receiver: "dev",
          stream: Modality.EEG,
          expects: [
            eeg(),
            eeg({ streamID: "peer:ppg:raw", modality: Modality.PPG, channelInfo: [{ index: 0, label: "PPG" }], channelCount: 1 }),
          ],
        },
      ],
      edges: [],
    });

    expect(pipeline.describe().map((d) => d.streamID)).toEqual(["peer:eeg:raw"]);
  });

  it("is refused on a node that is not a source", () => {
    expect(
      () =>
        new Pipeline({
          nodes: [
            { id: "dev", receiver: "dev" },
            { id: "win", method: "windowing", expects: [eeg()] },
          ],
          edges: [{ from: ["dev"], to: ["win"] }],
        })
    ).toThrow(/only a source node/);
  });
});

/* -------------------------------------------------------------------------- */
/* start({ validate })                                                         */
/* -------------------------------------------------------------------------- */

describe("start({ validate: true })", () => {
  const broken = () => {
    const device = new StubReceiver();
    const pipeline = new Pipeline({
      nodes: [
        { id: "eeg", receiver: "dev" },
        { id: "win", method: "windowing", parameters: { size: 2, hop: 1 / 256 } },
        { id: "power", method: "band_power" },
        { id: "sync", method: AnalysisMethod.CONNECTIVITY },
      ],
      edges: [
        { from: ["eeg"], to: ["win"] },
        { from: ["win"], to: ["power"] },
        { from: ["power"], to: ["sync", "a"] },
        { from: ["power"], to: ["sync", "b"] },
      ],
    });
    pipeline.attachReceiver("dev", device);
    return { device, pipeline };
  };

  it("throws listing every error, and does not start", () => {
    const { device, pipeline } = broken();
    const seen: DataPacket[] = [];
    pipeline.getOutput("power").subscribe((p) => seen.push(p));

    expect(() => pipeline.start({ validate: true })).toThrow(/2 compatibility problems/);
    expect(() => pipeline.start({ validate: true })).toThrow(/"sync" port "a"/);
    expect(() => pipeline.start({ validate: true })).toThrow(/"sync" port "b"/);

    // Not running: a packet goes nowhere.
    device.send(1000, 1, 2, 3, 4);
    expect(seen).toEqual([]);
  });

  it("is off by default: the same graph starts", () => {
    const { device, pipeline } = broken();
    expect(() => pipeline.start()).not.toThrow();

    const seen: DataPacket[] = [];
    pipeline.getOutput("win").subscribe((p) => seen.push(p));
    device.send(1000, ...new Array(4 * 512).fill(1));
    expect(seen.length).toBeGreaterThan(0);
  });

  it("lets warnings through", () => {
    // A fat wire: only one of the device's two streams is usable.
    const pipeline = new Pipeline({
      nodes: [
        { id: "dev", receiver: "dev" },
        { id: "power", method: "band_power" },
      ],
      edges: [{ from: ["dev"], to: ["power"] }],
    });
    class Fat extends StubReceiver {
      constructor() {
        super();
        (this as any).initializeStream({
          modality: Modality.EEG,
          name: "markers",
          additionalMetadata: { channelCount: 1 },
        });
      }
    }
    pipeline.attachReceiver("dev", new Fat());

    expect(pipeline.issues().map((i) => i.severity)).toEqual(["warning"]);
    expect(() => pipeline.start({ validate: true })).not.toThrow();
  });

  it("is the only way in: validate() is gone", () => {
    expect((Pipeline.prototype as any).validate).toBeUndefined();
  });
});
