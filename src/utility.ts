import {
  DataPacket,
  Modality,
  ProcessingStage,
  StreamIdentifier,
  StreamIdentifierLiteral,
  StreamMetadata,
  TypedArray,
  ValueType,
} from "./data_stream.interface";

/**
 *
 * @param streamIdentifier – Object containing the metadata for identifying the stream.
 * @returns A string representation of the stream identifier.
 */
export function streamIDToString(
  streamIdentifier: StreamIdentifier
): StreamIdentifierLiteral {
  const { deviceID, modality, processingStage, name } = streamIdentifier;
  if (name) {
    return `${deviceID}:${modality}:${processingStage}:${name}`;
  } else {
    return `${deviceID}:${modality}:${processingStage}`;
  }
}

/**
 * Tests whether a string is a well-formed stream identifier.
 *
 * A stream ID has three or four colon-separated parts, and its modality and
 * processing stage must be members of the corresponding enums — otherwise a
 * bare modality such as "eeg" would be indistinguishable from a stream ID.
 */
export function isValidStreamID(id: string): id is StreamIdentifierLiteral {
  const parts = id.split(":");
  if (parts.length < 3 || parts.length > 4) return false;
  if (!parts[0]) return false;
  return (
    Object.values(Modality).includes(parts[1] as Modality) &&
    Object.values(ProcessingStage).includes(parts[2] as ProcessingStage)
  );
}

/** Whether a string names one of the known modalities. */
export function isModality(value: string): value is Modality {
  return (Object.values(Modality) as string[]).includes(value);
}

/**
 * A rule for selecting streams by identity or by modality.
 *
 * The single definition of the selection vocabulary, read by the
 * `stream_selection` node, by a source node's `stream` shortcut, and by the
 * graph validator — so all three answer "does this stream match?" identically.
 *
 * It reads {@link StreamMetadata} rather than a packet, which is what lets the
 * same rule be applied before any data flows: a receiver publishes metadata at
 * `initializeStream()`, so a stored graph can be checked against a device that
 * has done nothing but announce itself.
 */
export interface StreamFilter {
  /**
   * Stream IDs to pass. A well-formed stream ID (`muse-1:eeg:raw`) must match
   * exactly; anything else is treated as a case-insensitive fragment, so
   * `"muse-1"` passes everything from one device.
   */
  streams?: string[];
  /** Modalities to pass. */
  modalities?: Modality[];
  /** Pass everything that does *not* match instead. */
  invert?: boolean;
}

/** Whether a stream satisfies a filter's criteria, before `invert` is applied. */
function matchesCriteria(meta: StreamMetadata, filter: StreamFilter): boolean {
  const { streams, modalities } = filter;

  // Unconfigured, a filter is the identity. A UI that adds a selector before
  // anyone has picked a stream should show every packet flowing, not none.
  const configured =
    (streams && streams.length > 0) || (modalities && modalities.length > 0);
  if (!configured) return true;

  if (modalities && modalities.includes(meta.modality)) return true;

  if (streams) {
    const lowered = meta.streamID.toLowerCase();
    for (const entry of streams) {
      if (isValidStreamID(entry)) {
        if (entry === meta.streamID) return true;
      } else if (lowered.includes(entry.toLowerCase())) {
        return true;
      }
    }
  }

  return false;
}

/** Whether a stream passes a filter. */
export function matchesStreamFilter(
  meta: StreamMetadata,
  filter: StreamFilter
): boolean {
  const matched = matchesCriteria(meta, filter);
  return filter.invert ? !matched : matched;
}

/**
 * The filter meant by a source node's `stream` shortcut.
 *
 * A bare modality selects by modality rather than by fragment, so naming `eeg`
 * cannot also pull in a device whose name happens to contain "eeg".
 */
export function streamFilterFor(
  stream: StreamIdentifierLiteral | Modality
): StreamFilter {
  return isModality(stream) ? { modalities: [stream] } : { streams: [stream] };
}

/**
 * Converts a string representation of a stream ID into a StreamIdentifier object.
 *
 * @param streamId – The string representation of the stream ID.
 * @returns An object representing the stream identifier.
 * @throws Error if the format of the stream ID is invalid.
 */
export function stringToStreamID(
  streamId: StreamIdentifierLiteral
): StreamIdentifier {
  const parts = streamId.split(":");
  if (parts.length < 3 || parts.length > 4) {
    throw new Error(`Invalid stream ID format: ${streamId}`);
  }

  return {
    deviceID: parts[0],
    modality: parts[1] as Modality,
    processingStage: parts[2] as ProcessingStage,
    name: parts.length > 3 ? parts[3] : undefined,
  };
}

/**
 * Scale of measurement for a stream, defaulting to `"numeric"`.
 *
 * Reads the declaration on the metadata rather than looking for labels on a
 * packet, so the answer is the same before and after data starts flowing. The
 * one place the default lives, so a source that never sets `valueType` — every
 * device but the marker receiver — still reports something definite.
 */
export function getValueType(meta: StreamMetadata): ValueType {
  return meta.valueType ?? "numeric";
}

/** Whether a stream carries categorical values rather than measurements. */
export function isCategorical(meta: StreamMetadata): boolean {
  return getValueType(meta) === "categorical";
}

/* -------------------------------------------------------------------------- */
/* Channel layout helpers                                                     */
/*                                                                            */
/* Packet payloads are sample-interleaved: sample `i` of channel `c` lives at  */
/* `data[i * channelCount + c]`. These helpers are the only place that         */
/* ordering is assumed, so every analyzer can stay layout-agnostic.            */
/* -------------------------------------------------------------------------- */

/** Channel count for a packet, falling back to channelInfo length, then 1. */
export function getChannelCount(packet: DataPacket<any>): number {
  const meta = packet.metadata;
  return meta?.channelCount ?? meta?.channelInfo?.length ?? 1;
}

/** Number of samples per channel carried by a packet. */
export function getSampleCount(packet: DataPacket<any>): number {
  const channels = getChannelCount(packet);
  return channels > 0 ? Math.floor(packet.data.length / channels) : 0;
}

/**
 * Extracts one channel from an interleaved packet as a dense Float32Array.
 *
 * This necessarily copies — an interleaved channel is strided, and TypedArray
 * views cannot express a stride.
 */
export function getChannel(
  packet: DataPacket<any>,
  channel: number
): Float32Array {
  const channels = getChannelCount(packet);
  if (channel < 0 || channel >= channels) {
    throw new Error(
      `Channel ${channel} out of range for stream ${packet.streamID} (${channels} channels).`
    );
  }
  const source = packet.data;
  const samples = Math.floor(source.length / channels);
  const out = new Float32Array(samples);
  for (let i = 0; i < samples; i++) {
    out[i] = source[i * channels + channel];
  }
  return out;
}

/** Splits an interleaved buffer into one dense array per channel. */
export function deinterleave(
  data: ArrayLike<number>,
  channelCount: number
): Float32Array[] {
  if (channelCount <= 0) throw new Error("channelCount must be positive.");
  const samples = Math.floor(data.length / channelCount);
  const out: Float32Array[] = [];
  for (let c = 0; c < channelCount; c++) {
    const channel = new Float32Array(samples);
    for (let i = 0; i < samples; i++) {
      channel[i] = data[i * channelCount + c];
    }
    out.push(channel);
  }
  return out;
}

/**
 * Interleaves per-channel arrays into a single buffer.
 *
 * Channels of unequal length are truncated to the shortest, which is what a
 * device that dropped a sample on one electrode should produce.
 */
export function interleave(channels: ArrayLike<number>[]): Float32Array {
  const channelCount = channels.length;
  if (channelCount === 0) return new Float32Array(0);

  let samples = Infinity;
  for (const channel of channels) {
    if (channel.length < samples) samples = channel.length;
  }
  if (!isFinite(samples)) samples = 0;

  const out = new Float32Array(samples * channelCount);
  for (let c = 0; c < channelCount; c++) {
    const channel = channels[c];
    for (let i = 0; i < samples; i++) {
      out[i * channelCount + c] = channel[i];
    }
  }
  return out;
}

/** True for arrays whose first element is itself array-like (channel-major). */
function isChannelMajor(value: any): value is ArrayLike<number>[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    typeof value[0] === "object" &&
    value[0] !== null &&
    typeof (value[0] as any).length === "number"
  );
}

/**
 * Normalizes whatever a device hands us into an interleaved Float32Array.
 *
 * Accepts a scalar, a flat array already in interleaved order, or a
 * channel-major array-of-arrays (which is what muse-js and most chunked
 * devices produce). Channel-major input is interleaved; flat input is passed
 * through, copying only when it is not already a Float32Array.
 */
export function toInterleaved(
  data: number | ArrayLike<number> | ArrayLike<number>[]
): Float32Array {
  if (typeof data === "number") return Float32Array.of(data);
  if (isChannelMajor(data)) return interleave(data);
  if (data instanceof Float32Array) return data;
  return Float32Array.from(data as ArrayLike<number>);
}

/** Shallow-copies a packet, swapping in new data and optional overrides. */
export function withData<T extends TypedArray>(
  packet: DataPacket<any>,
  data: T,
  overrides: Partial<DataPacket<T>> = {}
): DataPacket<T> {
  return {
    streamID: packet.streamID,
    timestamp: packet.timestamp,
    data,
    metadata: packet.metadata,
    ...(packet.labels !== undefined ? { labels: packet.labels } : {}),
    ...(packet.deviceTime !== undefined ? { deviceTime: packet.deviceTime } : {}),
    ...overrides,
  };
}

/** Builds generic channel labels for devices that do not name their channels. */
export function genericChannelInfo(count: number, prefix = "Channel") {
  return Array.from({ length: count }, (_, index) => ({
    index,
    label: `${prefix} ${index + 1}`,
  }));
}
