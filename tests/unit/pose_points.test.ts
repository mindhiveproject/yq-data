import {
  FACE_API_68,
  MEDIAPIPE_POSE_33,
  POSE_LANDMARK_NAMES,
  PoseReceiver,
  flattenPoints,
  pointBounds,
  pointChannelGroups,
  pointStride,
  subjectStreamName,
  pointStreamMetadata,
} from "../../src";

function fakeVision(detect: () => unknown) {
  const task = { detectForVideo: detect, close: () => {} };
  return {
    FilesetResolver: { forVisionTasks: async () => ({}) },
    PoseLandmarker: { createFromOptions: async () => task },
  };
}

async function poseMetadata(options = {}) {
  const pose = new PoseReceiver({} as HTMLVideoElement, options);
  jest
    .spyOn(pose as any, "loadVisionModule")
    .mockResolvedValue(fakeVision(() => ({})) as never);
  await pose.connect();
  return pose.streamMeta.get(pose.streams[0]);
}

describe("pose point stream", () => {
  it("declares its stride and topology instead of per-value labels", async () => {
    const meta = await poseMetadata();

    expect(meta?.channelCount).toBe(99);
    expect(meta?.channelInfo).toBeUndefined();
    expect(meta?.additionalMetadata).toEqual({
      pointComponents: ["x", "y", "z"],
      topology: MEDIAPIPE_POSE_33,
      coordinateSpace: "image",
    });
  });

  it("names its topology like the face streams do", () => {
    expect(MEDIAPIPE_POSE_33).toMatch(/^[a-z]+(-[a-z0-9]+)+$/);
  });

  it("follows includeVisibility and worldCoordinates", async () => {
    const meta = await poseMetadata({
      includeVisibility: true,
      worldCoordinates: true,
    });

    expect(meta?.channelCount).toBe(132);
    expect(meta?.additionalMetadata?.pointComponents).toEqual([
      "x",
      "y",
      "z",
      "visibility",
    ]);
    expect(meta?.additionalMetadata?.coordinateSpace).toBe("world");
  });
});

describe("pointChannelGroups", () => {
  it("names each pose landmark and indexes its components", () => {
    const groups = pointChannelGroups(
      pointStreamMetadata(33, ["x", "y", "z"], MEDIAPIPE_POSE_33) as any
    );

    expect(groups).toHaveLength(33);
    expect(groups[0]).toEqual({ label: "nose", indices: [0, 1, 2] });
    const wrist = POSE_LANDMARK_NAMES.indexOf("left wrist");
    expect(groups[wrist]).toEqual({
      label: "left wrist",
      indices: [wrist * 3, wrist * 3 + 1, wrist * 3 + 2],
    });
  });

  it("uses the declared stride", () => {
    const groups = pointChannelGroups(
      pointStreamMetadata(33, ["x", "y", "z", "visibility"], MEDIAPIPE_POSE_33) as any
    );

    expect(groups[1].indices).toEqual([4, 5, 6, 7]);
  });

  it("numbers points of a topology without names", () => {
    const groups = pointChannelGroups(
      pointStreamMetadata(2, ["x", "y"], FACE_API_68) as any
    );

    expect(groups).toEqual([
      { label: "point 0", indices: [0, 1] },
      { label: "point 1", indices: [2, 3] },
    ]);
  });

  it("returns nothing for a stream that is not a point stream", () => {
    expect(pointChannelGroups({ channelCount: 4 })).toEqual([]);
  });
});

describe("point helpers", () => {
  it("flattens points in component order, zero-filling what is missing", () => {
    const flat = flattenPoints([{ x: 1, y: 2, z: 3 }, { x: 4, y: 5 }], ["x", "y", "z", "visibility"]);
    expect(Array.from(flat)).toEqual([1, 2, 3, 0, 4, 5, 0, 0]);
  });

  it("normalizes pixel points by the frame they were read from", () => {
    const flat = flattenPoints([{ x: 320, y: 120 }], ["x", "y"], { width: 640, height: 480 });
    expect(Array.from(flat)).toEqual([0.5, 0.25]);
  });

  it("reads the stride from the metadata, or from legacy channel labels", () => {
    expect(pointStride(pointStreamMetadata(3, ["x", "y"], FACE_API_68) as any)).toBe(2);
    const legacy = {
      channelInfo: ["a x", "a y", "a z", "a v", "b x"].map((label, index) => ({ index, label })),
    };
    expect(pointStride(legacy)).toBe(4);
    expect(pointStride({})).toBe(3);
  });

  it("bounds the x and y of every point whatever the stride", () => {
    const data = [0.2, 0.3, 9, 0.6, 0.1, 9, 0.4, 0.9, 9];
    const box = pointBounds(data, 3)!;
    expect(box.x).toBeCloseTo(0.2);
    expect(box.y).toBeCloseTo(0.1);
    expect(box.width).toBeCloseTo(0.4);
    expect(box.height).toBeCloseTo(0.8);
    expect(pointBounds([], 3)).toBeUndefined();
  });

  it("numbers multiple tracked subjects the same way for faces and bodies", () => {
    expect(subjectStreamName("landmarks", "face", 0, 1)).toBe("landmarks");
    expect(subjectStreamName("landmarks", "face", 1, 2)).toBe("landmarks_face_2");
    expect(subjectStreamName("landmarks", "pose", 1, 2)).toBe("landmarks_pose_2");
  });
});
