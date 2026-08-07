/**
 * The marker the planner sets on every agent it spawns, kept in a leaf module so
 * telemetry can read it without importing the launcher tree (which reaches the
 * prompts/store modules and would close an import cycle back onto logging).
 */
export const SPAWNED_BY_PLANNER_ENV = "AUTONOMA_PLANNER_SPAWNED_AGENT";

/** True when this process was started by an agent the planner spawned. */
export function isSpawnedByPlanner(env: NodeJS.ProcessEnv): boolean {
    return env[SPAWNED_BY_PLANNER_ENV] != null && env[SPAWNED_BY_PLANNER_ENV] !== "";
}
