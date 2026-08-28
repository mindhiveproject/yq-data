/**
 * Round-trips through StreamTransmitter -> Transport -> RemoteStreamReceiver.
 *
 * MemoryTransport delivers synchronously, so a packet pushed into a source is
 * observable on the far receiver in the same tick — no fake timers needed.
 */
import { Subject } from "rxjs";
import {
  AnalysisMethod,
  DataPacket,
  LSLReceiver,
  MarkerReceiver,
  MemoryTransport,
  Modality,
  Pipeline,
  RemoteStreamReceiver,
  StreamMetadata,
  StreamTransmitter,
  canConnect,
  compatibleMethods,
  getChannelCount,
  registeredMethods,
} from "../../src";
import { BaseTransport } from "../../src";

const EEG_META: StreamMetadata = {
  streamID: "muse-1:eeg:raw",
  modality: Modality.EEG,
  samplingRate: 256,
  channelCount: 2,
  channelInfo: [
    { index: 0, label: "AF7" },
    { index: 1, label: "AF8" },
  ],
};

function eegPacket(overrides: Partial<DataPacket> = {}): DataPacket {
  return {
    streamID: "muse-1:eeg:raw",
    timestamp: 1000,
    data: new Float32Array([1, 2, 3, 4]),
    metadata: EEG_META,
    ...overrides,
  };
}

/** A transmitter and receiver joined by a fresh memory link. */
async function wired(
  txOptions?: ConstructorParameters<typeof StreamTransmitter>[1],
  rxOptions?: ConstructorParameters<typeof RemoteStreamReceiver>[1]
) {
  const [a, b] = MemoryTransport.pair();
  const tx = new StreamTransmitter(a, txOptions);
  const rx = new RemoteStreamReceiver(b, {
    closeTransportOnDisconnect: false,
    ...rxOptions,
  });
  await rx.connect();
  rx.startStream();
  const seen: DataPacket[] = [];
  rx.data.subscribe((p) => seen.push(p));
  return { a, b, tx, rx, seen };
}

describe("numeric streams", () => {
  it("round-trips a packet with its metadata intact", async () => {
    const { tx, seen } = await wired();
    const source = new Subject<DataPacket>();
    tx.addSource(source);
    tx.start();

    source.next(eegPacket());

    expect(seen).toHaveLength(1);
    expect(seen[0].streamID).toBe("muse-1:eeg:raw");
    expect(Array.from(seen[0].data)).toEqual([1, 2, 3, 4]);
    expect(seen[0].metadata.samplingRate).toBe(256);
    expect(seen[0].metadata.modality).toBe(Modality.EEG);
    expect(getChannelCount(seen[0])).toBe(2);
  });

  it("announces layout so a graph can be validated before data flows", async () => {
    const { tx, rx, seen } = await wired();
    const source = new Subject<DataPacket>();
    tx.addSource(source);
    tx.start();

    source.next(eegPacket());

    const meta = rx.getStreamMeta(rx.streams[0])!;
    expect(meta.channelInfo?.map((c) => c.label)).toEqual(["AF7", "AF8"]);
    expect(canConnect(meta, AnalysisMethod.FILTERING)).toBe(true);
    expect(seen[0].metadata.channelInfo).toHaveLength(2);
  });

  it("reconstructs a stream from packets alone when no meta was sent", async () => {
    const { a, rx } = await wired();
    const seen: DataPacket[] = [];
    rx.data.subscribe((p) => seen.push(p));

    // A bare packet message, as a terse third-party producer might send.
    a.send({
      protocol: "yq-data/1",
      type: "packet",
      streamID: "sensor-9:eeg:raw",
      timestamp: 1,
      channelCount: 2,
      data: [10, 20, 30, 40],
    });

    expect(seen).toHaveLength(1);
    expect(seen[0].streamID).toBe("sensor-9:eeg:raw");
    expect(seen[0].metadata.modality).toBe(Modality.EEG);
    expect(getChannelCount(seen[0])).toBe(2);
  });

  it("keeps a websocket-style remote clock out of local time", async () => {
    const { tx, seen } = await wired(undefined, { trustRemoteClock: false });
    const source = new Subject<DataPacket>();
    tx.addSource(source);
    tx.start();

    source.next(eegPacket({ timestamp: 1000 }));

    expect(seen[0].timestamp).not.toBe(1000);
    expect(seen[0].deviceTime).toBe(1000);
  });

  it("preserves the sender's timestamp on a same-machine transport", async () => {
    const { tx, seen } = await wired();
    const source = new Subject<DataPacket>();
    tx.addSource(source);
    tx.start();

    source.next(eegPacket({ timestamp: 4242 }));

    expect(seen[0].timestamp).toBe(4242);
  });
});

describe("marker streams", () => {
  it("carries markers as categorical, rate-free, with their labels", async () => {
    const { tx, rx, seen } = await wired();
    tx.start();

    const markers = new MarkerReceiver();
    markers.connect();
    markers.startStream();
    tx.addReceiver(markers);

    markers.mark("go", { timestamp: 5 });
    markers.mark("stop", { timestamp: 6 });

    expect(seen.map((p) => p.labels?.[0])).toEqual(["go", "stop"]);
    expect(seen.map((p) => p.data[0])).toEqual([1, 2]);

    const meta = rx.getStreamMeta(rx.streams[0])!;
    expect(meta.valueType).toBe("categorical");
    expect(meta.samplingRate).toBeUndefined();
    expect(compatibleMethods(meta, registeredMethods())).toEqual([
      AnalysisMethod.STREAM_SELECTION,
    ]);
  });
});

describe("pipeline outputs", () => {
  it("transmits a node's output the same way Recorder records one", async () => {
    const { tx, seen } = await wired();

    const lsl = new LSLReceiver();
    (lsl as any).isConnected = true;
    lsl.startStream();
    (lsl as any).handleMessage({
      data: JSON.stringify({
        eeg: {
          info: {
            name: "BioSemi",
            type: "EEG",
            channel_count: 2,
            channel_format: 1,
            nominal_srate: 256,
            source_id: "biosemi-1",
          },
        },
      }),
    });

    const pipeline = new Pipeline({
      nodes: [
        { id: "dev", receiver: "lsl" },
        {
          id: "sel",
          method: AnalysisMethod.STREAM_SELECTION,
          parameters: { modalities: [Modality.EEG] },
        },
      ],
      edges: [{ from: ["dev"], to: ["sel"] }],
    });
    pipeline.attachReceiver("lsl", lsl);
    pipeline.start();

    tx.addSource(pipeline.getOutput("sel"));
    tx.start();

    (lsl as any).handleMessage({
      data: JSON.stringify({ eeg: { timeseries: [1, 2, 3, 4], timestamp: 5 } }),
    });

    expect(seen).toHaveLength(1);
    expect(seen[0].streamID).toBe("biosemi-1:eeg:raw:BioSemi");
    expect(Array.from(seen[0].data)).toEqual([1, 2, 3, 4]);
  });
});

describe("transmitter bookkeeping", () => {
  it("counts packets and samples per stream", async () => {
    const { tx } = await wired();
    const source = new Subject<DataPacket>();
    tx.addSource(source);
    tx.start();

    source.next(eegPacket()); // 2 samples per channel
    source.next(eegPacket());

    expect(tx.summary).toEqual([
      { streamID: "muse-1:eeg:raw", packets: 2, samples: 4 },
    ]);
  });

  it("stops sending after stop()", async () => {
    const { tx, seen } = await wired();
    const source = new Subject<DataPacket>();
    tx.addSource(source);
    tx.start();
    source.next(eegPacket());
    tx.stop();
    source.next(eegPacket());

    expect(seen).toHaveLength(1);
    expect(tx.isTransmitting).toBe(false);
  });
});

/** A transport whose open state the test drives, for the reconnect path. */
class ManualTransport extends BaseTransport {
  readonly kind = "memory" as const;
  readonly structuredClone = true;
  sent: unknown[] = [];
  constructor() {
    super();
    this.setOpen(true);
  }
  send(value: unknown): void {
    if (this.isOpen) this.sent.push(value);
  }
  drop(): void {
    this.setOpen(false);
  }
  restore(): void {
    this.setOpen(true);
  }
}

describe("re-announcing on reconnect", () => {
  it("re-sends metadata after the transport comes back", async () => {
    const transport = new ManualTransport();
    const tx = new StreamTransmitter(transport, { reannounceInterval: 0 });
    const source = new Subject<DataPacket>();
    tx.addSource(source);
    tx.start();

    source.next(eegPacket());
    // meta + packet
    expect(transport.sent.filter((m: any) => m.type === "meta")).toHaveLength(1);

    transport.drop();
    source.next(eegPacket()); // dropped while closed
    transport.restore();

    source.next(eegPacket());
    expect(transport.sent.filter((m: any) => m.type === "meta")).toHaveLength(2);
  });
});
