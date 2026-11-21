/**
 * Receivers by type name: `createReceiver`, `registerReceiver`.
 */
import {
  MarkerReceiver,
  MuseReceiver,
  Pipeline,
  PoseReceiver,
  createReceiver,
  registerReceiver,
  registeredReceivers,
} from "../../src";

describe("receiver registry", () => {
  it("builds the built-in types, unconnected", () => {
    expect(createReceiver("muse")).toBeInstanceOf(MuseReceiver);
    const pose = createReceiver("pose", { videoElement: { id: "cam" }, maxFps: 15 });
    expect(pose).toBeInstanceOf(PoseReceiver);
    expect((pose as PoseReceiver).maxFps).toBe(15);
    expect(pose.isConnected).toBe(false);
  });

  it("names what it has when asked for a type it does not", () => {
    expect(() => createReceiver("thermometer")).toThrow(/Registered receivers: .*muse/);
  });

  it("takes new types", () => {
    registerReceiver("stopwatch", (o) => new MarkerReceiver(o));
    expect(registeredReceivers()).toContain("stopwatch");
    expect(createReceiver("stopwatch")).toBeInstanceOf(MarkerReceiver);
  });

  it("lets describe() report a graph's channels before any device connects", () => {
    const pipeline = new Pipeline({ nodes: [{ id: "body", receiver: "camera" }], edges: [] });
    pipeline.attachReceiver("camera", createReceiver("pose", { videoElement: {} }));
    const [body] = pipeline.describe();
    expect(body.channels).toHaveLength(99);
    expect(body.channels[0].label).toBe("nose x");
  });
});
