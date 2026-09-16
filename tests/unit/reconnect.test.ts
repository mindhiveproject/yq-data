/**
 * Receivers across a disconnect and reconnect.
 *
 * Hardware and MediaPipe are faked: these tests exercise stream registration,
 * where reconnecting used to throw "Stream with ID … already exists", and
 * that packets keep reaching a subscriber from before the disconnect.
 */
import { Subject } from "rxjs";
import {
  BLENDSHAPE_NAMES,
  DataPacket,
  FaceLandmarkReceiver,
  MuseReceiver,
  PoseReceiver,
} from "../../src";

const video = {} as HTMLVideoElement;

function fakeVision(detect: () => unknown) {
  const task = { detectForVideo: detect, close: () => {} };
  return {
    FilesetResolver: { forVisionTasks: async () => ({}) },
    FaceLandmarker: { createFromOptions: async () => task },
    PoseLandmarker: { createFromOptions: async () => task },
  };
}

function withVision<T extends { connect(): Promise<void> }>(
  receiver: T,
  vision: unknown
): T {
  jest
    .spyOn(receiver as any, "loadVisionModule")
    .mockResolvedValue(vision as never);
  return receiver;
}

describe("vision receivers reconnect", () => {
  it("re-registers pose streams without throwing", async () => {
    const pose = withVision(new PoseReceiver(video), fakeVision(() => ({})));

    await pose.connect();
    await pose.disconnect();
    await expect(pose.connect()).resolves.toBeUndefined();

    expect(pose.streams).toEqual(["pose:video:inferred:landmarks"]);
  });

  const frame = {
    faceBlendshapes: [
      {
        categories: BLENDSHAPE_NAMES.map((categoryName, index) => ({
          index,
          categoryName,
          score: index / 100,
        })),
      },
    ],
  };

  it("declares the 52 blendshape channels on connect, before any frame", async () => {
    const face = withVision(
      new FaceLandmarkReceiver(video, { emitHeadPose: false }),
      fakeVision(() => frame)
    );

    await face.connect();

    const id = "face-landmarker:video:inferred:blendshapes";
    expect(face.streams).toEqual([id]);
    const labels = face.streamMeta.get(id)!.channelInfo!.map((c) => c.label);
    expect(labels).toHaveLength(52);
    expect(labels.slice(0, 2)).toEqual(["_neutral", "browDownLeft"]);
  });

  it("keeps delivering blendshapes to an existing subscriber", async () => {
    const face = withVision(
      new FaceLandmarkReceiver(video, { emitHeadPose: false }),
      fakeVision(() => frame)
    );

    const seen: DataPacket[] = [];
    face.data.subscribe((packet) => seen.push(packet));
    const error = jest.spyOn(console, "error").mockImplementation(() => {});

    await face.connect();
    (face as any).processFrame(1);
    await face.disconnect();
    await face.connect();
    (face as any).processFrame(2);

    expect(error).not.toHaveBeenCalled();
    expect(seen).toHaveLength(2);
    expect(seen[1].streamID).toBe("face-landmarker:video:inferred:blendshapes");
    error.mockRestore();
  });
});

describe("Muse reconnect", () => {
  /** Mimics muse-js: readings complete on disconnect and are rebuilt on connect. */
  function fakeMuse(receiver: MuseReceiver) {
    let eeg = new Subject<any>();
    const status = (receiver as any).isConnected$ as Subject<boolean>;

    receiver.muse = {
      enablePpg: false,
      deviceName: "Muse-1A2B",
      get eegReadings() {
        return eeg;
      },
      connect: async () => status.next(true),
      deviceInfo: async () => ({}),
      start: async () => {},
      pause: async () => {},
      disconnect: () => {
        eeg.complete();
        eeg = new Subject();
        status.next(false);
      },
    } as any;

    return (value: number) => {
      for (let electrode = 0; electrode < 4; electrode++) {
        eeg.next({ electrode, index: 0, timestamp: 0, samples: [value] });
      }
    };
  }

  it("reconnects the same headset and keeps streaming", async () => {
    const muse = new MuseReceiver(false);
    const send = fakeMuse(muse);

    const seen: DataPacket[] = [];
    muse.data.subscribe((packet) => seen.push(packet));

    await muse.connect();
    await muse.startStream();
    send(1);

    await muse.disconnect();
    await expect(muse.connect()).resolves.toBeUndefined();
    await muse.startStream();
    send(2);

    expect(muse.streams).toEqual(["Muse-1A2B:eeg:raw"]);
    expect(seen.map((p) => p.data[0])).toEqual([1, 2]);
  });

  it("recovers when the headset drops on its own", async () => {
    const muse = new MuseReceiver(false);
    const send = fakeMuse(muse);

    const seen: DataPacket[] = [];
    muse.data.subscribe((packet) => seen.push(packet));

    await muse.connect();
    await muse.startStream();
    send(1);

    // Out of range or powered off: muse-js completes its readings without the
    // receiver's own disconnect() having run first.
    (muse.muse as any).disconnect();
    await muse.connect();
    await muse.startStream();
    send(2);

    expect(seen.map((p) => p.data[0])).toEqual([1, 2]);
  });
});
