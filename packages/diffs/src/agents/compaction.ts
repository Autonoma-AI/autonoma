import { RedactOldToolResults, type AgentConfig } from "@autonoma/ai";

/**
 * Token budget for the previous step's input before compaction trims. Sized to leave headroom for the next
 * step on top of a vision-heavy history.
 */
const COMPACTION_TOKEN_THRESHOLD = 700_000;

/** Number of most recent tool round-trips to keep in full when compaction fires. */
const COMPACTION_KEEP_RECENT_TOOL_RESULTS = 2;

/**
 * The compaction policy every long-running agent in this package shares.
 *
 * One definition rather than a copy per agent: the three that use it (classifier, Reporter, healing) are meant
 * to behave identically here, and three copies of a pair of magic numbers drift the moment one is tuned in
 * isolation - silently, since nothing fails when they disagree.
 */
export function sharedCompactor(): AgentConfig<unknown>["compactor"] {
    return {
        strategy: new RedactOldToolResults(COMPACTION_KEEP_RECENT_TOOL_RESULTS),
        threshold: COMPACTION_TOKEN_THRESHOLD,
    };
}
