import { db } from "@autonoma/db";
import {
    LocalCodebaseReader,
    buildFindings,
    persistInvestigationCosts,
    reconcileFindings,
    toReconcilableFindings,
} from "@autonoma/investigation";
import { logger as rootLogger } from "@autonoma/logger";
import type {
    ReconcileInvestigationFindingsInput,
    ReconcileInvestigationFindingsOutput,
} from "@autonoma/workflow/activities";
import { withSnapshotContext } from "../codebase/resolve";
import { env } from "../env";
import { createModelSession } from "../services";
import { toTestReport } from "./write-report";

// A passing test isn't a duplicated problem, and a classification error has no cause to compare - neither is
// reconcilable, so they're filtered out before the agent runs (fewer tokens, a cleaner task).
const NON_RECONCILABLE_CATEGORIES = new Set(["passed", "classification_error"]);

/**
 * Reconcile a run's findings: several tests can surface the SAME underlying issue (one seed gap, one code
 * defect), each producing its own finding. This clones the repo so the agent can confirm two findings point at
 * the same code before merging, runs the reconciliation agent over the run's PROBLEM findings, and returns the
 * merges for the report step to apply. Never mutates. Contained: the agent itself returns "no merges" on any
 * failure, so this activity resolves cleanly and the report is never blocked.
 */
export async function reconcileInvestigationFindings(
    input: ReconcileInvestigationFindingsInput,
): Promise<ReconcileInvestigationFindingsOutput> {
    const { snapshotId, results } = input;
    const logger = rootLogger.child({ name: "reconcileInvestigationFindings", extra: { snapshotId } });

    // Same id authority the report uses (buildFindings), so the merges reference the ids the report will persist.
    const findings = buildFindings(results.map(toTestReport));
    const problems = findings.filter((finding) => !NON_RECONCILABLE_CATEGORIES.has(finding.category));
    logger.info("Reconciling investigation findings", {
        extra: { total: findings.length, reconcilable: problems.length },
    });
    if (problems.length < 2) return { merges: [] };

    return withSnapshotContext(snapshotId, "reconcile", async (context) => {
        const reader = new LocalCodebaseReader(context.codebase.root, context.baseSha, context.headSha);
        const session = createModelSession();
        const result = await reconcileFindings({
            findings: toReconcilableFindings(problems),
            codebase: reader,
            model: session.getModel({ model: "classifier", tag: "investigation-reconcile" }),
            maxSteps: env.INVESTIGATION_CLASSIFY_MAX_STEPS,
        });
        // Cost tracking is auxiliary - a transient DB error here must not discard the merges we already computed
        // (the workflow would report the findings unmerged). Contain it so the reconciliation result always lands.
        try {
            await persistInvestigationCosts(db, snapshotId, session.costCollector, logger);
        } catch (error) {
            logger.warn("Failed to persist reconciliation costs; keeping the computed merges", { err: error });
        }
        logger.info("Investigation findings reconciled", { extra: { merges: result.merges.length } });
        return { merges: result.merges };
    });
}
