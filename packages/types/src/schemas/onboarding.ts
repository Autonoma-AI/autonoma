import { z } from "zod";

/** Lifecycle of an agent tool-call log entry, mirrored in the UI stream. */
export const AgentLogEntryStatusSchema = z.enum(["running", "done", "error"]);
export type AgentLogEntryStatus = z.infer<typeof AgentLogEntryStatusSchema>;

export const AgentLogEntrySchema = z.object({
    id: z.string(),
    message: z.string(),
    timestamp: z.string(),
    // When the entry represents an MCP tool call (agentic previewkit config): the
    // tool name and the arguments the agent passed, so the UI can stream the call
    // and render its dim-JSON args. Absent for plain human-readable log lines.
    // Never carries secret values.
    tool: z.string().optional(),
    toolArguments: z.json().optional(),
    status: AgentLogEntryStatusSchema.optional(),
    // Populated when status is "error", for the red failed-call row in the UI.
    error: z.string().optional(),
});
export type AgentLogEntry = z.infer<typeof AgentLogEntrySchema>;

/**
 * A question only the human can answer, raised by the agent mid-configuration and
 * rendered inline in the locked onboarding UI. Stored on
 * `OnboardingState.agentPendingRequest`; the agent discovers the resolution by
 * polling. An env request carries only KEYS - values are entered in the UI and
 * never reach the agent.
 */
export const OnboardingAgentPendingEnvRequestSchema = z.object({
    kind: z.literal("env"),
    keys: z.array(z.string().min(1)).min(1),
    /** Which app in the topology the keys belong to (config apps are keyed by name, and a secret store is per-app). */
    appName: z.string().min(1),
    /** A human-facing note from the agent explaining what the keys are for. */
    note: z.string().optional(),
});

export const OnboardingAgentPendingChoiceRequestSchema = z.object({
    kind: z.literal("choice"),
    prompt: z.string().min(1),
    options: z.array(z.object({ value: z.string(), label: z.string() })).min(2),
});

export const OnboardingAgentPendingRequestSchema = z.discriminatedUnion("kind", [
    OnboardingAgentPendingEnvRequestSchema,
    OnboardingAgentPendingChoiceRequestSchema,
]);
export type OnboardingAgentPendingRequest = z.infer<typeof OnboardingAgentPendingRequestSchema>;
