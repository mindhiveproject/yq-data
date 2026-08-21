import {
  DataPacket,
  Modality,
  StreamIdentifierLiteral,
  StreamMetadata,
  AnalysisMethod,
} from "../data_stream.interface";
import { BaseReceiver } from "../receiver/base_receiver";
import {
  AnyAnalyzer,
  MultiInputAnalyzer,
  isMultiInput,
} from "../analyzer/base_analyzer";
import { createAnalyzer } from "../analyzer/registry";
import { acceptsFor, checkAccepts } from "../analyzer/compatibility";
import { Observable, Subject, Subscription, merge } from "rxjs";

/** Default port name for the single-input, single-output case. */
export const DEFAULT_PORT = "in";

/** Floor for a derived staleness limit, so slow streams are never cut off. */
const AUTO_STALE_FLOOR_MS = 1000;

/** How many of its own packet intervals a port may miss before it reads as stale. */
const AUTO_STALE_INTERVALS = 4;

/** Weight of the newest gap in a port's cadence estimate. */
const INTERVAL_SMOOTHING = 0.2;

/**
 * A node in a pipeline graph.
 *
 * A node is a *source* when it names a receiver, and an *analyzer* otherwise.
 * Both forms are plain JSON so a whole processing graph can be stored in a
 * database column and rehydrated without any code.
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
  /** Which of that receiver's streams to read. Defaults to all of them. */
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

export interface PipelineGraph {
  nodes: PipelineNode[];
  edges: PipelineEdge[];
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
  /** Buffered packets per input port, for multi-input synchronisation. */
  pending: Map<string, PortState>;
  /** Most recent output metadata, for describing live outputs. */
  metadata?: StreamMetadata;
  subscriptions: Subscription[];
  /** Ports whose incoming metadata has already been checked. */
  checked: Set<string>;
  /** Ports refused by the compatibility check; their packets are dropped. */
  blocked: Set<string>;
}

/** A compatibility problem found in a graph. */
export interface PipelineIssue {
  /** Node the problem was found at. */
  nodeId: string;
  /** Input port it concerns, when the node has named ports. */
  port?: string;
  /** What is wrong, in a form fit to show someone. */
  reason: string;
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
  private readonly incoming = new Map<string, PipelineEdge[]>();
  private readonly outgoing = new Map<string, PipelineEdge[]>();

  private running = false;

  constructor(graph: PipelineGraph, options: PipelineOptions = {}) {
    this.graph = graph;
    this.options = { resetOnDisconnect: true, ...options };

    this.indexEdges();
    this.assertAcyclic();
    this.buildNodes();
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

      const isSource = definition.receiver !== undefined;
      if (!isSource && !definition.method) {
        throw new Error(
          `Node "${definition.id}" must declare either a receiver (source) or a method (analyzer).`
        );
      }

      this.nodes.set(definition.id, {
        definition,
        analyzer: isSource
          ? undefined
          : createAnalyzer(definition.method!, definition.parameters ?? {}),
        output$: new Subject<DataPacket>(),
        pending: new Map(),
        subscriptions: [],
        checked: new Set(),
        blocked: new Set(),
      });
    }

    // Wire analyzer inputs once; sources are wired when their receiver attaches.
    for (const runtime of this.nodes.values()) {
      if (!runtime.analyzer) continue;
      this.wireAnalyzer(runtime);
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
   * Checked once per port, on the first packet, because a stream's metadata is
   * fixed for its lifetime and re-checking it per packet would put a string
   * comparison in the hot path of a 256 Hz signal. A refused port is recorded
   * so later packets are dropped without re-deriving the reason.
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
    if (runtime.blocked.has(port)) return false;
    if (runtime.checked.has(port)) return true;

    runtime.checked.add(port);

    const verdict = this.verdictFor(runtime, port, meta);
    if (verdict === true) return true;

    runtime.blocked.add(port);
    const error = new Error(
      `Node "${runtime.definition.id}" (${runtime.analyzer!.name}) cannot accept input on port "${port}": ${verdict}`
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
      if (runtime.definition.receiver !== key) continue;
      runtime.subscriptions.forEach((s) => s.unsubscribe());
      runtime.subscriptions = [];
      runtime.pending.clear();
    }

    this.receivers.delete(key);
  }

  private wireSourcesFor(key: string): void {
    const receiver = this.receivers.get(key);
    if (!receiver) return;

    for (const runtime of this.nodes.values()) {
      const definition = runtime.definition;
      if (definition.receiver !== key) continue;

      // No stream named means "everything this device produces", which is the
      // right default for a passthrough source such as a landmark receiver.
      const source$: Observable<DataPacket> = definition.stream
        ? (receiver.getData(definition.stream) as Observable<DataPacket>)
        : (receiver.data as Observable<DataPacket>);

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
  /* Lifecycle                                                               */
  /* ---------------------------------------------------------------------- */

  /** Begins forwarding packets from attached receivers through the graph. */
  public start(): void {
    if (this.running) return;
    this.running = true;
    for (const key of this.receivers.keys()) this.wireSourcesFor(key);
  }

  /** Stops forwarding without discarding the graph; `start()` resumes it. */
  public stop(): void {
    if (!this.running) return;
    this.running = false;

    for (const runtime of this.nodes.values()) {
      if (runtime.definition.receiver === undefined) continue;
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
    for (const runtime of this.nodes.values()) {
      runtime.subscriptions.forEach((s) => s.unsubscribe());
      runtime.subscriptions = [];
      runtime.output$.complete();
    }
    this.nodes.clear();
    this.receivers.clear();
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
      const analyzer = runtime.analyzer;
      if (!analyzer) continue;

      const nodeId = runtime.definition.id;
      const edges = this.incoming.get(nodeId) ?? [];

      if (isMultiInput(analyzer)) {
        const wired = new Set(
          edges.map((edge) => edge.to[1] ?? analyzer.primaryPort)
        );
        for (const port of analyzer.ports) {
          if (!wired.has(port)) {
            found.push({
              nodeId,
              port,
              reason: `input port "${port}" is not connected`,
            });
          }
        }
      } else if (edges.length === 0) {
        found.push({ nodeId, reason: "node has no input" });
      }

      for (const edge of edges) {
        const port = edge.to[1] ?? this.defaultPortFor(analyzer);
        for (const meta of this.knownOutputsOf(edge.from[0])) {
          const verdict = this.verdictFor(runtime, port, meta);
          if (verdict !== true) found.push({ nodeId, port, reason: verdict });
        }
      }
    }

    return found;
  }

  /**
   * Throws if the graph has any known compatibility problem.
   *
   * Reports all of them at once: someone fixing a stored graph wants the whole
   * list, not one error per edit-and-rerun cycle.
   */
  public validate(): void {
    const found = this.issues();
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

    const receiverKey = runtime.definition.receiver;
    if (receiverKey === undefined) {
      return runtime.metadata ? [runtime.metadata] : [];
    }

    const receiver = this.receivers.get(receiverKey);
    if (!receiver) return [];

    const stream = runtime.definition.stream;
    const ids = stream !== undefined ? [stream] : receiver.streams;

    const metas: StreamMetadata[] = [];
    for (const id of ids) {
      try {
        const meta = receiver.getStreamMeta(id);
        if (meta) metas.push(meta);
      } catch {
        // An identifier the receiver does not recognise is a wiring mistake,
        // but not one the compatibility layer can describe usefully.
      }
    }
    return metas;
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
    return runtime.output$.asObservable();
  }

  /** Node ids with no outgoing edges — the graph's terminal outputs. */
  public get terminalNodes(): string[] {
    return Array.from(this.nodes.keys()).filter(
      (id) => (this.outgoing.get(id) ?? []).length === 0
    );
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
