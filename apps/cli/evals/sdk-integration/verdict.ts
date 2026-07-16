import { z } from "zod";

/** One graded dimension: whether it holds, with concrete file:line evidence. */
const dimensionSchema = z.object({
    satisfied: z.boolean(),
    /** One sentence citing `file:line` evidence from the agent's tree (or golden). */
    evidence: z.string(),
});

/** The load-bearing dimensions the SDK integration exists to get right. */
export const VERDICT_DIMENSIONS = ["endpointImplemented", "realCreationPaths", "teardownScoped", "realAuth"] as const;

export const verdictSchema = z.object({
    /** Did the agent achieve functional parity with the client's golden integration. */
    passed: z.boolean(),
    factoryCoverage: z.object({
        /** Entities from the entity audit the agent built a working factory for. */
        covered: z.array(z.string()),
        /** Entities the audit required but the agent skipped or left broken. */
        missing: z.array(z.string()),
    }),
    dimensions: z.object({
        /** discover/up/down endpoint wired through the SDK handler with signature checks. */
        endpointImplemented: dimensionSchema,
        /** Factories create through the app's own code, not raw DB writes (where a path exists). */
        realCreationPaths: dimensionSchema,
        /** Teardown is scoped to test data and reverses dependency order. */
        teardownScoped: dimensionSchema,
        /** The auth callback returns real usable credentials, not a placeholder. */
        realAuth: dimensionSchema,
    }),
    /** How the agent's integration compares to golden - cite specific differences. */
    reasoning: z.string(),
});

export type Verdict = z.infer<typeof verdictSchema>;
