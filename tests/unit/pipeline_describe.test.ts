/**
 * `describe()` on the graphs people actually write.
 *
 * The static-output suite proves the chain of analyzers against a stub that
 * announces its stream in its constructor. Real devices do not: a Muse learns
 * its streams while connecting, a vision receiver while its model loads. Here
 * the graphs from the README are described with the real receiver classes,
 * built and attached but never connected, which is the position a node editor
 * is in before anyone has put a headset on.
 */
import {
  AnalysisMethod,
  BaseReceiver,
  FaceEmotionReceiver,
  FaceLandmarkReceiver,
  Modality,
  MuseReceiver,
  Pipeline,
  PipelineGraph,
  PoseReceiver,
  RPPGReceiver,
  StreamMetadata,
} from "../../src";

const video = {} as HTMLVideoElement;

/** A device that cannot say what it will carry until something is on the other end. */
class SilentReceiver extends BaseReceiver {
  deviceName = "silent";
  modalities = [Modality.EEG];
  deviceID = "silent";
  connect(): void {}
  disconnect(): void {}
  startStream(): void {}
  stopStream(): void {}
}

function describeWith(graph: PipelineGraph, receivers: Record<string, BaseReceiver<any>>) {
  const pipeline = new Pipeline(graph);
  for (const [key, receiver] of Object.entries(receivers)) {
    pipeline.attachReceiver(key, receiver);
  }
  return { pipeline, described: pipeline.describe() };
}

const labels = (channels: Array<{ label: string }>) => channels.map((c) => c.label);

describe("describe() before a device has connected", () => {
  it("names band power from an unconnected Muse (README: band power)", () => {
    const { pipeline, described } = describeWith(
      {
        nodes: [
          { id: "eeg", receiver: "muse", stream: Modality.EEG },
          { id: "clean", method: AnalysisMethod.FILTERING, parameters: { kind: "bandpass", cutoff: [1, 45] } },
          { id: "window", method: AnalysisMethod.WINDOWING, parameters: { size: 2, hop: 0.1 } },
          { id: "bands", method: AnalysisMethod.BAND_POWER, label: "Band power" },
        ],
        edges: [
          { from: ["eeg"], to: ["clean"] },
          { from: ["clean"], to: ["window"] },
          { from: ["window"], to: ["bands"] },
        ],
      },
      { muse: new MuseReceiver() }
    );

    expect(described).toHaveLength(1);
    expect(labels(described[0].channels)).toEqual([
      "Delta", "Theta", "Alpha", "Low beta", "High beta", "Gamma",
    ]);
    expect(described[0].reason).toBeUndefined();
    expect(pipeline.issues()).toEqual([]);
  });

  it("names heart rate from an unconnected Muse's PPG", () => {
    const { pipeline, described } = describeWith(
      {
        nodes: [
          { id: "ppg", receiver: "muse", stream: Modality.PPG },
          { id: "window", method: AnalysisMethod.WINDOWING, parameters: { size: 10, hop: 1 } },
          { id: "bpm", method: AnalysisMethod.HEART_RATE },
        ],
        edges: [
          { from: ["ppg"], to: ["window"] },
          { from: ["window"], to: ["bpm"] },
        ],
      },
      { muse: new MuseReceiver() }
    );

    expect(labels(described[0].channels)).toEqual(["Heart Rate"]);
    expect(pipeline.issues()).toEqual([]);
  });

  it("leaves PPG out of a Muse built without it", () => {
    const { described } = describeWith(
      {
        nodes: [{ id: "ppg", receiver: "muse", stream: Modality.PPG }],
        edges: [],
      },
      { muse: new MuseReceiver(false) }
    );

    expect(described[0].channels).toEqual([]);
    expect(described[0].reason).toMatch(/carries no stream matching "ppg"/);
  });

  it("names a camera's heart rate end to end (README: heart rate from a camera)", () => {
    const { pipeline, described } = describeWith(
      {
        nodes: [
          { id: "rgb", receiver: "rppg" },
          { id: "pulse", method: AnalysisMethod.PULSE_EXTRACTION },
          { id: "window", method: AnalysisMethod.WINDOWING, parameters: { size: 10, hop: 1 } },
          { id: "bpm", method: AnalysisMethod.HEART_RATE },
        ],
        edges: [
          { from: ["rgb"], to: ["pulse"] },
          { from: ["pulse"], to: ["window"] },
          { from: ["window"], to: ["bpm"] },
        ],
      },
      { rppg: new RPPGReceiver(video, { samplingRate: 30 }) }
    );

    expect(labels(described[0].channels)).toEqual(["Heart Rate"]);
    expect(pipeline.issues()).toEqual([]);
  });

  it("lists every stream a face tracker will carry, per face", () => {
    const { described } = describeWith(
      { nodes: [{ id: "face", receiver: "face" }], edges: [] },
      {
        face: new FaceLandmarkReceiver(video, {
          numFaces: 2,
          emitFaceBox: true,
          emitLandmarks: true,
        }),
      }
    );

    const ids = described.map((d) => d.streamID);
    // blendshapes, head pose, face box and landmarks, for each of two faces.
    expect(ids).toHaveLength(8);
    expect(ids.some((id) => id?.endsWith("landmarks_face_2"))).toBe(true);
    const landmarks = described.find((d) => d.streamID?.endsWith("landmarks_face_1"))!;
    expect(landmarks.points?.length).toBeGreaterThan(0);
    expect(landmarks.samplingRate).toBe(30);
  });

  it("describes face emotion and pose receivers before their models load", () => {
    const { described } = describeWith(
      {
        nodes: [
          { id: "emotion", receiver: "emotion" },
          { id: "pose", receiver: "pose" },
        ],
        edges: [],
      },
      { emotion: new FaceEmotionReceiver(video), pose: new PoseReceiver(video) }
    );

    const expressions = described.find((d) => d.nodeId === "emotion")!;
    expect(labels(expressions.channels)).toContain("happy");
    const pose = described.find((d) => d.nodeId === "pose")!;
    expect(pose.points?.some((p) => p.label === "left wrist")).toBe(true);
  });

  it("splits and re-joins an unconnected Muse (README: routing)", () => {
    const { pipeline, described } = describeWith(
      {
        nodes: [
          { id: "device", receiver: "muse" },
          { id: "eeg", method: AnalysisMethod.STREAM_SELECTION, parameters: { modalities: [Modality.EEG] } },
          { id: "pulse", method: AnalysisMethod.STREAM_SELECTION, parameters: { modalities: [Modality.PPG] } },
          { id: "bundle", method: AnalysisMethod.MERGE, parameters: { inputs: 2 } },
        ],
        edges: [
          { from: ["device"], to: ["eeg"] },
          { from: ["device"], to: ["pulse"] },
          { from: ["eeg"], to: ["bundle", "a"] },
          { from: ["pulse"], to: ["bundle", "b"] },
        ],
      },
      { muse: new MuseReceiver() }
    );

    // 4 EEG electrodes and 3 PPG channels.
    expect(described[0].channels).toHaveLength(7);
    expect(pipeline.issues()).toEqual([]);
  });
});

describe("where a source's streams come from", () => {
  const eegGraph: PipelineGraph = {
    nodes: [
      { id: "eeg", receiver: "muse", stream: Modality.EEG },
      { id: "window", method: AnalysisMethod.WINDOWING, parameters: { size: 2, hop: 0.1 } },
      { id: "bands", method: AnalysisMethod.BAND_POWER },
    ],
    edges: [
      { from: ["eeg"], to: ["window"] },
      { from: ["window"], to: ["bands"] },
    ],
  };

  const expected = (labels: string[]): StreamMetadata => ({
    streamID: "headband:eeg:raw",
    modality: Modality.EEG,
    samplingRate: 128,
    channelCount: labels.length,
    channelInfo: labels.map((label, index) => ({ index, label })),
    deviceInfo: { model: "headband", id: "headband", modalities: [Modality.EEG] },
  });

  it("prefers a node's own expects over the receiver's guess", () => {
    const graph: PipelineGraph = {
      ...eegGraph,
      nodes: [
        { ...eegGraph.nodes[0], expects: [expected(["Fz", "Cz"])] },
        ...eegGraph.nodes.slice(1),
      ],
    };
    const perChannel: PipelineGraph = {
      ...graph,
      nodes: [
        ...graph.nodes.slice(0, 2),
        { id: "bands", method: AnalysisMethod.BAND_POWER, parameters: { perChannel: true } },
      ],
    };

    const { described } = describeWith(perChannel, { muse: new MuseReceiver() });

    // Fz and Cz are the node's, not the Muse's TP9/AF7/AF8/TP10.
    expect(labels(described[0].channels).slice(0, 2)).toEqual(["Delta Fz", "Delta Cz"]);
  });

  it("hands over to the receiver's own metadata once it has registered", () => {
    const muse = new MuseReceiver();
    const pipeline = new Pipeline(eegGraph);
    pipeline.attachReceiver("muse", muse);
    const before = pipeline.describe()[0].streamID;

    // What connect() does with the headband's real name.
    (muse as any).deviceID = "Muse-4B2C";
    for (const options of (muse as any).plannedStreams()) (muse as any).ensureStream(options);

    expect(before).toBe("Muse:eeg:features:band_power");
    expect(pipeline.describe()[0].streamID).toBe("Muse-4B2C:eeg:features:band_power");
  });
});

describe("describe() says why an output is empty", () => {
  const graph: PipelineGraph = {
    nodes: [
      { id: "eeg", receiver: "dev", stream: Modality.EEG },
      { id: "window", method: AnalysisMethod.WINDOWING, parameters: { size: 2, hop: 0.1 } },
      { id: "bands", method: AnalysisMethod.BAND_POWER },
    ],
    edges: [
      { from: ["eeg"], to: ["window"] },
      { from: ["window"], to: ["bands"] },
    ],
  };

  it("names the receiver nobody attached", () => {
    const [output] = new Pipeline(graph).describe();

    expect(output.channels).toEqual([]);
    expect(output.reason).toMatch(/no receiver is attached for "dev"/);
    expect(output.reason).toMatch(/expects/);
  });

  it("names a receiver that cannot say what it will carry", () => {
    const [output] = describeWith(graph, { dev: new SilentReceiver() }).described;

    expect(output.reason).toMatch(/"dev" \(silent\) has not announced its streams/);
  });

  it("is absent when the output is known", () => {
    const [output] = describeWith(graph, { dev: new MuseReceiver() }).described;

    expect(output.channels.length).toBeGreaterThan(0);
    expect(output).not.toHaveProperty("reason");
  });

  it("points at the source even when the gap is several nodes upstream", () => {
    const [output] = new Pipeline(graph).describe();

    expect(output.nodeId).toBe("bands");
    expect(output.reason).toContain('"eeg"');
  });
});
