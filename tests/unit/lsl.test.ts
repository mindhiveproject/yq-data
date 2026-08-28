/**
 * LSL stream registration and decoding.
 *
 * These drive the receiver's message handling directly rather than through a
 * socket: what is under test is how a relay's JSON becomes packets, and a real
 * WebSocket would add nothing but a server to tear down.
 */
import {
  AnalysisMethod,
  DataPacket,
  LSLReceiver,
  Modality,
  Pipeline,
  canConnect,
  compatibleMethods,
  registeredMethods,
} from "../../src";

/** An LSL receiver wired up as if a relay had connected, minus the socket. */
function relay(): LSLReceiver {
  const receiver = new LSLReceiver();
  (receiver as any).isConnected = true;
  receiver.startStream();
  return receiver;
}

/** Feeds one relay message in, as `onmessage` would. */
function send(receiver: LSLReceiver, payload: unknown): void {
  (receiver as any).handleMessage({ data: JSON.stringify(payload) });
}

const MARKER_INFO = {
  name: "trials",
  type: "Markers",
  channel_count: 1,
  // 3 is LSL's string format, which is what a marker outlet actually uses.
  channel_format: 3,
  source_id: "psychopy-1",
};

describe("LSL marker streams", () => {
  it("registers a string-format marker stream instead of dropping it", () => {
    const receiver = relay();
    send(receiver, { trials: { info: MARKER_INFO } });

    expect(receiver.discoveredStreams).toEqual(["trials"]);
    expect(receiver.streams).toHaveLength(1);
  });

  it("declares itself categorical and rate-free", () => {
    const receiver = relay();
    send(receiver, { trials: { info: MARKER_INFO } });

    const meta = receiver.getStreamMeta(receiver.streams[0])!;
    expect(meta.modality).toBe(Modality.EVENT_MARKER);
    expect(meta.valueType).toBe("categorical");
    expect(meta.samplingRate).toBeUndefined();
    expect(meta.channelCount).toBe(1);
  });

  it("ignores a nominal rate the relay reports for markers", () => {
    const receiver = relay();
    send(receiver, {
      trials: { info: { ...MARKER_INFO, nominal_srate: 10 } },
    });

    const meta = receiver.getStreamMeta(receiver.streams[0])!;
    expect(meta.samplingRate).toBeUndefined();
  });

  it("carries the label and assigns a stable numeric code", () => {
    const receiver = relay();
    send(receiver, { trials: { info: MARKER_INFO } });

    const seen: DataPacket[] = [];
    receiver.data.subscribe((packet) => seen.push(packet));

    send(receiver, { trials: { timeseries: ["go"], timestamp: 100 } });
    send(receiver, { trials: { timeseries: ["stop"], timestamp: 101 } });
    send(receiver, { trials: { timeseries: ["go"], timestamp: 102 } });

    expect(seen.map((p) => p.labels?.[0])).toEqual(["go", "stop", "go"]);
    expect(seen.map((p) => p.data[0])).toEqual([1, 2, 1]);
    expect(seen[0].metadata.additionalMetadata?.markerCodes).toEqual({
      go: 1,
      stop: 2,
    });
  });

  it("accepts markers nested one per channel, as some relays send them", () => {
    const receiver = relay();
    send(receiver, { trials: { info: MARKER_INFO } });

    const seen: DataPacket[] = [];
    receiver.data.subscribe((packet) => seen.push(packet));

    send(receiver, { trials: { timeseries: [["go"], ["stop"]] } });

    expect(seen).toHaveLength(1);
    expect(seen[0].labels).toEqual(["go", "stop"]);
  });

  it("keeps the LSL clock in deviceTime rather than timestamp", () => {
    const receiver = relay();
    send(receiver, { trials: { info: MARKER_INFO } });

    const seen: DataPacket[] = [];
    receiver.data.subscribe((packet) => seen.push(packet));

    send(receiver, { trials: { timeseries: ["go"], timestamp: 12.5 } });

    // Seconds in the sender's domain, converted to ms but not claimed as ours.
    expect(seen[0].deviceTime).toBe(12500);
    expect(seen[0].timestamp).not.toBe(12500);
  });

  it("is refused by every analyzing node, exactly like an in-page marker", () => {
    const receiver = relay();
    send(receiver, { trials: { info: MARKER_INFO } });
    const meta = receiver.getStreamMeta(receiver.streams[0])!;

    // This is the bug that prompted the fix: without valueType these four
    // would have averaged marker codes into a meaningless number.
    for (const method of [
      AnalysisMethod.NORMALIZATION,
      AnalysisMethod.STATISTICAL_FEATURES,
      AnalysisMethod.CHANNEL_SELECTION,
      AnalysisMethod.RMS,
    ]) {
      expect(canConnect(meta, method)).toMatch(/labels rather than measurements/);
    }

    expect(compatibleMethods(meta, registeredMethods())).toEqual([
      AnalysisMethod.STREAM_SELECTION,
    ]);
  });
});

describe("LSL ordinary streams", () => {
  const EEG_INFO = {
    name: "BioSemi",
    type: "EEG",
    channel_count: 2,
    channel_format: 1,
    nominal_srate: 256,
    source_id: "biosemi-1",
  };

  it("keeps its rate and stays numeric", () => {
    const receiver = relay();
    send(receiver, { eeg: { info: EEG_INFO } });

    const meta = receiver.getStreamMeta(receiver.streams[0])!;
    expect(meta.modality).toBe(Modality.EEG);
    expect(meta.samplingRate).toBe(256);
    expect(meta.valueType).toBeUndefined();
    expect(canConnect(meta, AnalysisMethod.FILTERING)).toBe(true);
  });

  it("forwards samples unchanged", () => {
    const receiver = relay();
    send(receiver, { eeg: { info: EEG_INFO } });

    const seen: DataPacket[] = [];
    receiver.data.subscribe((packet) => seen.push(packet));

    send(receiver, { eeg: { timeseries: [1, 2, 3, 4], timestamp: 5 } });

    expect(Array.from(seen[0].data)).toEqual([1, 2, 3, 4]);
    expect(seen[0].labels).toBeUndefined();
  });

  it("still refuses a genuinely non-numeric stream", () => {
    const receiver = relay();
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});

    send(receiver, {
      notes: { info: { name: "notes", type: "Text", channel_format: 3 } },
    });

    expect(receiver.streams).toHaveLength(0);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("LSL streams in a pipeline", () => {
  const EEG_INFO = {
    name: "BioSemi",
    type: "EEG",
    channel_count: 2,
    channel_format: 1,
    nominal_srate: 256,
    source_id: "biosemi-1",
  };

  it("resolves a source node's stream against IDs named for the source device", () => {
    const receiver = relay();
    const pipeline = new Pipeline({
      nodes: [{ id: "eeg", receiver: "lsl", stream: Modality.EEG }],
      edges: [],
    });
    pipeline.attachReceiver("lsl", receiver);
    pipeline.start();

    const seen: DataPacket[] = [];
    pipeline.getOutput("eeg").subscribe((p) => seen.push(p));

    // A relay registers each stream under its *source's* ID — "biosemi-1"
    // here, never the receiver's own "LSL" — and only once it has been
    // discovered. Both defeat resolving the shortcut by constructed ID.
    send(receiver, { eeg: { info: EEG_INFO } });
    send(receiver, { eeg: { timeseries: [1, 2, 3, 4], timestamp: 5 } });

    expect(seen).toHaveLength(1);
    expect(seen[0].streamID).toBe("biosemi-1:eeg:raw:BioSemi");
    expect(Array.from(seen[0].data)).toEqual([1, 2, 3, 4]);
  });

  it("keeps a marker outlet off a node that cannot read it", () => {
    const receiver = relay();
    send(receiver, { eeg: { info: EEG_INFO } });
    send(receiver, { trials: { info: MARKER_INFO } });

    const pipeline = new Pipeline({
      nodes: [
        { id: "lsl", receiver: "lsl" },
        { id: "power", method: AnalysisMethod.BAND_POWER },
      ],
      edges: [{ from: ["lsl"], to: ["power"] }],
    });
    pipeline.attachReceiver("lsl", receiver);

    // The relay's two streams disagree about what band power can do with
    // them, and the graph is judged on the set rather than on whichever
    // stream happened to be announced first.
    const issues = pipeline.issues();
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe("warning");
    expect(issues[0].reason).toMatch(/1 of 2 streams on this edge/);
  });
});
