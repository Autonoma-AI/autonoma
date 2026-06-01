import { CostCollector, type LanguageModel, MODEL_ENTRIES, type ModelOptions, ModelRegistry } from "@autonoma/ai";
import { logger as rootLogger } from "@autonoma/logger";

/**
 * Capability-named registry keys for the diffs model registry.
 *
 * A key describes a model's place on the capability/cost/latency spectrum (following the engine's
 * `{fast,smart,genius}-{visual,text}` naming by convention) so call sites can be retargeted to a
 * different vendor model without touching them. Diffs uses a single capability today.
 */
export type DiffsModelName = "smart-visual";

/**
 * A per-run, metered facade over the singleton diffs {@link ModelRegistry}.
 *
 * A run may pull whatever capability models its agents need, so the session is not bound to a single
 * model. Every {@link ModelSession.getModel} call is metered into this session's
 * {@link ModelSession.costCollector}.
 */
export interface ModelSession {
    /**
     * Acquire a model for a single role within the run.
     *
     * The call's token usage and cost are metered into {@link ModelSession.costCollector}. The
     * `tag` on {@link ModelOptions} identifies the role of THIS call (e.g. `"bug-matcher"`,
     * `"assert"`), not the flow it belongs to.
     */
    getModel(options: ModelOptions<DiffsModelName>): LanguageModel;

    /** The collector that owns every cost record produced through this session. */
    readonly costCollector: CostCollector;
}

let registrySingleton: ModelRegistry<DiffsModelName> | undefined;

/**
 * Lazily build and memoize the singleton diffs {@link ModelRegistry}.
 *
 * The registry holds only static data (model instances + pricing), both immutable, so it is
 * constructed once and shared across every session.
 */
function getDiffsModelRegistry(): ModelRegistry<DiffsModelName> {
    if (registrySingleton == null) {
        const logger = rootLogger.child({ name: "getDiffsModelRegistry" });
        logger.info("Constructing singleton diffs model registry");
        registrySingleton = new ModelRegistry<DiffsModelName>({
            models: {
                "smart-visual": MODEL_ENTRIES.GEMINI_3_FLASH_PREVIEW,
            },
        });
    }

    return registrySingleton;
}

/**
 * Open a fresh, metered model session over the singleton diffs registry.
 *
 * Each call creates a new {@link CostCollector} and returns a {@link ModelSession.getModel} bound to
 * meter every acquisition into that collector. The session owns its collector - there is no
 * external-collector injection.
 */
export function openModelSession(): ModelSession {
    const logger = rootLogger.child({ name: "openModelSession" });
    logger.info("Opening diffs model session");

    const registry = getDiffsModelRegistry();
    const costCollector = new CostCollector();

    return {
        getModel: (options) => registry.getModel(options, costCollector),
        costCollector,
    };
}
