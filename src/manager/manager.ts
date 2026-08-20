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
import { Observable, Subject, Subscription, merge } from "rxjs";

/** Default port name for the single-input, single-output case. */
export const DEFAULT_PORT = "in";

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

interface NodeRuntime {
  definition: PipelineNode;
  analyzer?: AnyAnalyzer;
  output$: Subject<DataPacket>;
  /** Latest packet per input port, for multi-input synchronisation. */
  pending: Map<string, DataPacket>;
  /** Most recent output metadata, for describing live outputs. */
  metadata?: StreamMetadata;
  subscriptions: Subscription[];
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

    try {
      let result: DataPacket | null;

      if (isMultiInput(analyzer)) {
        runtime.pending.set(port, packet);
        const gathered = this.gather(analyzer, runtime.pending);
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
   * Assembles a full set of inputs for a multi-input node, or null if the
   * ports are not yet ready to be paired.
   */
  private gather(
    analyzer: MultiInputAnalyzer<any, any>,
    pending: Map<string, DataPacket>
  ): Record<string, DataPacket> | null {
    const gathered: Record<string, DataPacket> = {};

    for (const port of analyzer.ports) {
      const packet = pending.get(port);
      if (!packet) return null;
      gathered[port] = packet;
    }

    if (analyzer.syncPolicy === "timestamp") {
      const timestamps = analyzer.ports.map((p) => gathered[p].timestamp);
      const spread = Math.max(...timestamps) - Math.min(...timestamps);
      if (spread > analyzer.tolerance) return null;
    }

    return gathered;
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
