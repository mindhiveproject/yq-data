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

/** Default port name for the single-input, single-output case. */
export const DEFAULT_PORT = "in";

/** Floor for a derived staleness limit, so slow streams are never cut off. */
const AUTO_STALE_FLOOR_MS = 1000;

/**
 * How many of its own packet intervals a port may miss before it reads as stale.
 *
 * Shared with {@link FaceOverlay}, so a drawing and a graph agree on when a
 * stream that went quiet has stopped.
 */
export const AUTO_STALE_INTERVALS = 4;

/** Most input combinations tried when deriving a multi-input node's outputs. */
const MAX_COMBINATIONS = 64;

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
  /**
   * Streams this source is expected to deliver, for a source node only.
   *
   * What lets a graph be described and checked before its source exists — a
   * WebSocket peer that has not connected, a headset that is not on. Until the
   * attached receiver has announced streams of its own, these stand in for
   * them: `describe()` lists their channels, and `issues()` judges the edges
   * leaving the node against them. Once the receiver has announced anything,
   * what it announces replaces them, so a stale declaration can never override
   * a device.
   *
   * Plain {@link StreamMetadata}, so it can be stored in the graph JSON. Only
   * the fields the checks read need be present: `streamID`, `modality`, and
   * whichever of `samplingRate`, `channelInfo`, `samplesPerChannel` and
   * `valueType` apply.
   */
  expects?: StreamMetadata[];
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
   * window of samples from before it was unplugged. Only the nodes downstream
   * of the dropped receiver are reset, so a second headset's branch keeps
   * running undisturbed.
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
  /** Packets delivered to this node during the current wave, in arrival order. */
  inbox: Array<{ port: string; packet: DataPacket }>;
  /**
   * Longest path from any source, so every node an input depends on has a lower
   * rank than the node itself. Evaluating in rank order is what lets a node
   * that several branches rejoin at wait for all of them.
   */
  rank: number;
  /** Most recent output metadata, for describing live outputs. */
  metadata?: StreamMetadata;
  subscriptions: Subscription[];
  /** Port/stream pairs whose metadata has already been checked. */
  checked: Set<string>;
  /** Port/stream pairs refused by the compatibility check; their packets are dropped. */
  blocked: Set<string>;
}

/** A packet leaving a source node, the first step of a wave. */
interface Emission {
  runtime: NodeRuntime;
  packet: DataPacket;
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

/** Whether a {@link verdictKey} belongs to `port`. */
function isVerdictFor(key: string, port: string): boolean {
  return key.startsWith(`${port} `);
}

/** One output of a pipeline, as {@link Pipeline.describe} reports it. */
export interface PipelineOutputDescription {
  nodeId: string;
  label?: string;
  method?: string;
  streamID?: string;
  channels: Array<{ index: number; label: string; unit?: string }>;
  samplingRate?: number;
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
  /** Whether a wave is being evaluated; a packet that arrives meanwhile waits its turn. */
  private propagating = false;
  private readonly backlog: Array<Emission[]> = [];

  constructor(graph: PipelineGraph, options: PipelineOptions = {}) {
    this.graph = graph;
    this.options = { resetOnDisconnect: true, ...options };

    this.indexEdges();
    this.assertAcyclic();
    this.buildNodes();
    this.assertEdgesResolve();
    this.assignRanks();
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
      if (definition.expects && !isSource) {
        throw new Error(
          `Node "${definition.id}" declares \`expects\`, which only a source node ` +
            `(receiver / receive) can: an analyzer's output follows from its input.`
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
        inbox: [],
        rank: 0,
        subscriptions: [],
        checked: new Set(),
        blocked: new Set(),
      });
    }
  }

  /**
   * Rejects an edge into an analyzer that starts at a node that does not exist.
   *
   * Sources are wired when their receiver attaches and sinks when their
   * transport attaches; analyzers need no wiring, because packets reach them
   * along edges during a wave.
   */
  private assertEdgesResolve(): void {
    for (const runtime of this.nodes.values()) {
      if (!runtime.analyzer) continue;
      for (const edge of this.incoming.get(runtime.definition.id) ?? []) {
        if (!this.nodes.has(edge.from[0])) {
          throw new Error(
            `Edge into "${runtime.definition.id}" references unknown node "${edge.from[0]}".`
          );
        }
      }
    }
  }

  /** Numbers each node by the longest path leading to it. See {@link NodeRuntime.rank}. */
  private assignRanks(): void {
    const ranked = new Set<string>();

    const rankOf = (id: string): number => {
      const runtime = this.nodes.get(id);
      if (!runtime) return 0;
      if (ranked.has(id)) return runtime.rank;

      let rank = 0;
      for (const edge of this.incoming.get(id) ?? []) {
        rank = Math.max(rank, rankOf(edge.from[0]) + 1);
      }
      runtime.rank = rank;
      ranked.add(id);
      return rank;
    };

    for (const id of this.nodes.keys()) rankOf(id);
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

  /**
   * Evaluates the graph for packets that have just arrived at source nodes.
   *
   * A packet's passage through the graph is a *wave*, evaluated in rank order:
   * every node runs only after everything it depends on has, and runs once per
   * wave however many branches fed it. That is what makes a diamond — one node
   * fanning out to two branches that rejoin at a multi-input node — emit once
   * per upstream packet with both inputs from the same moment. Evaluating
   * depth-first instead, as each branch finished, would fire the join as soon
   * as the first branch arrived, pairing it with the other branch's *previous*
   * packet, and then again when the second arrived: two outputs per packet,
   * one of them stale.
   *
   * All the source nodes a single receiver packet reaches belong to the same
   * wave, for the same reason: two source nodes reading one device are two
   * branches of one diamond.
   */
  private inject(emissions: Emission[]): void {
    if (this.propagating) {
      this.backlog.push(emissions);
      return;
    }

    this.propagating = true;
    try {
      let wave: Emission[] | undefined = emissions;
      while (wave) {
        this.runWave(wave);
        wave = this.backlog.shift();
      }
    } finally {
      this.propagating = false;
    }
  }

  private runWave(emissions: Emission[]): void {
    const ready = new Set<NodeRuntime>();
    for (const { runtime, packet } of emissions) {
      this.publish(runtime, packet, ready);
    }

    while (ready.size > 0) {
      let next: NodeRuntime | undefined;
      for (const candidate of ready) {
        if (!next || candidate.rank < next.rank) next = candidate;
      }
      ready.delete(next!);
      this.evaluate(next!, ready);
    }
  }

  /**
   * Emits a packet from a node: to anyone watching its output, and into the
   * inbox of every analyzer it feeds, which is then due in this wave.
   *
   * Sinks are not delivered to here — they subscribe to the output directly,
   * so they see the packet at this point whatever their rank.
   */
  private publish(
    runtime: NodeRuntime,
    packet: DataPacket,
    ready: Set<NodeRuntime>
  ): void {
    runtime.metadata = packet.metadata;
    runtime.output$.next(packet);

    for (const edge of this.outgoing.get(runtime.definition.id) ?? []) {
      const target = this.nodes.get(edge.to[0]);
      if (!target?.analyzer) continue;
      target.inbox.push({
        port: edge.to[1] ?? this.defaultPortFor(target.analyzer),
        packet,
      });
      ready.add(target);
    }
  }

  private publishAll(
    runtime: NodeRuntime,
    result: DataPacket | DataPacket[] | null,
    ready: Set<NodeRuntime>
  ): void {
    if (!result) return;
    for (const output of Array.isArray(result) ? result : [result]) {
      this.publish(runtime, output, ready);
    }
  }

  /** Runs one step of a node, reporting a throw instead of letting it tear down the wave. */
  private attempt<T>(runtime: NodeRuntime, step: () => T): T | null {
    try {
      return step();
    } catch (error) {
      if (this.options.onError) {
        this.options.onError(error, runtime.definition.id);
      } else {
        console.error(
          `Pipeline node "${runtime.definition.id}" (${runtime.analyzer!.name}) failed:`,
          error
        );
      }
      return null;
    }
  }

  /** Processes everything that arrived at a node during the wave. */
  private evaluate(runtime: NodeRuntime, ready: Set<NodeRuntime>): void {
    const analyzer = runtime.analyzer!;
    const inbox = runtime.inbox.splice(0);

    if (!isMultiInput(analyzer)) {
      for (const { port, packet } of inbox) {
        if (!this.admits(runtime, port, packet.metadata)) continue;
        this.publishAll(runtime, this.attempt(runtime, () => analyzer.analyze(packet)), ready);
      }
      return;
    }

    // Group into steps: step *n* holds the *n*th packet that arrived on each
    // port. Usually there is one step, and every port that fired is recorded
    // before anything is paired — the point of waiting. More than one happens
    // when a port received several packets in a wave (windowing with
    // `frames: "all"`), which are then paired one at a time, each against the
    // newest packet on every other port, as an exact-rate series needs.
    const steps: Array<Array<{ port: string; packet: DataPacket }>> = [];
    const arrived = new Map<string, number>();
    for (const item of inbox) {
      if (!this.admits(runtime, item.port, item.packet.metadata)) continue;
      const n = arrived.get(item.port) ?? 0;
      arrived.set(item.port, n + 1);
      (steps[n] ??= []).push(item);
    }

    for (const step of steps) {
      for (const { port, packet } of step) {
        this.record(analyzer, runtime.pending, port, packet);
      }
      // The last to arrive stands in for "now", as a lone arrival used to.
      const trigger = step[step.length - 1].packet;

      const result = this.attempt(runtime, () => {
        const gathered = this.gather(analyzer, runtime.pending, trigger);
        return gathered ? analyzer.analyze(gathered) : null;
      });
      this.publishAll(runtime, result, ready);
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

    const sources = Array.from(this.nodes.values()).filter(
      (runtime) => sourceKeyOf(runtime.definition) === key
    );
    if (sources.length === 0) return;

    if (!receiver.emitsPackets) {
      console.warn(
        `Receiver "${key}" (${receiver.deviceName}) never emits packets, so ` +
          `source node "${sources[0].definition.id}" will stay silent. Attach the receiver ` +
          `that reads from it instead (e.g. a FaceLandmarkReceiver sharing the ` +
          `same <video> element).`
      );
    }

    // No stream named means "everything this device produces", which is the
    // right default for a passthrough source such as a landmark receiver.
    //
    // A named stream is resolved by filtering the receiver's full output per
    // packet rather than by looking a subject up on the receiver. Two reasons,
    // and both are fatal to the lookup: a receiver registers its streams as it
    // discovers them, so a lookup at attach time misses anything a device
    // announces later; and a relay names each stream after its *source*
    // rather than after itself, so the ID a lookup would construct from the
    // receiver's own device ID never existed in the first place.
    const taps = sources.map((runtime) => ({
      runtime,
      match:
        runtime.definition.stream === undefined
          ? undefined
          : streamFilterFor(runtime.definition.stream),
    }));

    // One subscription per receiver, carrying every source node it feeds into
    // the same wave: two source nodes reading one packet are two branches of a
    // diamond, and must be evaluated as one. It rides on the first source node
    // so it is torn down with the rest when the receiver detaches or the
    // pipeline stops.
    const host = sources[0];
    host.subscriptions.push(
      (receiver.data as Observable<DataPacket>).subscribe((packet) => {
        const emissions: Emission[] = [];
        for (const { runtime, match } of taps) {
          if (!match || matchesStreamFilter(packet.metadata, match)) {
            emissions.push({ runtime, packet });
          }
        }
        if (emissions.length > 0) this.inject(emissions);
      })
    );

    // The drop concerns the whole device, and `resetDownstreamOf` already
    // covers every node that names it.
    if (this.options.resetOnDisconnect) {
      host.subscriptions.push(
        receiver.isConnected$.subscribe((connected) => {
          if (!connected) this.resetDownstreamOf(key);
        })
      );
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

  /**
   * Begins forwarding packets from attached receivers through the graph.
   *
   * With `validate`, throws instead of starting if {@link issues} reports any
   * error, listing all of them at once: someone fixing a stored graph wants
   * the whole list, not one error per edit-and-rerun cycle. Opt-in because a
   * graph is usually started before its devices are on, and what cannot be
   * known yet is not judged; attach the receivers first to have their streams
   * checked too.
   *
   * Only errors throw. A warning describes a graph that runs on some of what
   * is wired into it, which is the ordinary shape of a fat wire and not a
   * reason to refuse to start — read {@link issues} to show those.
   */
  public start(options: { validate?: boolean } = {}): void {
    if (this.running) return;
    if (options.validate) this.assertNoErrors();
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

  /**
   * Clears buffered state in the part of the graph a dropped receiver feeds,
   * and nowhere else.
   *
   * With two headsets in one patch, a drop on one must not wipe the half-full
   * windows of the other, so only nodes reachable from the receiver's source
   * nodes are touched. A node where the two meet is reset too, because its
   * analyzer state mixes both — but only the *ports* the dropped side feeds
   * lose their buffered packet; the surviving side's last packet stays, so
   * pairing resumes as soon as the dropped side returns rather than after the
   * survivor's next emission, which for a windowing node can be seconds away.
   */
  private resetDownstreamOf(key: string): void {
    const affected = new Set<string>();
    const queue: string[] = [];

    for (const runtime of this.nodes.values()) {
      if (sourceKeyOf(runtime.definition) !== key) continue;
      affected.add(runtime.definition.id);
      queue.push(runtime.definition.id);
    }

    while (queue.length > 0) {
      for (const edge of this.outgoing.get(queue.pop()!) ?? []) {
        const next = edge.to[0];
        if (affected.has(next)) continue;
        affected.add(next);
        queue.push(next);
      }
    }

    for (const id of affected) {
      const runtime = this.nodes.get(id)!;
      const analyzer = runtime.analyzer;
      if (!analyzer) continue;

      analyzer.reset();

      for (const edge of this.incoming.get(id) ?? []) {
        if (!affected.has(edge.from[0])) continue;
        const port = edge.to[1] ?? this.defaultPortFor(analyzer);
        runtime.pending.delete(port);
        // Verdicts are re-derived for the same reason `reset()` re-derives them.
        for (const verdicts of [runtime.checked, runtime.blocked]) {
          for (const entry of verdicts) {
            if (isVerdictFor(entry, port)) verdicts.delete(entry);
          }
        }
      }
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
   * fed by a stream its node cannot interpret. The second is decidable wherever
   * the upstream metadata is known, which is further than it sounds. A source
   * node's streams are known as soon as its receiver is attached, since a
   * receiver publishes stream metadata at registration rather than on first
   * packet — or from the node's `expects`, before that. And each analyzer
   * declares how it shapes its output (`describeOutput()`), so the streams
   * leaving a whole chain of them are worked out from the source's, with no
   * data flowing: a correlation fed band power is an error before any headset
   * is on. Only a custom analyzer that declares nothing leaves its output
   * unknown until it has emitted, and edges downstream of it are not judged
   * until then; the runtime check in `admits()` is what catches those.
   *
   * Returns an empty array for a graph with nothing wrong *and* for one whose
   * sources are not known yet, so treat it as "no known problems".
   */
  public issues(): PipelineIssue[] {
    const found: PipelineIssue[] = [];
    const known = new Map<string, StreamMetadata[]>();

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
        const issue = this.edgeIssue(runtime, port, edge.from[0], known);
        if (issue) found.push(issue);
      }
    }

    // `graph.record` is passive, so a stale id here never stops the graph
    // running — it is a warning the recording selection has drifted, for an
    // editor to surface, not an error that blocks `start({ validate: true })`.
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
    fromId: string,
    known: Map<string, StreamMetadata[]>
  ): PipelineIssue | undefined {
    const metas = this.knownOutputsOf(fromId, known);
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

  /** Throws if {@link issues} reports any error. See {@link start}. */
  private assertNoErrors(): void {
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
   *
   * Worked out from the sources forward. A source answers from what its
   * receiver has announced, or else from its `expects`. A router forwards what
   * reaches it minus what it drops. An analyzer shapes each stream it admits
   * through its own `describeOutput()`. Only an analyzer that declares nothing
   * falls back to what it last emitted. `known` memoises per node, because a
   * diamond would otherwise be derived once per path through it.
   */
  private knownOutputsOf(
    nodeId: string,
    known: Map<string, StreamMetadata[]> = new Map()
  ): StreamMetadata[] {
    const cached = known.get(nodeId);
    if (cached) return cached;

    const result = this.deriveOutputsOf(nodeId, known);
    known.set(nodeId, result);
    return result;
  }

  private deriveOutputsOf(
    nodeId: string,
    known: Map<string, StreamMetadata[]>
  ): StreamMetadata[] {
    const runtime = this.nodes.get(nodeId);
    if (!runtime) return [];

    if (sourceKeyOf(runtime.definition) !== undefined) {
      return this.knownStreamsOfSource(runtime);
    }

    const analyzer = runtime.analyzer;
    if (!analyzer) return [];

    // A router forwards packets untouched, so what leaves it is what reached
    // it minus what it drops — knowable without running the graph. This is
    // what makes the edge on the far side of a selector exactly checkable
    // instead of unjudged. Recursion terminates because the graph is acyclic.
    if (isRouter(analyzer)) {
      const upstream: StreamMetadata[] = [];
      for (const edge of this.incoming.get(nodeId) ?? []) {
        upstream.push(...this.knownOutputsOf(edge.from[0], known));
      }
      return upstream.filter((meta) => analyzer.passes(meta));
    }

    const declared = this.declaredOutputsOf(runtime, known);
    if (declared && declared.length > 0) return declared;

    return runtime.metadata ? [runtime.metadata] : [];
  }

  /**
   * The streams a source node will deliver, as far as is known.
   *
   * What the attached receiver has registered, narrowed by the node's `stream`
   * — the same filter the subscription applies, rather than a lookup by an ID
   * reconstructed from the receiver's own device name. A receiver that has
   * registered nothing (not attached, or a remote peer that has not announced)
   * is no evidence of nothing, so the node's `expects` stand in.
   */
  private knownStreamsOfSource(runtime: NodeRuntime): StreamMetadata[] {
    const definition = runtime.definition;
    const receiver = this.receivers.get(sourceKeyOf(definition)!);

    const metas: StreamMetadata[] = [];
    for (const id of receiver?.streams ?? []) {
      const meta = receiver!.getStreamMeta(id);
      if (meta) metas.push(meta);
    }
    if (metas.length === 0) metas.push(...(definition.expects ?? []));

    const named = definition.stream;
    return named === undefined
      ? metas
      : metas.filter((meta) => matchesStreamFilter(meta, streamFilterFor(named)));
  }

  /**
   * What an analyzer would emit for the streams wired into it, from its own
   * declaration. `undefined` when the analyzer declares nothing; empty when
   * its inputs are not known yet.
   *
   * A stream the node would refuse is left out, since the runtime drops it
   * too; the refusal is reported against the edge, not repeated here.
   */
  private declaredOutputsOf(
    runtime: NodeRuntime,
    known: Map<string, StreamMetadata[]>
  ): StreamMetadata[] | undefined {
    const analyzer = runtime.analyzer!;

    const byPort = new Map<string, StreamMetadata[]>();
    for (const edge of this.incoming.get(runtime.definition.id) ?? []) {
      const port = edge.to[1] ?? this.defaultPortFor(analyzer);
      const admitted = this.knownOutputsOf(edge.from[0], known).filter(
        (meta) => this.verdictFor(runtime, port, meta) === true
      );
      byPort.set(port, [...(byPort.get(port) ?? []), ...admitted]);
    }

    const outputs = new Map<string, StreamMetadata>();
    const add = (meta: StreamMetadata | null | undefined): boolean => {
      if (meta === undefined) return false;
      if (meta !== null) outputs.set(meta.streamID, meta);
      return true;
    };

    if (!isMultiInput(analyzer)) {
      for (const meta of byPort.get(this.defaultPortFor(analyzer)) ?? []) {
        if (!add(analyzer.describeOutput(meta))) return undefined;
      }
      return Array.from(outputs.values());
    }

    // One stream per port, tried in every combination a fat wire allows. A
    // cap keeps a pathological graph from blowing up; real ones pair a stream
    // with a stream.
    let combinations: Array<Record<string, StreamMetadata>> = [{}];
    for (const port of analyzer.ports) {
      const options = byPort.get(port) ?? [];
      if (options.length === 0) return [];
      combinations = combinations
        .flatMap((partial) =>
          options.map((meta) => ({ ...partial, [port]: meta }))
        )
        .slice(0, MAX_COMBINATIONS);
    }
    for (const inputs of combinations) {
      if (!add(analyzer.describeOutput(inputs))) return undefined;
    }
    return Array.from(outputs.values());
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
   * What this pipeline exposes, per terminal output: the channels it will carry
   * and the rate they arrive at.
   *
   * Available before any data flows. Each analyzer declares how it shapes its
   * output, so a freshly built pipeline reports "Alpha", "Beta" and the rest —
   * or "AF7 Alpha" with `perChannel` — as soon as the streams entering it are
   * known, which is as soon as a receiver is attached or a source node
   * `expects` them. Only a custom analyzer that declares nothing reports an
   * empty channel list until it has emitted.
   *
   * A node that can carry several streams (a source wired straight out, with a
   * Muse's EEG, PPG and accelerometer all on it) appears once per stream, so
   * `streamID` tells them apart.
   */
  public describe(): PipelineOutputDescription[] {
    const known = new Map<string, StreamMetadata[]>();

    return this.terminalNodes.flatMap((id): PipelineOutputDescription[] => {
      const definition = this.nodes.get(id)!.definition;
      const node = {
        nodeId: id,
        label: definition.label,
        method: definition.method,
      };

      const outputs = this.knownOutputsOf(id, known);
      if (outputs.length === 0) return [{ ...node, channels: [] }];

      return outputs.map((meta): PipelineOutputDescription => ({
        ...node,
        streamID: meta.streamID,
        channels: meta.channelInfo ?? [],
        samplingRate: meta.samplingRate,
      }));
    });
  }
}
