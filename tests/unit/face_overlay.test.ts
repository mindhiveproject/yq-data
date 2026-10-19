/**
 * Face geometry streams and the overlay that draws them.
 *
 * MediaPipe, face-api and the canvas are faked: these tests pin the stream
 * layouts the overlay depends on, the mapping from normalized frame
 * coordinates to canvas pixels, and when a face that went quiet stops being
 * drawn.
 */
import {
  BLENDSHAPE_NAMES,
  DataPacket,
  FaceEmotionReceiver,
  FaceLandmarkReceiver,
  FaceOverlay,
  faceStreamKey,
  frameTransform,
  headPoseAxes,
  FACE_API_68,
  FACE_API_68_OUTLINE,
  MEDIAPIPE_FACE_478,
  MEDIAPIPE_FACE_CONTOURS,
  MEDIAPIPE_FACE_MESH,
  metaToWire,
  topologyEdges,
} from "../../src";

const video = {} as HTMLVideoElement;

function withVision<T>(receiver: T, vision: unknown): T {
  jest
    .spyOn(receiver as any, "loadVisionModule")
    .mockResolvedValue(vision as never);
  return receiver;
}

function fakeMediaPipe(frame: unknown) {
  const task = { detectForVideo: () => frame, close: () => {} };
  return {
    FilesetResolver: { forVisionTasks: async () => ({}) },
    FaceLandmarker: { createFromOptions: async () => task },
  };
}

const blendshapes = [
  { categories: BLENDSHAPE_NAMES.map((_, index) => ({ index, score: 0 })) },
];

/** Column-major 4×4 of a 3×3 rotation, as MediaPipe lays it out. */
function columnMajor(r: number[][]): number[] {
  const m = new Array(16).fill(0);
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) m[col * 4 + row] = r[row][col];
  }
  m[15] = 1;
  return m;
}

function rotation(yaw: number, pitch: number, roll: number): number[][] {
  const [cy, sy, cp, sp, cr, sr] = [yaw, pitch, roll].flatMap((a) => [
    Math.cos(a),
    Math.sin(a),
  ]);
  const ry = [[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]];
  const rx = [[1, 0, 0], [0, cp, -sp], [0, sp, cp]];
  const rz = [[cr, -sr, 0], [sr, cr, 0], [0, 0, 1]];
  const mul = (a: number[][], b: number[][]) =>
    a.map((row) => [0, 1, 2].map((c) => row[0] * b[0][c] + row[1] * b[1][c] + row[2] * b[2][c]));
  return mul(mul(ry, rx), rz);
}

describe("FaceLandmarkReceiver geometry", () => {
  const points = Array.from({ length: 478 }, (_, i) => ({
    x: 0.3 + (i % 10) * 0.02,
    y: 0.2 + (i % 7) * 0.05,
    z: 0,
  }));

  it("emits a face_box around the landmarks", async () => {
    const face = withVision(
      new FaceLandmarkReceiver(video, { emitHeadPose: false, emitFaceBox: true }),
      fakeMediaPipe({ faceBlendshapes: blendshapes, faceLandmarks: [points] })
    );
    const seen: DataPacket[] = [];
    face.data.subscribe((packet) => seen.push(packet));

    await face.connect();
    (face as any).processFrame(1);

    const box = seen.find((p) => p.streamID.endsWith(":face_box"))!;
    expect(Array.from(box.data)).toEqual([
      expect.closeTo(0.3),
      expect.closeTo(0.2),
      expect.closeTo(0.18),
      expect.closeTo(0.3),
    ]);
    expect(box.metadata.channelInfo!.map((c) => c.label)).toEqual([
      "x",
      "y",
      "width",
      "height",
    ]);
  });

  it("declares landmarks as 1434 channels with a compact point layout", async () => {
    const face = withVision(
      new FaceLandmarkReceiver(video, { emitHeadPose: false, emitLandmarks: true }),
      fakeMediaPipe({ faceBlendshapes: blendshapes, faceLandmarks: [points] })
    );
    await face.connect();

    const meta = face.streamMeta.get("face-landmarker:video:inferred:landmarks")!;
    expect(meta.channelCount).toBe(1434);
    expect(meta.channelInfo).toBeUndefined();
    expect(meta.additionalMetadata).toEqual({
      pointComponents: ["x", "y", "z"],
      topology: MEDIAPIPE_FACE_478,
    });
    // What every network consumer is re-sent each few seconds.
    expect(JSON.stringify(meta).length).toBeLessThan(1000);
  });

  it("head_pose round-trips into the overlay's axes", async () => {
    const r = rotation(0.4, -0.25, 0.15);
    const face = withVision(
      new FaceLandmarkReceiver(video),
      fakeMediaPipe({
        faceBlendshapes: blendshapes,
        facialTransformationMatrixes: [{ data: columnMajor(r) }],
      })
    );
    const seen: DataPacket[] = [];
    face.data.subscribe((packet) => seen.push(packet));

    await face.connect();
    (face as any).processFrame(1);

    const pose = seen.find((p) => p.streamID.endsWith(":head_pose"))!;
    const axes = headPoseAxes(pose.data[0], pose.data[1], pose.data[2]);

    // Each axis is a column of the original matrix, with y flipped for canvas.
    axes.forEach(([dx, dy], axis) => {
      expect(dx).toBeCloseTo(r[0][axis], 5);
      expect(dy).toBeCloseTo(-r[1][axis], 5);
    });
  });
});

describe("FaceEmotionReceiver geometry", () => {
  function fakeFaceApi(results: unknown[]) {
    const net = { loadFromUri: async () => {} };
    const chain: any = {
      withFaceLandmarks: () => chain,
      withFaceExpressions: () => chain,
      withAgeAndGender: () => chain,
      then: (resolve: (value: unknown) => void) => resolve(results),
    };
    return {
      nets: {
        tinyFaceDetector: net,
        faceLandmark68Net: net,
        faceExpressionNet: net,
        ageGenderNet: net,
      },
      TinyFaceDetectorOptions: class {},
      detectAllFaces: () => chain,
    };
  }

  const result = {
    expressions: { neutral: 0.1, happy: 0.9 },
    detection: {
      box: { x: 160, y: 120, width: 320, height: 240 },
      imageWidth: 640,
      imageHeight: 480,
      score: 0.8,
    },
    landmarks: {
      positions: Array.from({ length: 68 }, () => ({ x: 320, y: 240 })),
    },
  };

  it("normalizes the box and landmarks to the frame", async () => {
    const emotion = withVision(
      new FaceEmotionReceiver(video, { emitFaceBox: true, emitLandmarks: true }),
      fakeFaceApi([result])
    );
    const seen: DataPacket[] = [];
    emotion.data.subscribe((packet) => seen.push(packet));

    await emotion.connect();
    (emotion as any).processFrame();
    await new Promise((resolve) => setImmediate(resolve));

    const box = seen.find((p) => p.streamID.endsWith(":face_box"))!;
    expect(Array.from(box.data)).toEqual([
      0.25,
      0.25,
      0.5,
      0.5,
      expect.closeTo(0.8),
    ]);
    expect(box.metadata.channelInfo!.map((c) => c.label)).toEqual([
      "x",
      "y",
      "width",
      "height",
      "score",
    ]);

    const landmarks = seen.find((p) => p.streamID.endsWith(":landmarks"))!;
    expect(landmarks.data).toHaveLength(136);
    expect(landmarks.metadata.additionalMetadata?.topology).toBe(FACE_API_68);
    expect(Array.from(landmarks.data.slice(0, 2))).toEqual([0.5, 0.5]);
  });
});

describe("frameTransform", () => {
  const frame = { width: 640, height: 480 };

  it("letterboxes a 4:3 frame into a wide view under contain", () => {
    expect(frameTransform(frame, { width: 800, height: 400 }, "contain")).toEqual({
      scaleX: expect.closeTo(533.333),
      scaleY: 400,
      offsetX: expect.closeTo(133.333),
      offsetY: 0,
    });
  });

  it("crops top and bottom under cover", () => {
    expect(frameTransform(frame, { width: 800, height: 400 }, "cover")).toEqual({
      scaleX: 800,
      scaleY: 600,
      offsetX: 0,
      offsetY: -100,
    });
  });

  it("stretches under fill, and when the frame size is unknown", () => {
    const view = { width: 800, height: 400 };
    const stretched = { scaleX: 800, scaleY: 400, offsetX: 0, offsetY: 0 };
    expect(frameTransform(frame, view, "fill")).toEqual(stretched);
    expect(frameTransform(undefined, view, "cover")).toEqual(stretched);
  });
});

describe("face topology", () => {
  it("indexes only points the models produce", () => {
    expect(Math.max(...MEDIAPIPE_FACE_CONTOURS, ...MEDIAPIPE_FACE_MESH)).toBe(477);
    expect(Math.max(...FACE_API_68_OUTLINE)).toBe(67);
    expect(MEDIAPIPE_FACE_MESH).toHaveLength(2556 * 2);
  });

  it("is looked up by the name the stream carries", () => {
    expect(topologyEdges(MEDIAPIPE_FACE_478)).toBe(MEDIAPIPE_FACE_CONTOURS);
    expect(topologyEdges(MEDIAPIPE_FACE_478, "mesh")).toBe(MEDIAPIPE_FACE_MESH);
    expect(topologyEdges(FACE_API_68, "mesh")).toBe(FACE_API_68_OUTLINE);
    expect(topologyEdges("something-else")).toBeUndefined();
  });
});

describe("faceStreamKey", () => {
  it("groups a receiver's streams by face", () => {
    expect(faceStreamKey("face-emotion:video:inferred:face_box_face_2")).toEqual({
      face: "face-emotion:video:inferred#2",
      layer: "face_box",
    });
    expect(faceStreamKey("face-landmarker:video:inferred:head_pose")).toEqual({
      face: "face-landmarker:video:inferred#1",
      layer: "head_pose",
    });
  });

  it("ignores streams it does not draw", () => {
    expect(faceStreamKey("face-landmarker:video:inferred:blendshapes")).toBeUndefined();
    expect(faceStreamKey("muse:eeg:raw")).toBeUndefined();
  });
});

describe("FaceOverlay", () => {
  function fakeCanvas() {
    const calls: [string, ...number[]][] = [];
    const ctx = new Proxy({} as any, {
      get: (target, prop: string) =>
        prop in target
          ? target[prop]
          : (...args: number[]) => calls.push([prop, ...args]),
      set: (target, prop: string, value) => {
        target[prop] = value;
        return true;
      },
    });
    const canvas = {
      width: 640,
      height: 480,
      clientWidth: 640,
      clientHeight: 480,
      getContext: () => ctx,
    } as unknown as HTMLCanvasElement;
    return { canvas, calls };
  }

  function packet(streamID: string, data: number[]): DataPacket {
    return {
      streamID,
      timestamp: 0,
      data: Float32Array.from(data),
      metadata: { streamID, modality: "video" as any },
    };
  }

  let now = 0;
  beforeEach(() => {
    now = 1000;
    jest.spyOn(performance, "now").mockImplementation(() => now);
  });
  afterEach(() => jest.restoreAllMocks());

  it("draws a box in canvas pixels, mirrored when asked", () => {
    const { canvas, calls } = fakeCanvas();
    const overlay = new FaceOverlay(canvas, { mirror: true });

    overlay.push(packet("face-emotion:video:inferred:face_box", [0.1, 0.25, 0.25, 0.5]));
    overlay.draw();

    const rect = calls.find(([name]) => name === "strokeRect")!;
    expect(rect.slice(1)).toEqual([
      expect.closeTo(416, 3),
      expect.closeTo(120, 3),
      expect.closeTo(160, 3),
      expect.closeTo(240, 3),
    ]);
  });

  it("joins landmarks named by a topology that crossed the wire", () => {
    const { canvas, calls } = fakeCanvas();
    const overlay = new FaceOverlay(canvas, { layers: { landmarks: false } });
    const streamID = "face-emotion:video:inferred:landmarks";
    const sent = metaToWire({
      streamID,
      modality: "video" as any,
      channelCount: 136,
      additionalMetadata: { pointComponents: ["x", "y"], topology: FACE_API_68 },
    });
    const received = JSON.parse(JSON.stringify(sent)).metadata;

    overlay.push({
      streamID,
      timestamp: 0,
      data: new Float32Array(136).fill(0.5),
      metadata: received,
    });
    overlay.draw();

    const moves = calls.filter(([name]) => name === "moveTo").length;
    expect(moves).toBe(FACE_API_68_OUTLINE.length / 2);
    expect(calls.filter(([name]) => name === "stroke")).toHaveLength(1);
  });

  it("stops drawing a face once its stream goes quiet", () => {
    const { canvas, calls } = fakeCanvas();
    const overlay = new FaceOverlay(canvas);
    const id = "face-emotion:video:inferred:face_box";

    // Ten packets at 15 fps teach the overlay this stream's cadence.
    for (let i = 0; i < 10; i++) {
      overlay.push(packet(id, [0, 0, 0.5, 0.5]));
      now += 66;
    }

    overlay.draw();
    expect(calls.filter(([name]) => name === "strokeRect")).toHaveLength(1);

    now += 4 * 66 + 1;
    overlay.draw();
    expect(calls.filter(([name]) => name === "strokeRect")).toHaveLength(1);
  });
});
