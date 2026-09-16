import {
  DataPacket,
  Modality,
  StreamIdentifierLiteral,
  StreamMetadata,
  AnalysisMethod,
} from "../data_stream.interface";
import { BaseReceiver } from "../receiver/base_receiver";
import {
  RemoteStreamReceiver,
  RemoteStreamOptions,
} from "../receiver/devices/remote";
import {
  StreamTransmitter,
  StreamTransmitterOptions,
} from "../transmit/stream_transmitter";
import type { RecorderOptions } from "../recorder/recorder";
import { Transport } from "../transport/transport";
import {
  AnyAnalyzer,
  MultiInputAnalyzer,
  isMultiInput,
  isRouter,
} from "../analyzer/base_analyzer";
import { createAnalyzer } from "../analyzer/registry";
import { acceptsFor, checkAccepts } from "../analyzer/compatibility";
import { matchesStreamFilter, streamFilterFor } from "../utility";
import { Observable, Subject, Subscription, merge } from "rxjs";
import { filter } from "rxjs/operators";

/** Default port name for the single-input, single-output case. */
export const DEFAULT_PORT = "in";

/** Floor for a derived staleness limit, so slow streams are never cut off. */
const AUTO_STALE_FLOOR_MS = 1000;

/** How many of its own packet intervals a port may miss before it reads as stale. */
const AUTO_STALE_INTERVALS = 4;

/** Weight of the newest gap in a port's cadence estimate. */
const INTERVAL_SMOOTHING = 0.2;

/**
 * Ships a node's input out over a transport instead of exposing an output.
 *
 * A node carrying this is a *sink*: it consumes packets and its whole point is
 * the side effect — bytes on a {@link Transport}. The transport is a live
 * object with a socket and a lifecycle, so like a receiver it cannot live in
 * the JSON; the node names it by key and {@link Pipeline.attachTransport}
 * binds the object at runtime.
 */
export interface PipelineTransmit {
  /** Key of the transport to send on, bound with `attachTransport()`. */
  transport: string;
  /** Options forwarded to the underlying `StreamTransmitter`. */
  options?: StreamTransmitterOptions;
}

/**
 * Feeds a source node from streams arriving over a transport.
 *
 * The inbound mirror of {@link PipelineTransmit}: the node is a *source*, and
 * the pipeline owns a `RemoteStreamReceiver` over the named transport so that
 * `stream`, validation and `resetOnDisconnect` all behave exactly as they do
 * for a receiver attached by hand.
 */
export interface PipelineReceive {
  /** Key of the transport to receive on, bound with `attachTransport()`. */
  transport: string;
  /** Options forwarded to the underlying `RemoteStreamReceiver`. */
  options?: RemoteStreamOptions;
}

/**
 * A node in a pipeline graph.
 *
 * A node is a *source* when it names a `receiver` or a `receive` transport, a
 * *sink* when it names a `transmit` transport, and an *analyzer* when it names
 * a `method`. Every form is plain JSON so a whole processing graph — including
 * "and this branch goes out over a WebSocket" — can be stored in a database
 * column and rehydrated without any code.
 */
export interface PipelineNode {
  /** Unique within the graph. Used to address the node's output. */
  id: string;
  /** Analysis method for analyzer nodes; resolved through the registry. */
  method?: AnalysisMethod | string;
  /** Constructor parameters for the analyzer. */
  parameters?: Record<string, any>;
  /** Key of the receiver feeding this node, for source nodes. */
  receiver?: string;
  /** Transport this source node receives from. An alternative to `receiver`. */
  receive?: PipelineReceive;
  /** Transport this sink node transmits to. Makes the node a sink. */
  transmit?: PipelineTransmit;
  /** Which of that source's streams to read. Defaults to all of them. */
  stream?: StreamIdentifierLiteral | Modality;
  /** Human-readable label, carried through to `describe()`. */
  label?: string;
}

/** Connects one node's output to a port on another node's input. */
export interface PipelineEdge {
  /** `[nodeId]` or `[nodeId, outputPort]`. Output ports are reserved for later. */
  from: [string] | [string, string];
  /** `[nodeId]` or `[nodeId, inputPort]`. The port names a MultiInputAnalyzer port. */
  to: [string] | [string, string];
}

/**
 * Nodes whose output a session records, carried in the graph so a stored
 * pipeline remembers what was being captured.
 *
 * This is **metadata only** — the pipeline never acts on it. It stands up no
 * `Recorder`, changes nothing about how the graph runs, and leaves the named
 * nodes as ordinary outputs. Recording stays external and imperative: build a
 * `Recorder` yourself and feed it {@link Pipeline.recordTargets}, which
 * resolves these ids to observables. {@link Pipeline.issues} checks that the
 * ids still name readable nodes so a selection stored against an older graph
 * degrades visibly rather than silently.
 *
 * The shape is deliberately small; a node editor that wants per-tap settings
 * can widen it later without the runtime needing to care.
 */
export interface PipelineRecord {
  /** Ids of the nodes to record. Source or analyzer nodes, never `transmit` sinks. */
  nodes: string[];
  /** Options a consumer forwards to the `Recorder` it builds from this. */
  options?: RecorderOptions;
}

export interface PipelineGraph {
  nodes: PipelineNode[];
  edges: PipelineEdge[];
  /**
   * Optional recording selection. Passive metadata — see {@link PipelineRecord}.
   */
  record?: PipelineRecord;
}

export interface PipelineOptions {
  /**
   * Reset analyzer state when a source receiver disconnects.
   *
   * On by default: a reconnected headset should not inherit a half-full
   * window of samples from before it was unplugged.
   */
  resetOnDisconnect?: boolean;
  /** Called when a node throws, instead of letting it tear down the stream. */
  onError?: (error: unknown, nodeId: string) => void;
}

/**
 * Buffered inputs for one port of a multi-input node.
 *
 * The cadence estimate is what lets the staleness guard go unconfigured: a
 * port falls behind relative to its own rhythm, not to some global constant.
 */
interface PortState {
  /** Recent packets, oldest first. Holds one unless the policy needs history. */
  packets: DataPacket[];
  /** Exponential moving average of the gap between arrivals, in ms. */
  interval?: number;
  /** Timestamp of the most recent arrival. */
  last?: number;
}

/** The buffered packet whose timestamp sits closest to `reference`. */
function nearestTo(packets: DataPacket[], reference: number): DataPacket {
  let best = packets[0];
  let bestDistance = Math.abs(best.timestamp - reference);

  for (let i = 1; i < packets.length; i++) {
    const distance = Math.abs(packets[i].timestamp - reference);
    // Ties go to the newer packet, which is the one still being extended.
    if (distance <= bestDistance) {
      best = packets[i];
      bestDistance = distance;
    }
  }

  return best;
}

interface NodeRuntime {
  definition: PipelineNode;
  analyzer?: AnyAnalyzer;
  output$: Subject<DataPacket>;
  /** Live transmitter for a sink node, once its transport is attached. */
  transmitter?: StreamTransmitter;
  /** Buffered packets per input port, for multi-input synchronisation. */
  pending: Map<string, PortState>;
  /** Most recent output metadata, for describing live outputs. */
  metadata?: StreamMetadata;
  subscriptions: Subscription[];
  /** Port/stream pairs whose metadata has already been checked. */
  checked: Set<string>;
  /** Port/stream pairs refused by the compatibility check; their packets are dropped. */
  blocked: Set<string>;
}

/** The source key a node reads from, whether it named a receiver or a transport. */
function sourceKeyOf(definition: PipelineNode): string | undefined {
  return definition.receiver ?? definition.receive?.transport;
}

/**
 * Cache key for one compatibility verdict.
 *
 * Keyed by stream as well as port because a port is not limited to one stream:
 * a source node that names no `stream` forwards everything its receiver
 * produces, and a `stream_selection` node routes several streams through a
 * single input. Keying by port alone would let whichever stream arrived first
 * decide for all of them — blocking a whole Muse because its marker stream
 * happened to arrive before its EEG.
 */
function verdictKey(port: string, streamID: string): string {
  return `${port} ${streamID}`;
}

/** How much a graph problem costs at runtime. */
export type IssueSeverity =
  /** The node will never produce output until it is fixed. */
  | "error"
  /** The graph runs, but not on everything wired into it. */
  | "warning";

/** A compatibility problem found in a graph. */
export interface PipelineIssue {
  /** Node the problem was found at. */
  nodeId: string;
  /** Input port it concerns, when the node has named ports. */
  port?: string;
  /** What is wrong, in a form fit to show someone. */
  reason: string;
  /**
   * Whether the graph survives this.
   *
   * The distinction exists because a source can put several streams on one
   * wire, and {@link Pipeline.admits} drops the ones a node cannot use rather
   * than tearing the graph down. Calling that fatal would put the validator at
   * odds with the runtime — a Muse wired straight into a band-power node works
   * fine on its EEG, and the accelerometer being dropped is worth saying but
   * not worth refusing.
   */
  severity: IssueSeverity;
}

/**
 * Executes a processing graph over a set of connected receivers.
 *
 * A pipeline is the runtime half of a data-source block: the block stores
 * `{ nodes, edges }`, the pipeline turns that into named output observables.
 * Nothing here knows what the outputs will be used for.
 *
 * ```ts
 * const pipeline = new Pipeline({
 *   nodes: [
 *     { id: "eeg",    receiver: "muse", stream: Modality.EEG },
 *     { id: "window", method: AnalysisMethod.WINDOWING,  parameters: { size: 2, hop: 0.1 } },
 *     { id: "power",  method: AnalysisMethod.BAND_POWER },
 *   ],
 *   edges: [
 *     { from: ["eeg"],    to: ["window"] },
 *     { from: ["window"], to: ["power"]  },
 *   ],
 * });
 *
 * pipeline.attachReceiver("muse", muse);
 * pipeline.start();
 * pipeline.getOutput("power").subscribe(packet => ...);
 * ```
 */
export class Pipeline {
  private readonly graph: PipelineGraph;
  private readonly options: Required<Pick<PipelineOptions, "resetOnDisconnect">> &
    PipelineOptions;

  private readonly nodes = new Map<string, NodeRuntime>();
  private readonly receivers = new Map<string, BaseReceiver<any>>();
  private readonly transports = new Map<string, Transport>();
  /** Keys whose receiver the pipeline created from a transport and must tear down. */
  private readonly ownedReceivers = new Set<string>();
  private readonly incoming = new Map<string, PipelineEdge[]>();
  private readonly outgoing = new Map<string, PipelineEdge[]>();

  private running = false;

  constructor(graph: PipelineGraph, options: PipelineOptions = {}) {
    this.graph = graph;
    this.options = { resetOnDisconnect: true, ...options };

    this.indexEdges();
    this.assertAcyclic();
    this.buildNodes();
    this.assertSinksAreTerminal();
  }

  /* ---------------------------------------------------------------------- */
  /* Construction                                                            */
  /* ---------------------------------------------------------------------- */

  private indexEdges(): void {
    for (const edge of this.graph.edges) {
      const from = edge.from[0];
      const to = edge.to[0];
      if (!this.outgoing.has(from)) this.outgoing.set(from, []);
      if (!this.incoming.has(to)) this.incoming.set(to, []);
      this.outgoing.get(from)!.push(edge);
      this.incoming.get(to)!.push(edge);
    }
  }

  /**
   * Rejects cyclic graphs at construction.
   *
   * A cycle would otherwise manifest as an infinite synchronous recursion the
   * first time a packet arrived, which is a far harder failure to read than
   * an error naming the node.
   */
  private assertAcyclic(): void {
    const state = new Map<string, "visiting" | "done">();

    const visit = (id: string, path: string[]): void => {
      const current = state.get(id);
      if (current === "done") return;
      if (current === "visiting") {
        throw new Error(
          `Pipeline graph contains a cycle: ${[...path, id].join(" -> ")}`
        );
      }

      state.set(id, "visiting");
      for (const edge of this.outgoing.get(id) ?? []) {
        visit(edge.to[0], [...path, id]);
      }
      state.set(id, "done");
    };

    for (const node of this.graph.nodes) visit(node.id, []);
  }

  private buildNodes(): void {
    for (const definition of this.graph.nodes) {
      if (this.nodes.has(definition.id)) {
        throw new Error(`Duplicate pipeline node id: ${definition.id}`);
      }

      const isSource = sourceKeyOf(definition) !== undefined;
      const isSink = definition.transmit !== undefined;
      const kinds =
        Number(isSource) + Number(isSink) + Number(definition.method != null);

      if (kinds === 0) {
        throw new Error(
          `Node "${definition.id}" must declare a source (receiver / receive), ` +
            `a sink (transmit), or an analyzer (method).`
        );
      }
      if (kinds > 1) {
        throw new Error(
          `Node "${definition.id}" declares more than one of receiver / receive / ` +
            `transmit / method; a node is exactly one kind.`
        );
      }

      this.nodes.set(definition.id, {
        definition,
        analyzer:
          isSource || isSink
            ? undefined
            : createAnalyzer(definition.method!, definition.parameters ?? {}),
        output$: new Subject<DataPacket>(),
        pending: new Map(),
        subscriptions: [],
        checked: new Set(),
        blocked: new Set(),
      });
    }

    // Wire analyzer inputs once; sources are wired when their receiver attaches,
    // and sinks when their transport attaches.
    for (const runtime of this.nodes.values()) {
      if (!runtime.analyzer) continue;
      this.wireAnalyzer(runtime);
    }
  }

  /**
   * Rejects an edge that starts at a sink.
   *
   * A transmit node consumes packets and exposes no output, so anything wired
   * to read from it would subscribe to a subject that never emits — a silent
   * bug rather than a loud one.
   */
  private assertSinksAreTerminal(): void {
    for (const edge of this.graph.edges) {
      const from = this.nodes.get(edge.from[0]);
      if (from?.definition.transmit) {
        throw new Error(
          `Edge starts at "${edge.from[0]}", which is a transmit node and has no output.`
        );
      }
    }
  }

  private wireAnalyzer(runtime: NodeRuntime): void {
    const analyzer = runtime.analyzer!;
    const edges = this.incoming.get(runtime.definition.id) ?? [];

    for (const edge of edges) {
      const upstream = this.nodes.get(edge.from[0]);
      if (!upstream) {
        throw new Error(
          `Edge into "${runtime.definition.id}" references unknown node "${edge.from[0]}".`
        );
      }

      const port = edge.to[1] ?? this.defaultPortFor(analyzer);

      runtime.subscriptions.push(
        upstream.output$.subscribe((packet) => {
          this.consume(runtime, port, packet);
        })
      );
    }
  }

  private defaultPortFor(analyzer: AnyAnalyzer): string {
    return isMultiInput(analyzer) ? analyzer.ports[0] : DEFAULT_PORT;
  }

  /**
   * Binds a sink node to its transport by standing a `StreamTransmitter` on it
   * and feeding it every upstream node's output.
   *
   * A no-op when the transport is not attached yet, or when the sink is already
   * wired — so it is safe to call from both `attachTransport()` and `start()`.
   * The transmitter is a thin wrapper: each incoming edge becomes one
   * `addSource()`, and the class it already is handles announcing metadata,
   * re-announcing on reconnect, and per-stream counters.
   */
  private wireSink(runtime: NodeRuntime): void {
    if (runtime.transmitter) return;
    const key = runtime.definition.transmit!.transport;
    const transport = this.transports.get(key);
    if (!transport) return;

    const transmitter = new StreamTransmitter(
      transport,
      runtime.definition.transmit!.options
    );
    for (const edge of this.incoming.get(runtime.definition.id) ?? []) {
      const upstream = this.nodes.get(edge.from[0]);
      if (!upstream) {
        throw new Error(
          `Edge into "${runtime.definition.id}" references unknown node "${edge.from[0]}".`
        );
      }
      transmitter.addSource(upstream.output$.asObservable());
    }
    transmitter.start();
    runtime.transmitter = transmitter;
  }

  /** Detaches a sink's transmitter without discarding the transport. */
  private unwireSink(runtime: NodeRuntime): void {
    runtime.transmitter?.stop();
    runtime.transmitter = undefined;
  }

  /* ---------------------------------------------------------------------- */
  /* Evaluation                                                              */
  /* ---------------------------------------------------------------------- */

  private consume(
    runtime: NodeRuntime,
    port: string,
    packet: DataPacket
  ): void {
    const analyzer = runtime.analyzer!;

    if (!this.admits(runtime, port, packet.metadata)) return;

    try {
      let result: DataPacket | null;

      if (isMultiInput(analyzer)) {
        this.record(analyzer, runtime.pending, port, packet);
        const gathered = this.gather(analyzer, runtime.pending, packet);
        if (!gathered) return;
        result = analyzer.analyze(gathered);
      } else {
        result = analyzer.analyze(packet);
      }

      if (!result) return;

      runtime.metadata = result.metadata;
      runtime.output$.next(result);
    } catch (error) {
      if (this.options.onError) {
        this.options.onError(error, runtime.definition.id);
      } else {
        console.error(
          `Pipeline node "${runtime.definition.id}" (${analyzer.name}) failed:`,
          error
        );
      }
    }
  }

  /**
   * Gates a port on the compatibility of the stream arriving at it.
   *
   * Checked once per stream per port, on that stream's first packet, because a
   * stream's metadata is fixed for its lifetime and re-checking it per packet
   * would put a string comparison in the hot path of a 256 Hz signal. A refused
   * stream is recorded so later packets are dropped without re-deriving the
   * reason, and the streams sharing that port are judged on their own terms.
   *
   * Refusal drops the branch rather than throwing: one incompatible edge in a
   * graph should not take down the streams that are working, which for a live
   * session means the visual keeps running on whatever inputs are valid.
   */
  private admits(
    runtime: NodeRuntime,
    port: string,
    meta: StreamMetadata
  ): boolean {
    const key = verdictKey(port, meta.streamID);
    if (runtime.blocked.has(key)) return false;
    if (runtime.checked.has(key)) return true;

    runtime.checked.add(key);

    const verdict = this.verdictFor(runtime, port, meta);
    if (verdict === true) return true;

    runtime.blocked.add(key);
    const error = new Error(
      `Node "${runtime.definition.id}" (${runtime.analyzer!.name}) cannot accept stream "${meta.streamID}" on port "${port}": ${verdict}`
    );

    if (this.options.onError) {
      this.options.onError(error, runtime.definition.id);
    } else {
      console.error(error.message);
    }

    return false;
  }

  /** Compatibility of one stream with one of a node's input ports. */
  private verdictFor(
    runtime: NodeRuntime,
    port: string,
    meta: StreamMetadata
  ): true | string {
    const analyzer = runtime.analyzer;
    if (!analyzer) return true;

    const accepts = acceptsFor(analyzer, port);
    if (!accepts) {
      const ports = isMultiInput(analyzer)
        ? Object.keys(analyzer.accepts).join(", ")
        : DEFAULT_PORT;
      return `no such input port (expected one of: ${ports})`;
    }

    return checkAccepts(accepts, meta);
  }

  /**
   * Files an arriving packet under its port and updates that port's cadence
   * estimate.
   */
  private record(
    analyzer: MultiInputAnalyzer<any, any>,
    pending: Map<string, PortState>,
    port: string,
    packet: DataPacket
  ): void {
    let state = pending.get(port);
    if (!state) {
      state = { packets: [] };
      pending.set(port, state);
    }

    // Only forward gaps feed the estimate. A replayed session or a device that
    // resets its clock delivers backwards stamps, and averaging those in would
    // hand the staleness guard a meaningless interval.
    const previous = state.last;
    state.last = packet.timestamp;
    if (previous !== undefined && packet.timestamp > previous) {
      const gap = packet.timestamp - previous;
      state.interval =
        state.interval === undefined
          ? gap
          : state.interval * (1 - INTERVAL_SMOOTHING) + gap * INTERVAL_SMOOTHING;
    }

    state.packets.push(packet);

    const depth =
      analyzer.syncPolicy === "nearest" ? Math.max(1, analyzer.historyDepth) : 1;
    while (state.packets.length > depth) state.packets.shift();
  }

  /**
   * Assembles a full set of inputs for a multi-input node, or null if the
   * ports are not yet ready to be paired.
   *
   * `trigger` is the packet that just arrived and stands in for "now".
   * Measuring age against it rather than against the wall clock keeps the
   * guard meaningful when a recorded session is replayed off real time.
   */
  private gather(
    analyzer: MultiInputAnalyzer<any, any>,
    pending: Map<string, PortState>,
    trigger: DataPacket
  ): Record<string, DataPacket> | null {
    const gathered: Record<string, DataPacket> = {};

    for (const port of analyzer.ports) {
      const state = pending.get(port);
      if (!state || state.packets.length === 0) return null;

      const packet =
        analyzer.syncPolicy === "nearest"
          ? nearestTo(state.packets, trigger.timestamp)
          : state.packets[state.packets.length - 1];

      // A port that has gone quiet stops contributing rather than pinning the
      // output to whatever it last sent.
      if (trigger.timestamp - packet.timestamp > this.staleAfter(analyzer, state)) {
        return null;
      }

      gathered[port] = packet;
    }

    if (analyzer.syncPolicy !== "latest") {
      const timestamps = analyzer.ports.map((p) => gathered[p].timestamp);
      const spread = Math.max(...timestamps) - Math.min(...timestamps);
      if (spread > analyzer.tolerance) return null;
    }

    return gathered;
  }

  /**
   * How old a packet on this port may be before it is read as belonging to a
   * stream that has stopped.
   */
  private staleAfter(
    analyzer: MultiInputAnalyzer<any, any>,
    state: PortState
  ): number {
    if (analyzer.maxAge !== "auto") return analyzer.maxAge;
    if (state.interval === undefined) return AUTO_STALE_FLOOR_MS;
    return Math.max(AUTO_STALE_FLOOR_MS, state.interval * AUTO_STALE_INTERVALS);
  }

  /* ---------------------------------------------------------------------- */
  /* Receivers                                                               */
  /* ---------------------------------------------------------------------- */

  /**
   * Binds a receiver to every source node that names `key`.
   *
   * Safe to call before or after `start()`, which matters because a user
   * connects their headset long after the graph was built.
   */
  public attachReceiver(key: string, receiver: BaseReceiver<any>): void {
    this.detachReceiver(key);
    this.receivers.set(key, receiver);
    if (this.running) this.wireSourcesFor(key);
  }

  /** Unbinds a receiver and drops the subscriptions of its source nodes. */
  public detachReceiver(key: string): void {
    const existing = this.receivers.get(key);
    if (!existing) return;

    for (const runtime of this.nodes.values()) {
      if (sourceKeyOf(runtime.definition) !== key) continue;
      runtime.subscriptions.forEach((s) => s.unsubscribe());
      runtime.subscriptions = [];
      runtime.pending.clear();
    }

    this.receivers.delete(key);
  }

  private wireSourcesFor(key: string): void {
    const receiver = this.receivers.get(key);
    if (!receiver) return;

    let warned = false;
    for (const runtime of this.nodes.values()) {
      const definition = runtime.definition;
      if (sourceKeyOf(definition) !== key) continue;

      if (!receiver.emitsPackets && !warned) {
        warned = true;
        console.warn(
          `Receiver "${key}" (${receiver.deviceName}) never emits packets, so ` +
            `source node "${definition.id}" will stay silent. Attach the receiver ` +
            `that reads from it instead (e.g. a FaceLandmarkReceiver sharing the ` +
            `same <video> element).`
        );
      }

      // No stream named means "everything this device produces", which is the
      // right default for a passthrough source such as a landmark receiver.
      //
      // A named stream is resolved by filtering that same full output rather
      // than by looking a subject up on the receiver. Two reasons, and both
      // are fatal to the lookup: a receiver registers its streams as it
      // discovers them, so a lookup at attach time misses anything a device
      // announces later; and a relay names each stream after its *source*
      // rather than after itself, so the ID a lookup would construct from the
      // receiver's own device ID never existed in the first place.
      const all$ = receiver.data as Observable<DataPacket>;
      const named = definition.stream;
      const source$: Observable<DataPacket> =
        named === undefined
          ? all$
          : all$.pipe(
              filter((packet) =>
                matchesStreamFilter(packet.metadata, streamFilterFor(named))
              )
            );

      runtime.subscriptions.push(
        source$.subscribe((packet) => {
          runtime.metadata = packet.metadata;
          runtime.output$.next(packet);
        })
      );

      if (this.options.resetOnDisconnect) {
        runtime.subscriptions.push(
          receiver.isConnected$.subscribe((connected) => {
            if (!connected) this.reset();
          })
        );
      }
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Transports                                                              */
  /* ---------------------------------------------------------------------- */

  /**
   * Binds a transport to every sink and remote-source node that names `key`.
   *
   * Mirrors {@link attachReceiver}, including the "attach before or after
   * `start()`" contract: a transport is a live object and cannot live in the
   * stored graph, so the graph names it by key and the object arrives here.
   *
   * - A `transmit` node gets a `StreamTransmitter` on the transport.
   * - A `receive` node gets a `RemoteStreamReceiver` the pipeline owns,
   *   registered through {@link attachReceiver} so `stream`, validation and
   *   `resetOnDisconnect` all apply to it unchanged.
   *
   * The returned promise resolves once every remote receiver this call created
   * has connected — useful for a test or a caller that wants to push a packet
   * in straight away. Ignoring it is fine; traffic still flows once the
   * transport is ready.
   */
  public attachTransport(key: string, transport: Transport): Promise<void> {
    this.detachTransport(key);
    this.transports.set(key, transport);

    const connecting: Array<Promise<void>> = [];

    for (const runtime of this.nodes.values()) {
      const receive = runtime.definition.receive;
      if (receive?.transport !== key) continue;

      const remote = new RemoteStreamReceiver(transport, {
        closeTransportOnDisconnect: false,
        ...receive.options,
      });
      this.ownedReceivers.add(key);
      this.attachReceiver(key, remote);
      connecting.push(
        remote.connect().then(() => {
          remote.startStream();
        })
      );
    }

    if (this.running) {
      for (const runtime of this.nodes.values()) {
        if (runtime.definition.transmit?.transport === key) this.wireSink(runtime);
      }
    }

    return Promise.all(connecting).then(() => undefined);
  }

  /**
   * Unbinds a transport: stops its sinks' transmitters and disconnects any
   * remote receiver the pipeline created for it. The transport object is left
   * open — the pipeline never owned it.
   */
  public detachTransport(key: string): void {
    if (!this.transports.has(key)) return;

    for (const runtime of this.nodes.values()) {
      if (runtime.definition.transmit?.transport === key) this.unwireSink(runtime);
    }

    if (this.ownedReceivers.has(key)) {
      const remote = this.receivers.get(key) as RemoteStreamReceiver | undefined;
      void remote?.disconnect();
      this.detachReceiver(key);
      this.ownedReceivers.delete(key);
    }

    this.transports.delete(key);
  }

  /* ---------------------------------------------------------------------- */
  /* Lifecycle                                                               */
  /* ---------------------------------------------------------------------- */

  /** Begins forwarding packets from attached receivers through the graph. */
  public start(): void {
    if (this.running) return;
    this.running = true;
    for (const key of this.receivers.keys()) this.wireSourcesFor(key);
    for (const runtime of this.nodes.values()) {
      if (runtime.definition.transmit) this.wireSink(runtime);
    }
  }

  /** Stops forwarding without discarding the graph; `start()` resumes it. */
  public stop(): void {
    if (!this.running) return;
    this.running = false;

    for (const runtime of this.nodes.values()) {
      if (runtime.definition.transmit) {
        this.unwireSink(runtime);
        continue;
      }
      if (sourceKeyOf(runtime.definition) === undefined) continue;
      runtime.subscriptions.forEach((s) => s.unsubscribe());
      runtime.subscriptions = [];
    }
  }

  /** Clears buffered state in every analyzer. */
  public reset(): void {
    for (const runtime of this.nodes.values()) {
      runtime.analyzer?.reset();
      runtime.pending.clear();
      // A reconnected device may describe itself differently — an LSL relay
      // re-announcing a stream, say — so past verdicts are re-derived rather
      // than carried over.
      runtime.checked.clear();
      runtime.blocked.clear();
    }
  }

  /** Tears the pipeline down permanently. */
  public destroy(): void {
    this.stop();
    for (const key of Array.from(this.ownedReceivers)) {
      const remote = this.receivers.get(key) as RemoteStreamReceiver | undefined;
      void remote?.disconnect();
    }
    for (const runtime of this.nodes.values()) {
      runtime.subscriptions.forEach((s) => s.unsubscribe());
      runtime.subscriptions = [];
      runtime.output$.complete();
    }
    this.nodes.clear();
    this.receivers.clear();
    this.transports.clear();
    this.ownedReceivers.clear();
  }

  /* ---------------------------------------------------------------------- */
  /* Validation                                                              */
  /* ---------------------------------------------------------------------- */

  /**
   * Every compatibility problem the graph can be shown to have right now.
   *
   * Two kinds are reported: an input port with nothing wired to it, and a port
   * fed by a stream its node cannot interpret. The second is only decidable
   * where the upstream metadata is known — which covers source nodes as soon
   * as their receiver is attached, since a receiver publishes stream metadata
   * at registration rather than on first packet. An analyzer's output is
   * unknown until it has emitted once, so edges downstream of a silent
   * analyzer are not judged here; the runtime check in `admits()` is what
   * eventually catches those.
   *
   * Returns an empty array for a graph with nothing wrong *and* for one whose
   * sources are not attached yet, so treat it as "no known problems".
   */
  public issues(): PipelineIssue[] {
    const found: PipelineIssue[] = [];

    for (const runtime of this.nodes.values()) {
      const nodeId = runtime.definition.id;
      const edges = this.incoming.get(nodeId) ?? [];

      // A sink does nothing useful with no input, but accepts anything a
      // transport can carry — including categorical marker streams — so there
      // is no edge compatibility to check beyond "is it connected".
      if (runtime.definition.transmit) {
        if (edges.length === 0) {
          found.push({
            nodeId,
            severity: "error",
            reason: "transmit node has no input",
          });
        }
        continue;
      }

      const analyzer = runtime.analyzer;
      if (!analyzer) continue;

      if (isMultiInput(analyzer)) {
        const wired = new Set(
          edges.map((edge) => edge.to[1] ?? analyzer.primaryPort)
        );
        for (const port of analyzer.ports) {
          if (!wired.has(port)) {
            found.push({
              nodeId,
              port,
              severity: "error",
              reason: `input port "${port}" is not connected`,
            });
          }
        }
      } else if (edges.length === 0) {
        found.push({ nodeId, severity: "error", reason: "node has no input" });
      }

      for (const edge of edges) {
        const port = edge.to[1] ?? this.defaultPortFor(analyzer);
        const issue = this.edgeIssue(runtime, port, edge.from[0]);
        if (issue) found.push(issue);
      }
    }

    // `graph.record` is passive, so a stale id here never stops the graph
    // running — it is a warning the recording selection has drifted, for an
    // editor to surface, not an error that blocks `validate()`.
    for (const id of this.graph.record?.nodes ?? []) {
      const runtime = this.nodes.get(id);
      if (!runtime) {
        found.push({
          nodeId: id,
          severity: "warning",
          reason: `graph.record names "${id}", which is not a node in this graph`,
        });
      } else if (runtime.definition.transmit) {
        found.push({
          nodeId: id,
          severity: "warning",
          reason: `graph.record names "${id}", a transmit sink with no output to record`,
        });
      }
    }

    return found;
  }

  /**
   * The problem with one edge, if it has one.
   *
   * Judged over the whole set of streams the edge carries rather than one at a
   * time, because a fat wire is normal here: nothing usable means the node is
   * dead and that is an error, while some usable means it runs on a subset and
   * that is a warning naming what gets lost. An edge whose upstream metadata is
   * unknown is not judged at all.
   */
  private edgeIssue(
    runtime: NodeRuntime,
    port: string,
    fromId: string
  ): PipelineIssue | undefined {
    const metas = this.knownOutputsOf(fromId);
    if (metas.length === 0) return undefined;

    const refused: string[] = [];
    for (const meta of metas) {
      const verdict = this.verdictFor(runtime, port, meta);
      if (verdict !== true) refused.push(verdict);
    }
    if (refused.length === 0) return undefined;

    const nodeId = runtime.definition.id;

    if (refused.length === metas.length) {
      return {
        nodeId,
        port,
        severity: "error",
        // A single stream speaks for itself; several need to be introduced as
        // a set before their reasons make sense together.
        reason:
          refused.length === 1
            ? refused[0]
            : `no stream on this edge can be used: ${refused.join("; ")}`,
      };
    }

    return {
      nodeId,
      port,
      severity: "warning",
      reason: `${refused.length} of ${metas.length} streams on this edge will be dropped: ${refused.join(
        "; "
      )}`,
    };
  }

  /**
   * Throws if the graph has any known compatibility problem.
   *
   * Reports all of them at once: someone fixing a stored graph wants the whole
   * list, not one error per edit-and-rerun cycle.
   *
   * Only errors throw. A warning describes a graph that runs on some of what
   * is wired into it, which is the ordinary shape of a fat wire and not a
   * reason to refuse to start — read {@link issues} to show those.
   */
  public validate(): void {
    const found = this.issues().filter((issue) => issue.severity === "error");
    if (found.length === 0) return;

    const detail = found
      .map((issue) =>
        issue.port
          ? `  - "${issue.nodeId}" port "${issue.port}": ${issue.reason}`
          : `  - "${issue.nodeId}": ${issue.reason}`
      )
      .join("\n");

    throw new Error(
      `Pipeline graph has ${found.length} compatibility problem${
        found.length === 1 ? "" : "s"
      }:\n${detail}`
    );
  }

  /**
   * Output metadata of a node, where it can be known without running the
   * graph. Empty when it cannot.
   */
  private knownOutputsOf(nodeId: string): StreamMetadata[] {
    const runtime = this.nodes.get(nodeId);
    if (!runtime) return [];

    const receiverKey = sourceKeyOf(runtime.definition);
    if (receiverKey !== undefined) {
      const receiver = this.receivers.get(receiverKey);
      if (!receiver) return [];

      // Every registered stream, then narrowed by the node's `stream` if it
      // named one — the same filter the subscription applies, rather than a
      // lookup by an ID reconstructed from the receiver's own device name.
      const metas: StreamMetadata[] = [];
      for (const id of receiver.streams) {
        const meta = receiver.getStreamMeta(id);
        if (meta) metas.push(meta);
      }

      const named = runtime.definition.stream;
      return named === undefined
        ? metas
        : metas.filter((meta) =>
            matchesStreamFilter(meta, streamFilterFor(named))
          );
    }

    const analyzer = runtime.analyzer;

    // A router forwards packets untouched, so what leaves it is what reached
    // it minus what it drops — knowable without running the graph. This is
    // what makes the edge on the far side of a selector exactly checkable
    // instead of unjudged. Recursion terminates because the graph is acyclic.
    if (analyzer && isRouter(analyzer)) {
      const upstream: StreamMetadata[] = [];
      for (const edge of this.incoming.get(nodeId) ?? []) {
        upstream.push(...this.knownOutputsOf(edge.from[0]));
      }
      return upstream.filter((meta) => analyzer.passes(meta));
    }

    return runtime.metadata ? [runtime.metadata] : [];
  }

  /* ---------------------------------------------------------------------- */
  /* Outputs                                                                 */
  /* ---------------------------------------------------------------------- */

  /** Observable of a single node's output. */
  public getOutput(nodeId: string): Observable<DataPacket> {
    const runtime = this.nodes.get(nodeId);
    if (!runtime) {
      throw new Error(`Unknown pipeline node: ${nodeId}`);
    }
    if (runtime.definition.transmit) {
      throw new Error(
        `Pipeline node "${nodeId}" is a transmit sink and has no output.`
      );
    }
    return runtime.output$.asObservable();
  }

  /**
   * Node ids with no outgoing edges — the graph's terminal outputs.
   *
   * Sinks are excluded: a transmit node has no outgoing edge but is not an
   * output to read, so it stays out of `outputs`, `data` and `describe()`.
   */
  public get terminalNodes(): string[] {
    return Array.from(this.nodes.keys()).filter(
      (id) =>
        !this.nodes.get(id)!.definition.transmit &&
        (this.outgoing.get(id) ?? []).length === 0
    );
  }

  /**
   * What every sink node in the graph is shipping, and where.
   *
   * The counterpart to {@link describe} for the outbound side — a node editor
   * can draw a transmit block with its transport label and a live per-stream
   * packet count. Empty `streams` until the sink's transport is attached and
   * data has flowed.
   */
  public transmitters(): Array<{
    nodeId: string;
    label?: string;
    transport: string;
    transmitting: boolean;
    streams: Array<{ streamID: string; packets: number; samples: number }>;
  }> {
    const out: Array<{
      nodeId: string;
      label?: string;
      transport: string;
      transmitting: boolean;
      streams: Array<{ streamID: string; packets: number; samples: number }>;
    }> = [];
    for (const runtime of this.nodes.values()) {
      const transmit = runtime.definition.transmit;
      if (!transmit) continue;
      out.push({
        nodeId: runtime.definition.id,
        label: runtime.definition.label,
        transport: transmit.transport,
        transmitting: runtime.transmitter?.isTransmitting ?? false,
        streams: runtime.transmitter?.summary ?? [],
      });
    }
    return out;
  }

  /** Every terminal node's output, keyed by node id. */
  public get outputs(): Map<string, Observable<DataPacket>> {
    const map = new Map<string, Observable<DataPacket>>();
    for (const id of this.terminalNodes) map.set(id, this.getOutput(id));
    return map;
  }

  /** Merged stream of every terminal output. */
  public get data(): Observable<DataPacket> {
    const outputs = this.terminalNodes.map((id) => this.getOutput(id));
    return outputs.length > 0 ? merge(...outputs) : new Subject<DataPacket>();
  }

  /**
   * The outputs named by `graph.record`, keyed by node id, ready to hand to a
   * `Recorder`.
   *
   * The pipeline records nothing itself — `graph.record` is a stored selection
   * of tap points, and this resolves it:
   *
   * ```ts
   * const recorder = new Recorder(pipeline.recordOptions);
   * for (const source of pipeline.recordTargets().values()) recorder.addSource(source);
   * recorder.start();
   * ```
   *
   * Ids that no longer name a readable node — renamed, deleted, or turned into
   * a transmit sink since the graph was stored — are left out, and
   * {@link issues} reports them as warnings, so a stale selection degrades
   * rather than throws. Any non-sink node qualifies, not just terminal ones.
   */
  public recordTargets(): Map<string, Observable<DataPacket>> {
    const map = new Map<string, Observable<DataPacket>>();
    for (const id of this.graph.record?.nodes ?? []) {
      const runtime = this.nodes.get(id);
      if (!runtime || runtime.definition.transmit) continue;
      map.set(id, runtime.output$.asObservable());
    }
    return map;
  }

  /** Recorder options carried in `graph.record`, if the graph set any. */
  public get recordOptions(): RecorderOptions | undefined {
    return this.graph.record?.options;
  }

  /** Most recent output metadata for a node, once it has emitted at least once. */
  public getMetadata(nodeId: string): StreamMetadata | undefined {
    return this.nodes.get(nodeId)?.metadata;
  }

  /**
   * Snapshot of what this pipeline currently exposes.
   *
   * Channel labels are only known once a node has emitted, so a freshly built
   * pipeline reports its outputs with empty channel lists — consumers that
   * need labels before any data flows should read them from the stored block
   * definition instead.
   */
  public describe(): Array<{
    nodeId: string;
    label?: string;
    method?: string;
    streamID?: string;
    channels: Array<{ index: number; label: string; unit?: string }>;
    samplingRate?: number;
  }> {
    return this.terminalNodes.map((id) => {
      const runtime = this.nodes.get(id)!;
      const meta = runtime.metadata;
      return {
        nodeId: id,
        label: runtime.definition.label,
        method: runtime.definition.method,
        streamID: meta?.streamID,
        channels: meta?.channelInfo ?? [],
        samplingRate: meta?.samplingRate,
      };
    });
  }
}
