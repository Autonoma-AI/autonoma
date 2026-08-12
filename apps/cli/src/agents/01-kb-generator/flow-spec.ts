import { z } from "zod";

/**
 * How a flow can break, expressed as the shape of its input space rather than a
 * score. A number would only ever say "write more tests", and past a point a flow
 * has no sub-flows left to write. The driver says which attack to run, so budget
 * converts into depth instead of more happy paths.
 */
export const RISK_DRIVERS = [
    "unconstrained_input",
    "spatial_manipulation",
    "interruptible_state",
    "realtime_async",
    "permissions",
] as const;

/** One of the closed set of risk drivers a flow may declare. */
export type RiskDriver = (typeof RISK_DRIVERS)[number];

/**
 * Driver -> what it means, and the single source the zod description renders from.
 * Exhaustive over `RiskDriver` (compiler-checked): a driver added to RISK_DRIVERS
 * is a compile error here until it is described, and this map cannot carry a key
 * that is not a driver - so the two cannot drift. The red-team playbooks are keyed
 * the same way, for the same reason.
 */
const RISK_DRIVER_DESCRIPTIONS: Readonly<Record<RiskDriver, string>> = {
    unconstrained_input: "free text, file upload, rich text - an input space too large to enumerate.",
    spatial_manipulation: "canvas, drag and drop, placement by coordinate, resize, overlap.",
    interruptible_state: "multi-step work that can be abandoned, resumed, refreshed or navigated away from.",
    realtime_async: "streaming, polling, sockets, optimistic updates, autosave.",
    permissions: "visibility or capability that varies by actor.",
};

const RiskDriver = z
    .enum(RISK_DRIVERS)
    .describe(RISK_DRIVERS.map((driver) => `${driver}: ${RISK_DRIVER_DESCRIPTIONS[driver]}`).join(" "));

/**
 * What share of the test budget a flow deserves.
 *
 * Tier replaces an earlier `core: boolean`, which could not express the middle:
 * a binary flag makes everything that is not core look equally unimportant, so
 * budget fell back to counting pages and a product's administration screens
 * outweighed the flow it is sold on.
 */
const Tier = z
    .union([z.literal(1), z.literal(2), z.literal(3)])
    .describe(
        "1: the product fails at its purpose without this - it is what the pitch promises. " +
            "2: serves a tier-1 flow, or is used constantly but is not what the product is for. " +
            "3: administration, configuration and account management.",
    );

const CoreFlow = z.object({
    /**
     * The closed set every generated test's `flow` field must draw from. The model
     * still fills this in, but `stabilizeFlowIds` overwrites it with a slug derived
     * from the flow's shallowest owned route before flows.json is written: left to
     * the model the id churned run to run (`test-creation` / `test-authoring` for the
     * same flow), which broke cross-run scoring and drowned the git signal. Routes do
     * not churn like that, so the route-derived id is what everything downstream keys on.
     */
    id: z
        .string()
        .regex(/^[a-z0-9-]+$/, "lowercase kebab-case slug")
        .describe("Stable identifier for this flow, e.g. 'request-intake'."),
    feature: z.string().min(1).describe("Human-readable name."),
    description: z.string().min(10).describe("What this feature or area does."),
    /**
     * A quality bar rather than a summary: the single thing this feature must get
     * right. Predates tiering and is kept because it constrains what a test should
     * assert, where tier only decides how many tests there are.
     */
    mission: z
        .string()
        .min(10)
        .describe("The ONE thing this feature must do correctly. A quality bar, not a restatement of the name."),
    tier: Tier,
    tierReason: z
        .string()
        .min(20)
        .describe("Why this tier, argued from the pitch. Specific enough that someone could disagree with it."),
    /**
     * A promise the product makes, phrased so a test can try to break it. Seeds
     * adversarial generation: an agent given a specific promise writes a sharp
     * test, where one told to "be adversarial" writes noise.
     */
    invariants: z
        .array(z.string().min(10))
        .describe("Guarantees this flow claims to uphold, each phrased as something a test could falsify."),
    riskDrivers: z.array(RiskDriver),
    /**
     * Routes, never source paths. Budget allocation maps each registered page onto
     * a flow through this field, and a run that answers in file paths while another
     * answers in routes makes every comparison miss without failing - the same shape
     * as an earlier defect where a route was matched against a source path and no
     * feature ever found its page.
     */
    entryPoints: z
        .array(z.string().regex(/^\//, "must be a route beginning with /, not a source file path"))
        .min(1)
        .describe(
            "URL routes a user reaches this flow through, as the router defines them " +
                "(e.g. /orders, /orders/[id]). Never source file paths.",
        ),
});

export type CoreFlow = z.infer<typeof CoreFlow>;

export const CoreFlowsSpec = z.object({
    /**
     * Written before the flows, and deliberately capped. A sentence has a word
     * budget and spending it IS ranking - a pitch that mentions everything ranks
     * nothing. Asking instead for "the core flows" invites enumeration, and a list
     * carries no order.
     */
    pitch: z
        .string()
        .min(20)
        .max(240)
        .describe("One sentence: what this product IS, as its own team would pitch it. The nouns here are tier 1."),
    flows: z.array(CoreFlow).min(1),
});

export type CoreFlowsSpec = z.infer<typeof CoreFlowsSpec>;

/** Share of the test budget each tier receives, above the per-page smoke-test floor. */
export const TIER_BUDGET_SHARE: Readonly<Record<1 | 2 | 3, number>> = { 1: 0.6, 2: 0.3, 3: 0.1 };
