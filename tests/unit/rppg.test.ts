/**
 * Camera pulse: the RPPGReceiver, the PulseExtraction node, and the gap rule
 * that lets a pipeline restart cleanly when the face is lost.
 *
 * MediaPipe, the canvas and `document` are faked. What is pinned here is what
 * the golden suite cannot see: which pixels are read, how irregular frames
 * become a regular stream, what a lost face looks like downstream, and that a
 * shared landmarker really is shared. `golden/rppg.test.ts` covers the maths.
 */
import {
  BLENDSHAPE_NAMES,
  DataPacket,
  FaceLandmarkReceiver,
  FrameResampler,
  GapDetector,
  Modality,
  PulseExtraction,
  RPPGReceiver,
  RPPG_SKIN_POLYGONS,
  StreamMetadata,
  Windowing,
  createAnalyzer,
  AnalysisMethod,
  meanSkinColor,
  regionPolygons,
  skinPolygons,
} from "../../src";

/* -------------------------------------------------------------------------- */
/* Fakes                                                                      */
/* -------------------------------------------------------------------------- */

function withVision<T>(receiver: T, vision: unknown): T {
  jest.spyOn(receiver as any, "loadVisionModule").mockResolvedValue(vision as never);
  return receiver;
}

/** A Face Landmarker whose next result the test sets. */
function fakeMediaPipe() {
  const state = { faces: [] as unknown[], created: 0, calls: 0 };
  const task = {
    detectForVideo: () => {
      state.calls++;
      return {
        faceLandmarks: state.faces,
        faceBlendshapes: state.faces.map(() => ({
          categories: BLENDSHAPE_NAMES.map((_, index) => ({ index, score: 0 })),
        })),
      };
    },
    close: () => {},
  };
  const vision = {
    FilesetResolver: { forVisionTasks: async () => ({}) },
    FaceLandmarker: {
      createFromOptions: async () => {
        state.created++;
        return task;
      },
    },
  };
  return { vision, state };
}

/** 478 landmarks spread over the middle of the frame. */
const face = Array.from({ length: 478 }, (_, i) => ({
  x: 0.3 + 0.4 * ((i % 22) / 21),
  y: 0.2 + 0.6 * (Math.floor(i / 22) / 21),
  z: 0,
}));

/**
 * A 2D context that records the crop it is asked to draw and returns opaque
 * pixels of the colour the test sets, with a transparent margin standing in
 * for whatever the skin clip excluded.
 */
function fakeCanvas() {
  const state = {
    colour: [100, 150, 200],
    drawn: [] as number[][],
    clipped: 0,
  };
  const canvas: any = { width: 0, height: 0 };
  const context: any = {
    imageSmoothingQuality: "low",
    clearRect: () => {},
    save: () => {},
    restore: () => {},
    beginPath: () => {},
    moveTo: () => {},
    lineTo: () => {},
    closePath: () => {},
    clip: () => {
      state.clipped++;
    },
    drawImage: (_video: unknown, ...args: number[]) => state.drawn.push(args),
    getImageData: (_x: number, _y: number, w: number, h: number) => {
      const data = new Uint8ClampedArray(w * h * 4);
      for (let i = 0; i < w * h; i++) {
        const inside = i % 4 !== 0; // a quarter of the pixels are off-skin
        data.set(inside ? [...state.colour, 255] : [9, 9, 9, 0], i * 4);
      }
      return { data };
    },
  };
  canvas.getContext = () => context;
  return { canvas, context, state };
}

const video = { videoWidth: 640, videoHeight: 480 } as HTMLVideoElement;

let canvas: ReturnType<typeof fakeCanvas>;
beforeEach(() => {
  canvas = fakeCanvas();
  (global as any).document = { createElement: () => canvas.canvas };
});
afterEach(() => {
  delete (global as any).document;
  jest.restoreAllMocks();
});

function collect(receiver: { data: { subscribe(fn: (p: DataPacket) => void): unknown } }) {
  const seen: DataPacket[] = [];
  receiver.data.subscribe((p) => seen.push(p));
  return seen;
}

/* -------------------------------------------------------------------------- */
/* Pure pieces                                                                */
/* -------------------------------------------------------------------------- */

describe("skin regions", () => {
  it("are the forehead and both cheeks, each cheek the other's mirror in size", () => {
    expect(regionPolygons("forehead")).toEqual([RPPG_SKIN_POLYGONS.forehead]);
    expect(regionPolygons("cheeks")).toEqual([
      RPPG_SKIN_POLYGONS.rightCheek,
      RPPG_SKIN_POLYGONS.leftCheek,
    ]);
    expect(regionPolygons("both")).toHaveLength(3);
    expect(RPPG_SKIN_POLYGONS.rightCheek.length).toBe(RPPG_SKIN_POLYGONS.leftCheek.length);
  });

  it("stay inside the 468-point mesh, so the iris points never decide the region", () => {
    for (const polygon of Object.values(RPPG_SKIN_POLYGONS)) {
      for (const index of polygon) expect(index).toBeLessThan(468);
    }
  });

  it("map landmarks to pixel coordinates of the frame", () => {
    const polygons = skinPolygons(face, "forehead", 640, 480)!;
    const first = RPPG_SKIN_POLYGONS.forehead[0];
    expect(polygons[0][0]).toEqual([face[first].x * 640, face[first].y * 480]);
  });

  it("refuse a mesh with missing points", () => {
    expect(skinPolygons(face.slice(0, 100), "both", 640, 480)).toBeNull();
  });
});

describe("meanSkinColor", () => {
  it("averages only fully opaque pixels", () => {
    const rgba = [10, 20, 30, 255, 30, 40, 50, 255, 255, 255, 255, 128, 0, 0, 0, 0];
    expect(meanSkinColor(rgba)).toEqual([20, 30, 40]);
  });

  it("returns null below the pixel floor", () => {
    expect(meanSkinColor([10, 20, 30, 255], 2)).toBeNull();
  });
});

describe("FrameResampler", () => {
  it("passes evenly spaced frames through unchanged", () => {
    const r = new FrameResampler(10, 250);
    const out = [0, 100, 200, 300].map((t) => r.push(t, [t]));
    expect(out.map((o) => o.times)).toEqual([[0], [100], [200], [300]]);
    expect(out.map((o) => o.values)).toEqual([[[0]], [[100]], [[200]], [[300]]]);
  });

  it("interpolates jittered frames onto the grid", () => {
    const r = new FrameResampler(10, 250);
    r.push(0, [0]);
    // Late frame: completes the 100 ms sample, interpolated at 100/130.
    const late = r.push(130, [13]);
    expect(late.times).toEqual([100]);
    expect(late.values[0][0]).toBeCloseTo(10);
    // Early frame: nothing new on the grid yet.
    expect(r.push(190, [19]).times).toEqual([]);
  });

  it("fills a short dropout and completes every grid point in it", () => {
    const r = new FrameResampler(10, 250);
    r.push(0, [0]);
    const out = r.push(230, [23]);
    expect(out.times).toEqual([100, 200]);
    expect(out.values.map((v) => v[0])).toEqual([
      expect.closeTo(10),
      expect.closeTo(20),
    ]);
  });

  it("restarts the grid after a dropout longer than maxGap", () => {
    const r = new FrameResampler(10, 250);
    r.push(0, [0]);
    const out = r.push(1000, [5]);
    expect(out).toEqual({ times: [1000], values: [[5]] });
    expect(r.push(1100, [6]).times).toEqual([1100]);
  });

  it("ignores a frame stamped no later than the last", () => {
    const r = new FrameResampler(10, 250);
    r.push(100, [1]);
    expect(r.push(100, [2]).times).toEqual([]);
    expect(r.push(50, [2]).times).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* Gaps downstream                                                            */
/* -------------------------------------------------------------------------- */

function meta(overrides: Partial<StreamMetadata> = {}): StreamMetadata {
  return {
    streamID: "rppg:video:preprocessed:rppg",
    modality: Modality.VIDEO,
    samplingRate: 10,
    channelCount: 1,
    ...overrides,
  };
}

/** `count` one-channel samples at 10 Hz, the last stamped at `lastMs`. */
function packet(lastMs: number, count = 1, m = meta()): DataPacket {
  return {
    streamID: m.streamID,
    timestamp: lastMs,
    data: Float32Array.from({ length: count }, (_, i) => lastMs - (count - 1 - i) * 100),
    metadata: m,
  };
}

describe("GapDetector", () => {
  const clocked = meta({ additionalMetadata: { sampleClock: true } });

  it("auto: trusts a sample clock, and treats half a period missing as a gap", () => {
    const g = new GapDetector();
    expect(g.next(packet(0, 1, clocked))).toBe(false);
    expect(g.next(packet(300, 3, clocked))).toBe(false); // samples 100, 200, 300
    expect(g.next(packet(440, 1, clocked))).toBe(false); // jitter: 40 ms late
    expect(g.next(packet(600, 1, clocked))).toBe(true); // 500 is missing
  });

  it("auto: never reports a gap on an arrival-stamped stream", () => {
    const g = new GapDetector();
    g.next(packet(0));
    expect(g.next(packet(5000))).toBe(false);
  });

  it("an explicit maxGap applies to any stream", () => {
    const g = new GapDetector(1);
    g.next(packet(0));
    expect(g.next(packet(1000))).toBe(false); // 0.9 s missing
    expect(g.next(packet(2200))).toBe(true); // 1.1 s missing
  });

  it("a clock that goes backwards restarts the comparison, not a gap", () => {
    const g = new GapDetector();
    g.next(packet(10_000, 1, clocked));
    expect(g.next(packet(0, 1, clocked))).toBe(false);
    expect(g.next(packet(100, 1, clocked))).toBe(false);
  });
});

describe("Windowing across a gap", () => {
  const clocked = meta({ additionalMetadata: { sampleClock: true } });

  it("discards the partial window instead of splicing the two sides together", () => {
    const w = new Windowing({ size: 4, unit: "samples" });
    expect(w.analyze(packet(200, 3, clocked))).toBeNull(); // 0, 100, 200
    // Face lost for a second: samples 300-1200 never existed.
    expect(w.analyze(packet(1300, 1, clocked))).toBeNull();
    const window = w.analyze(packet(1600, 3, clocked)) as DataPacket;
    expect(Array.from(window.data)).toEqual([1300, 1400, 1500, 1600]);
  });

  it("joins an arrival-stamped stream as before, unless told otherwise", () => {
    const joined = new Windowing({ size: 4, unit: "samples" });
    joined.analyze(packet(200, 3));
    expect(Array.from((joined.analyze(packet(1300)) as DataPacket).data)).toEqual([0, 100, 200, 1300]);

    const strict = new Windowing({ size: 4, unit: "samples", maxGap: 0.5 });
    strict.analyze(packet(200, 3));
    expect(strict.analyze(packet(1300))).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* PulseExtraction                                                            */
/* -------------------------------------------------------------------------- */

describe("PulseExtraction", () => {
  const fs = 30;
  const rgbMeta: StreamMetadata = {
    streamID: "rppg:video:preprocessed:rppg",
    modality: Modality.VIDEO,
    samplingRate: fs,
    channelCount: 3,
    channelInfo: [
      { index: 0, label: "red" },
      { index: 1, label: "green" },
      { index: 2, label: "blue" },
    ],
    additionalMetadata: { sampleClock: true },
  };

  /** Skin colour with a 1.2 Hz pulse, as one 3-channel packet per frame. */
  function frames(start: number, count: number, m = rgbMeta, order = [0, 1, 2]): DataPacket[] {
    return Array.from({ length: count }, (_, k) => {
      const i = start + k;
      const p = Math.sin((2 * Math.PI * 1.2 * i) / fs);
      const rgb = [180 * (1 - 0.0017 * p), 130 * (1 - 0.004 * p), 105 * (1 - 0.0028 * p)];
      return {
        streamID: m.streamID,
        timestamp: (i * 1000) / fs,
        data: Float32Array.from(order.map((c) => rgb[c])),
        metadata: m,
      };
    });
  }

  function run(node: PulseExtraction, packets: DataPacket[]) {
    return packets.map((p) => node.analyze(p)).filter((p): p is DataPacket => p !== null);
  }

  it("is registered, and emits a one-channel ppg stream named pulse", () => {
    const node = createAnalyzer(AnalysisMethod.PULSE_EXTRACTION) as PulseExtraction;
    const out = run(node, frames(0, 60));
    expect(out[0].streamID).toBe("rppg:ppg:preprocessed:pulse");
    expect(out[0].metadata.modality).toBe(Modality.PPG);
    expect(out[0].metadata.channelCount).toBe(1);
    // The sample clock carries through, so a Windowing node below still sees gaps.
    expect(out[0].metadata.additionalMetadata?.sampleClock).toBe(true);
  });

  it("stays a window behind, and stamps each sample with its own time", () => {
    const out = run(new PulseExtraction(), frames(0, 60));
    // 1.6 s at 30 fps is 48 frames: the first sample is final at frame 47.
    expect(out).toHaveLength(60 - 47);
    expect(out[0].timestamp).toBeCloseTo(0);
    expect(out.at(-1)!.timestamp).toBeCloseTo((12 * 1000) / fs);
  });

  it("puts systole up: the output follows blood volume, not reflected light", () => {
    // Light dips when blood volume peaks (p = 1 here dims every channel).
    const out = run(new PulseExtraction(), frames(0, 120)).flatMap((p) => Array.from(p.data));
    // Correlate with p at the same sample indices.
    const p = out.map((_, i) => Math.sin((2 * Math.PI * 1.2 * i) / fs));
    const r = out.reduce((s, v, i) => s + v * p[i], 0);
    expect(r).toBeGreaterThan(0);
  });

  it("finds the colours by label, whatever their order", () => {
    const bgr: StreamMetadata = {
      ...rgbMeta,
      channelInfo: [
        { index: 0, label: "blue" },
        { index: 1, label: "green" },
        { index: 2, label: "red" },
      ],
    };
    const a = run(new PulseExtraction(), frames(0, 60)).flatMap((p) => Array.from(p.data));
    const b = run(new PulseExtraction(), frames(0, 60, bgr, [2, 1, 0])).flatMap((p) => Array.from(p.data));
    expect(b).toEqual(a);
  });

  it("emits nothing for a stream without three colours, unless green-only", () => {
    const mono: StreamMetadata = { ...rgbMeta, channelCount: 1, channelInfo: [{ index: 0, label: "green" }] };
    const packets = frames(0, 60).map((p) => ({ ...p, data: p.data.slice(1, 2), metadata: mono }));
    expect(run(new PulseExtraction(), packets)).toHaveLength(0);
    expect(run(new PulseExtraction({ algorithm: "green" }), packets).length).toBeGreaterThan(0);
  });

  it("starts over after a gap instead of normalising across it", () => {
    const node = new PulseExtraction();
    const before = run(node, frames(0, 60));
    // Ten seconds without a face, then the stream resumes.
    const after = run(node, frames(360, 60));
    expect(before).toHaveLength(13);
    expect(after).toHaveLength(13);
    expect(after[0].timestamp).toBeCloseTo((360 * 1000) / fs);
  });
});

/* -------------------------------------------------------------------------- */
/* RPPGReceiver                                                               */
/* -------------------------------------------------------------------------- */

describe("RPPGReceiver", () => {
  async function ownModel(options = {}) {
    const mp = fakeMediaPipe();
    const receiver = withVision(new RPPGReceiver(video, options), mp.vision);
    await receiver.connect();
    return { receiver, mp, seen: collect(receiver) };
  }

  it("declares an evenly sampled RGB stream with a sample clock", async () => {
    const { receiver } = await ownModel({ maxFps: 30 });
    const m = receiver.streamMeta.get("rppg:video:preprocessed:rppg")!;
    expect(m.samplingRate).toBe(30);
    expect(m.channelInfo!.map((c) => c.label)).toEqual(["red", "green", "blue"]);
    expect(m.additionalMetadata).toEqual({ region: "both", sampleClock: true });
  });

  it("averages only the skin, cropped from the full-resolution frame", async () => {
    const { receiver, mp, seen } = await ownModel();
    mp.state.faces = [face];
    (receiver as any).processFrame(1000);

    expect(Array.from(seen[0].data)).toEqual([100, 150, 200]);
    expect(canvas.state.clipped).toBe(1);
    // Source rectangle = the bounding box of the region's polygons, in video pixels.
    const vertices = skinPolygons(face, "both", 640, 480)!.flat();
    const xs = vertices.map(([x]) => x);
    const ys = vertices.map(([, y]) => y);
    const [sx, sy, sw, sh] = canvas.state.drawn[0];
    expect(sx).toBe(Math.floor(Math.min(...xs)));
    expect(sy).toBe(Math.floor(Math.min(...ys)));
    expect(sx + sw).toBe(Math.ceil(Math.max(...xs)));
    expect(sy + sh).toBe(Math.ceil(Math.max(...ys)));
  });

  it("stamps packets on the grid, in wall-clock time", async () => {
    const { receiver, mp, seen } = await ownModel({ maxFps: 10 });
    mp.state.faces = [face];
    (receiver as any).processFrame(1000);
    (receiver as any).processFrame(1130); // late: completes the 1100 ms sample
    expect(seen.map((p) => p.timestamp - performance.timeOrigin)).toEqual([
      expect.closeTo(1000),
      expect.closeTo(1100),
    ]);
  });

  it("is silent without a face, and restarts after a long loss", async () => {
    const { receiver, mp, seen } = await ownModel({ maxFps: 10, maxGap: 0.25 });
    mp.state.faces = [face];
    (receiver as any).processFrame(0);
    mp.state.faces = [];
    for (let t = 100; t < 2000; t += 100) (receiver as any).processFrame(t);
    expect(seen).toHaveLength(1);

    mp.state.faces = [face];
    (receiver as any).processFrame(2000);
    expect(seen).toHaveLength(2);
    expect(seen[1].timestamp - performance.timeOrigin).toBeCloseTo(2000);
  });

  it("emits a frame's grid samples as one interleaved packet", async () => {
    const { receiver, mp, seen } = await ownModel({ maxFps: 10 });
    mp.state.faces = [face];
    (receiver as any).processFrame(0);
    (receiver as any).processFrame(220); // bridges 100 and 200
    expect(seen[1].data).toHaveLength(6);
    expect(Array.from(seen[1].data)).toEqual([100, 150, 200, 100, 150, 200]);
  });

  describe("sharing a FaceLandmarkReceiver", () => {
    it("runs one model, and samples on the tracker's frames", async () => {
      const mp = fakeMediaPipe();
      const tracker = withVision(new FaceLandmarkReceiver(video), mp.vision);
      const pulse = new RPPGReceiver(video, { faceSource: tracker });
      jest.spyOn(pulse as any, "loadVisionModule");

      await tracker.connect();
      await pulse.connect();
      pulse.startStream();
      const seen = collect(pulse);

      mp.state.faces = [face];
      (tracker as any).processFrame(1000);

      expect(mp.state.created).toBe(1);
      expect(mp.state.calls).toBe(1);
      expect((pulse as any).loadVisionModule).not.toHaveBeenCalled();
      expect(seen).toHaveLength(1);
      expect(pulse.samplingRate).toBe(tracker.maxFps);
    });

    it("stops listening when stopped", async () => {
      const mp = fakeMediaPipe();
      const tracker = withVision(new FaceLandmarkReceiver(video), mp.vision);
      const pulse = new RPPGReceiver(video, { faceSource: tracker });
      await tracker.connect();
      await pulse.connect();
      pulse.startStream();
      const seen = collect(pulse);

      pulse.stopStream();
      mp.state.faces = [face];
      (tracker as any).processFrame(1000);
      expect(seen).toHaveLength(0);
    });

    it("refuses a tracker on another video element", () => {
      const tracker = new FaceLandmarkReceiver({} as HTMLVideoElement);
      expect(() => new RPPGReceiver(video, { faceSource: tracker })).toThrow(/same video element/);
    });
  });
});

/* -------------------------------------------------------------------------- */
/* Frame cap                                                                  */
/* -------------------------------------------------------------------------- */

describe("vision frame cap", () => {
  /**
   * Runs a receiver's frame loop against a camera at `cameraFps` and a 60 Hz
   * display for `seconds`, and counts the frames it processed. Each camera
   * frame is noticed on the first display refresh after it arrives.
   */
  async function processed(cameraFps: number, maxFps: number, seconds = 3) {
    const mp = fakeMediaPipe();
    const camera = { readyState: 2, currentTime: 0 } as unknown as HTMLVideoElement;
    const receiver = withVision(new FaceLandmarkReceiver(camera, { maxFps }), mp.vision);
    await receiver.connect();

    let now = 0;
    let pending: FrameRequestCallback | undefined;
    jest.spyOn(performance, "now").mockImplementation(() => now);
    (global as any).requestAnimationFrame = (cb: FrameRequestCallback) => {
      pending = cb;
      return 1;
    };
    (global as any).cancelAnimationFrame = () => {
      pending = undefined;
    };

    receiver.startStream();
    // Refreshes at 16.67 ms with a little scheduling jitter.
    for (let k = 1; k <= seconds * 60; k++) {
      now = k * (1000 / 60) + ((k * 7) % 5) * 0.1;
      (camera as any).currentTime = Math.floor(now / (1000 / cameraFps)) / cameraFps;
      const cb = pending;
      pending = undefined;
      cb?.(now);
    }
    receiver.stopStream();
    delete (global as any).requestAnimationFrame;
    delete (global as any).cancelAnimationFrame;
    return mp.state.calls;
  }

  it("keeps every frame of a camera running exactly at the cap", async () => {
    expect(await processed(30, 30)).toBeGreaterThanOrEqual(89);
  });

  it("still halves a camera running at twice the cap", async () => {
    const n = await processed(60, 30);
    expect(n).toBeGreaterThanOrEqual(88);
    expect(n).toBeLessThanOrEqual(91);
  });
});
