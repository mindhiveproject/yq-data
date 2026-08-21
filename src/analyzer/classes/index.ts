/**
 * Packet-aware processing nodes.
 *
 * Each class wraps the pure functions in `../methods` with stream metadata
 * handling, so a node can be dropped into a pipeline graph and produce a
 * correctly identified output stream.
 */

export * from "./preprocessing/windowing";
export * from "./preprocessing/filtering";
export * from "./preprocessing/normalization";
export * from "./preprocessing/channel_selection";

export * from "./transform/spectrum";

export * from "./features/band_power";
export * from "./features/statistics";
export * from "./features/heart_rate";

export * from "./multi/correlation";
export * from "./multi/difference";
