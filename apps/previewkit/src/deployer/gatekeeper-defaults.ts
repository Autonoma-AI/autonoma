// Default idle timeout before the central Gatekeeper scales an idle preview's
// workloads to zero. Shared between env.ts's GATEKEEPER_IDLE_TIMEOUT schema
// default and Deployer's constructor fallback so the two can't drift apart -
// this is the one place the value is written.
export const DEFAULT_GATEKEEPER_IDLE_TIMEOUT = "15m";
