import {
  AnalysisMethod,
  DataPacket,
  Modality,
  ProcessingStage,
} from "../../../data_stream.interface";
import { Accepts, BaseAnalyzer } from "../../base_analyzer";
import { isValidStreamID } from "../../../utility";

export interface StreamSelectionParameters {
  /**
   * Stream IDs to pass.
   *
   * An entry that is a well-formed stream ID (`muse-1:eeg:raw`) must match
   * exactly; anything else is treated as a case-insensitive fragment, so
   * `"eeg"` passes every EEG stream on the wire and `"muse-1"` passes
   * everything from one device. {@link isValidStreamID} draws the line, which
   * is the same rule the receivers use to tell an ID from a bare modality.
   */
  streams?: string[];
  /** Modalities to pass. */
  modalities?: Modality[];
  /**
   * Pass everything that does *not* match instead.
   *
   * "Everything except the accelerometer" is usually shorter to express than
   * the list of streams you do want, and stays correct when the device gains a
   * stream later.
   */
  invert?: boolean;
}

/**
 * Passes the packets belonging to some streams and drops the rest.
 *
 * A source node that names no `stream` forwards everything its receiver
 * produces — a Muse puts EEG, PPG, accelerometer and gyroscope on one wire, an
 * LSL relay puts every stream the lab is running on one wire — and until this
 * node existed there was no way to pull them apart again downstream. Naming a
 * `stream` on the source node is the other way to do it, but it resolves the
 * stream at wire time and so only works if the receiver has already connected;
 * filtering downstream is connect-order safe.
 *
 * ```ts
 * { id: "device", receiver: "muse" },                       // everything
 * { id: "eeg",    method: "stream_selection",
 *   parameters: { modalities: ["eeg"] } },
 * { id: "pulse",  method: "stream_selection",
 *   parameters: { modalities: ["ppg"] } },
 * ```
 *
 * **Packets pass through untouched.** This is the one node that does not call
 * `emit()`: a matching packet is forwarded with its stream ID, metadata and
 * processing history exactly as they arrived, because a router that renamed
 * the thing it routed would destroy the identity the rest of the graph — and
 * `Recorder` downstream — addresses it by. Nothing is computed here, so
 * nothing is recorded as having been computed.
 *
 * It is also the only node that accepts a categorical stream. Routing is not
 * interpretation: splitting markers off a shared wire so they can be recorded
 * or bound separately never does arithmetic on a marker code, which is the
 * thing every other node is kept away from them to prevent.
 */
export class StreamSelection extends BaseAnalyzer {
  readonly name = "StreamSelection";
  readonly method = AnalysisMethod.STREAM_SELECTION;

  /**
   * Inert. A passthrough never calls `emit()`, so this stage is never stamped
   * onto anything — a routed packet keeps whatever stage it arrived with.
   */
  readonly stage = ProcessingStage.RAW;

  constructor(parameters: StreamSelectionParameters = {}) {
    super({
      streams: undefined,
      modalities: undefined,
      invert: false,
      ...parameters,
    });
  }

  /**
   * Everything. A router has no opinion about what it carries, and this is
   * what lets a marker stream be split off a shared wire.
   */
  readonly accepts: Accepts = { valueTypes: ["numeric", "categorical"] };

  /** Whether a stream satisfies any of the configured criteria. */
  private matches(packet: DataPacket): boolean {
    const streams: string[] | undefined = this.parameters.streams;
    const modalities: Modality[] | undefined = this.parameters.modalities;

    // Unconfigured, this node is the identity. A UI that adds the node before
    // anyone has picked a stream should show every packet flowing, not none.
    const configured =
      (streams && streams.length > 0) || (modalities && modalities.length > 0);
    if (!configured) return true;

    if (modalities && modalities.includes(packet.metadata.modality)) return true;

    if (streams) {
      const id = packet.streamID;
      const lowered = id.toLowerCase();
      for (const entry of streams) {
        if (isValidStreamID(entry)) {
          if (entry === id) return true;
        } else if (lowered.includes(entry.toLowerCase())) {
          return true;
        }
      }
    }

    return false;
  }

  analyze(packet: DataPacket): DataPacket | null {
    const matched = this.matches(packet);
    const pass = this.parameters.invert ? !matched : matched;
    return pass ? packet : null;
  }
}
