import { db } from "@autonoma/db";
import type { Logger } from "@autonoma/logger";
import type { AnalysisTestOrigin } from "@autonoma/types";
import type { AnalysisInvestigationTarget } from "@autonoma/workflow/activities";

/** One queued generation the stage is responsible for, before it is resolved to an Investigator target. */
export interface MaterializedTarget {
    generationId: string;
    reason: string;
    origin: AnalysisTestOrigin;
}

/**
 * Resolve each materialized generation to its test + scenario + architecture (one read).
 *
 * Every materialized target must resolve. A target that silently left the run set here would leave the run free to
 * report a verdict over a test it never ran, which is the one outcome the analysis pipeline must never produce - so
 * anything unresolvable fails the run instead.
 */
export async function resolveTargets(
    materialized: MaterializedTarget[],
    logger: Logger,
): Promise<AnalysisInvestigationTarget[]> {
    if (materialized.length === 0) {
        logger.info("Impact Analysis materialized no targets");
        return [];
    }

    const rows = await db.testGeneration.findMany({
        where: { id: { in: materialized.map((entry) => entry.generationId) } },
        select: {
            id: true,
            testPlan: {
                select: {
                    scenario: { select: { id: true } },
                    testCase: { select: { id: true, slug: true, application: { select: { architecture: true } } } },
                },
            },
        },
    });
    const rowById = new Map(rows.map((row) => [row.id, row]));

    const targets: AnalysisInvestigationTarget[] = [];
    const claimedTestCaseIds = new Set<string>();
    for (const entry of materialized) {
        const row = rowById.get(entry.generationId);
        if (row == null) {
            // The run set is deduped so nothing here replaces another's generation: reaching this means something
            // outside the stage deleted it.
            throw new Error(`Generation ${entry.generationId} was deleted while Impact Analysis was selecting targets`);
        }
        if (row.testPlan.testCase.application.architecture !== "WEB") {
            // The Investigator runs web generations only, and `openAnalysisRun` refuses a non-web application before a
            // run is opened - so a non-web target here means that gate was bypassed.
            throw new Error(
                `Test "${row.testPlan.testCase.slug}" belongs to a non-web application (${row.testPlan.testCase.application.architecture})`,
            );
        }
        // One target per test, enforced where the three sources of the run set meet (merge imports, the agent's
        // selection, re-verified issue tests). Each guards itself upstream, so a collision means one of those guards
        // failed - and two Investigators on one test would race for its single `(snapshot, testCase)` finding row.
        // The redundant generation is left pending and swept by the run's settlement.
        if (claimedTestCaseIds.has(row.testPlan.testCase.id)) {
            logger.warn("Two generations were queued for one test; investigating it once", {
                extra: { slug: row.testPlan.testCase.slug, generationId: entry.generationId },
            });
            continue;
        }
        claimedTestCaseIds.add(row.testPlan.testCase.id);
        targets.push({
            slug: row.testPlan.testCase.slug,
            testCaseId: row.testPlan.testCase.id,
            testGenerationId: entry.generationId,
            scenarioId: row.testPlan.scenario?.id,
            reason: entry.reason,
            origin: entry.origin,
        });
    }
    return targets;
}
