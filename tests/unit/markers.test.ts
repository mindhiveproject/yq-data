/**
 * Event markers, and the compatibility layer that keeps them out of analyzers
 * which would turn them into meaningless numbers.
 */
import {
  AnalysisMethod,
  DataPacket,
  MarkerReceiver,
  Modality,
  Pipeline,
  Recorder,
  canConnect,
  compatibleMethods,
  registeredMethods,
} from "../../src";

function connectedMarkers(): MarkerReceiver {
  const markers = new MarkerReceiver();
  markers.connect();
  return markers;
}

describe("MarkerReceiver", () => {
  it("emits one labelled sample per mark", (done) => {
    const markers = connectedMarkers();

    markers.data.subscribe((packet: DataPacket) => {
      expect(packet.labels).toEqual(["stimulus_onset"]);
      expect(packet.data.length).toBe(1);
      expect(packet.metadata.modality).toBe(Modality.EVENT_MARKER);
      expect(packet.metadata.valueType).toBe("categorical");
      done();
    });

    markers.mark("stimulus_onset");
  });

  it("preserves a caller-supplied timestamp", (done) => {
    const markers = connectedMarkers();
    const onset = Date.now() - 5000;

    markers.data.subscribe((packet: DataPacket) => {
      expect(packet.timestamp).toBe(onset);
      done();
    });

    markers.mark("late_report", { timestamp: onset });
  });

  it("stamps ingest time when the caller supplies none", (done) => {
    const markers = connectedMarkers();
    const before = Date.now();

    markers.data.subscribe((packet: DataPacket) => {
      expect(packet.timestamp).toBeGreaterThanOrEqual(before);
      expect(packet.timestamp).toBeLessThanOrEqual(Date.now());
      done();
    });

    markers.mark("now");
  });

  it("assigns a stable code per distinct label", () => {
    const markers = connectedMarkers();
    const seen: number[] = [];
    markers.data.subscribe((packet) => seen.push(packet.data[0]));

    markers.mark("a");
    markers.mark("b");
    markers.mark("a");

    expect(seen).toEqual([1, 2, 1]);
    expect(markers.markerCodes).toEqual({ a: 1, b: 2 });
  });

  it("honours an explicit code", (done) => {
    const markers = connectedMarkers();
    markers.data.subscribe((packet) => {
      expect(packet.data[0]).toBe(42);
      done();
    });
    markers.mark("answer", { value: 42 });
  });

  it("declares no sampling rate, because markers are sporadic", () => {
    const markers = connectedMarkers();
    const meta = markers.getStreamMeta(Modality.EVENT_MARKER);
    expect(meta?.samplingRate).toBeUndefined();
    expect(meta?.valueType).toBe("categorical");
  });

  it("drops marks while stopped, and resumes on start", () => {
    const markers = connectedMarkers();
    const seen: string[] = [];
    markers.data.subscribe((p) => seen.push(p.labels![0]));

    markers.mark("one");
    markers.stopStream();
    markers.mark("dropped");
    markers.startStream();
    markers.mark("two");

    expect(seen).toEqual(["one", "two"]);
  });

  it("does nothing before connect(), so an experiment runs unattended", () => {
    const markers = new MarkerReceiver();
    expect(() => markers.mark("no_listener")).not.toThrow();
    expect(markers.streams).toEqual([]);
  });
});

describe("compatibility", () => {
  const markerMeta = () => {
    const markers = connectedMarkers();
    return markers.getStreamMeta(Modality.EVENT_MARKER)!;
  };

  it("refuses markers on rate-dependent analyzers, with a reason", () => {
    for (const method of [
      AnalysisMethod.FILTERING,
      AnalysisMethod.BAND_POWER,
      AnalysisMethod.PSD,
      AnalysisMethod.HEART_RATE,
    ]) {
      const verdict = canConnect(markerMeta(), method);
      expect(typeof verdict).toBe("string");
      expect(verdict).toMatch(/labels rather than measurements/);
    }
  });

  it("refuses markers on analyzers that would otherwise accept anything", () => {
    for (const method of [
      AnalysisMethod.NORMALIZATION,
      AnalysisMethod.STATISTICAL_FEATURES,
      AnalysisMethod.CHANNEL_SELECTION,
      AnalysisMethod.RMS,
      AnalysisMethod.WINDOWING,
    ]) {
      expect(canConnect(markerMeta(), method)).not.toBe(true);
    }
  });

  it("refuses markers on both ports of a multi-input node", () => {
    expect(canConnect(markerMeta(), AnalysisMethod.CONNECTIVITY, {}, "a")).not.toBe(
      true
    );
    expect(canConnect(markerMeta(), AnalysisMethod.CONNECTIVITY, {}, "b")).not.toBe(
      true
    );
  });

  it("leaves no method that will accept a marker stream", () => {
    expect(compatibleMethods(markerMeta(), registeredMethods())).toEqual([]);
  });

  it("still accepts an ordinary sampled stream", () => {
    const meta = {
      streamID: "muse-1:eeg:raw",
      modality: Modality.EEG,
      samplingRate: 256,
      channelCount: 4,
    };
    expect(canConnect(meta, AnalysisMethod.FILTERING)).toBe(true);
    expect(canConnect(meta, AnalysisMethod.BAND_POWER)).toBe(true);
  });

  it("reports a rate requirement separately from a value-type one", () => {
    const irregular = {
      streamID: "relay:eeg:raw",
      modality: Modality.EEG,
      channelCount: 1,
    };
    expect(canConnect(irregular, AnalysisMethod.FILTERING)).toMatch(
      /no sampling rate/
    );
  });

  it("lets windowing take an irregular stream when sized in samples", () => {
    const irregular = {
      streamID: "relay:eeg:raw",
      modality: Modality.EEG,
      channelCount: 1,
    };
    expect(
      canConnect(irregular, AnalysisMethod.WINDOWING, { unit: "samples", size: 8 })
    ).toBe(true);
    expect(canConnect(irregular, AnalysisMethod.WINDOWING, { size: 2 })).toMatch(
      /no sampling rate/
    );
  });

  it("names an unknown port rather than silently passing", () => {
    expect(
      canConnect(markerMeta(), AnalysisMethod.CONNECTIVITY, {}, "nope")
    ).toMatch(/no input port named "nope"/);
  });
});

describe("Pipeline validation", () => {
  const graph = {
    nodes: [
      { id: "markers", receiver: "markers" as const },
      { id: "power", method: AnalysisMethod.BAND_POWER },
    ],
    edges: [{ from: ["markers"] as [string], to: ["power"] as [string] }],
  };

  it("reports an incompatible edge once its receiver is attached", () => {
    const pipeline = new Pipeline(graph);
    // Nothing is knowable before a receiver supplies metadata.
    expect(pipeline.issues()).toEqual([]);

    pipeline.attachReceiver("markers", connectedMarkers());

    const issues = pipeline.issues();
    expect(issues).toHaveLength(1);
    expect(issues[0].nodeId).toBe("power");
    expect(issues[0].reason).toMatch(/labels rather than measurements/);
  });

  it("validate() throws listing every problem", () => {
    const pipeline = new Pipeline(graph);
    pipeline.attachReceiver("markers", connectedMarkers());
    expect(() => pipeline.validate()).toThrow(/compatibility problem/);
    expect(() => pipeline.validate()).toThrow(/"power"/);
  });

  it("flags a multi-input node with an unconnected port", () => {
    const pipeline = new Pipeline({
      nodes: [
        { id: "markers", receiver: "markers" },
        { id: "corr", method: AnalysisMethod.CONNECTIVITY },
      ],
      edges: [{ from: ["markers"], to: ["corr", "a"] }],
    });

    const unconnected = pipeline
      .issues()
      .filter((i) => /not connected/.test(i.reason));
    expect(unconnected).toHaveLength(1);
    expect(unconnected[0].port).toBe("b");
  });

  it("drops an incompatible branch at runtime instead of tearing down", () => {
    const errors: Array<{ nodeId: string; error: unknown }> = [];
    const pipeline = new Pipeline(graph, {
      onError: (error, nodeId) => errors.push({ error, nodeId }),
    });

    const markers = connectedMarkers();
    pipeline.attachReceiver("markers", markers);
    pipeline.start();

    const emitted: DataPacket[] = [];
    pipeline.getOutput("power").subscribe((p) => emitted.push(p));

    markers.mark("one");
    markers.mark("two");
    markers.mark("three");

    expect(emitted).toEqual([]);
    // Checked once, on the first packet — not per marker.
    expect(errors).toHaveLength(1);
    expect(String((errors[0].error as Error).message)).toMatch(
      /cannot accept input on port/
    );
  });

  it("passes a marker stream straight through a source node", () => {
    const pipeline = new Pipeline({
      nodes: [{ id: "markers", receiver: "markers" }],
      edges: [],
    });

    const markers = connectedMarkers();
    pipeline.attachReceiver("markers", markers);
    pipeline.start();

    const seen: DataPacket[] = [];
    pipeline.getOutput("markers").subscribe((p) => seen.push(p));

    markers.mark("trial_start");

    expect(pipeline.issues()).toEqual([]);
    expect(seen).toHaveLength(1);
    expect(seen[0].labels).toEqual(["trial_start"]);
  });
});

describe("Recorder", () => {
  it("captures markers as a labelled track", () => {
    const markers = connectedMarkers();
    const recorder = new Recorder();
    recorder.addReceiver(markers);
    recorder.start();

    markers.mark("trial_start");
    markers.mark("response");
    markers.mark("trial_start");

    recorder.stop();

    const summary = recorder.summary;
    expect(summary).toHaveLength(1);
    expect(summary[0].samples).toBe(3);
    expect(summary[0].channels).toBe(1);
  });
});
