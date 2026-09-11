/**
 * Mirrors TelemetryEngine.unavailableReason (core). Kept as a literal for the
 * web bundle so the UI does not need to import server code.
 */
export const TelemetryEngineUnavailableReason =
  'HCR currently manages routing but is not in the inference data path, so token usage, latency, and throughput are unavailable for this session.';
