import type { OnboardingStep } from "@autonoma/db";
import { isStepAtOrPast } from "./onboarding-step-order";

/**
 * Idle window before the UI treats the agent as released (soft mutex handed back
 * to the human, form editable). The agent re-claims on its next write, or the
 * window elapses again. The only "lock timeout": no background job, staleness is
 * derived from `agentLastActivityAt` at read time.
 */
export const AGENT_SESSION_STALE_AFTER_MS = 30 * 60 * 1000;

/** The onboarding-state fields that say whether an agent is driving an application. */
export interface AgentSessionLiveness {
    step: OnboardingStep;
    /** Stamped the first time an agent paired; absent on an application no agent has ever driven. */
    agentConnectedAt?: Date;
    agentLastActivityAt?: Date;
}

/** Whether an agent session has gone quiet long enough that control is treated as released. */
export function isAgentSessionStale(lastActivityAt: Date | undefined, now = Date.now()): boolean {
    if (lastActivityAt == null) return true;
    return now - lastActivityAt.getTime() > AGENT_SESSION_STALE_AFTER_MS;
}

/**
 * Whether an agent is driving this application's configuration, which is what
 * decides if a write has to take the soft mutex and stream itself onto the
 * activity feed. The question is about the APPLICATION's situation, not about
 * which MCP mount the write arrived on: the same tool has to serialize against a
 * human watching a config screen and run unencumbered on a long-live app.
 *
 * An application no agent has ever paired with has no session to serialize
 * against. While onboarding is unfinished there IS one even if the agent has
 * gone quiet - the UI has handed the form back, but the agent re-claims on its
 * next write and the user is still watching it happen. Once onboarding is
 * finished the SDK and recipe work carries on for a while, so the session stays
 * current as long as the agent keeps acting; when it finally goes quiet the app
 * is just a live app, and a write against it (from an editor debugging a pull
 * request months later) must not try to claim a mutex nobody is holding.
 *
 * The staleness window is what separates those two, so a post-completion agent
 * that pauses longer than it - a slow build, or waiting on the user - resumes
 * unencumbered: no claim, and nothing streamed to the feed for that write. The
 * cost is confined to coordination, since a recipe write still serializes on its
 * own `baseFingerprint` and a racing editor is rejected with their version.
 */
export function isAgentDrivenApplication(session: AgentSessionLiveness, now = Date.now()): boolean {
    if (session.agentConnectedAt == null) return false;
    if (!isStepAtOrPast(session.step, "completed")) return true;
    return !isAgentSessionStale(session.agentLastActivityAt, now);
}
