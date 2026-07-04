import { logger as rootLogger } from "@autonoma/logger";
import { Output, generateText, stepCountIs } from "ai";
import { withRetry } from "../retry";
import type { ReconcileDeps } from "./dependencies";
import { RECONCILE_SYSTEM_PROMPT, buildReconcilePrompt } from "./prompt";
import { ReconciliationForModel, type ReconciliationResult, toReconciliationResult } from "./schema";
import { buildReconcileTools } from "./tools";

// Modest budgets: reconciliation reads short finding bodies + a little code, so the loop is cheap. Each leg
// retries at most twice, keeping the worst case inside the activity's start-to-close timeout.
const INVESTIGATION_TIMEOUT_MS = 6 * 60_000;
const DECISION_TIMEOUT_MS = 3 * 60_000;
const MODEL_CALL_TRIES = 2;

/**
 * Reconcile a run's findings with a tool-using agent: it scans the finding index, reads the ones that might share
 * a cause, confirms against the cloned code where needed, and returns the groups that describe the SAME underlying
 * issue (each with a combined, richer narrative). Analysis only - it never writes; the caller applies the merges.
 * With fewer than two findings there is nothing to reconcile. Never throws: a model failure is contained and
 * returns "no merges" so a reconciliation problem can never sink the report.
 */
export async function reconcileFindings(deps: ReconcileDeps): Promise<ReconciliationResult> {
    const logger = rootLogger.child({ name: "reconcileFindings", extra: { findings: deps.findings.length } });

    if (deps.findings.length < 2) {
        logger.info("Fewer than two findings; nothing to reconcile");
        return { merges: [] };
    }

    logger.info("Reconciling findings", { extra: { hasCodebase: deps.codebase != null } });
    const validIds = new Set(deps.findings.map((finding) => finding.id));

    try {
        // Build the tools fresh per attempt so each retry starts with a fresh code-tool budget - a shared budget
        // would carry its spent counter across attempts and leave a retry depleted.
        const investigation = await withRetry(
            () =>
                generateText({
                    model: deps.model,
                    system: RECONCILE_SYSTEM_PROMPT,
                    tools: buildReconcileTools(deps),
                    stopWhen: stepCountIs(deps.maxSteps),
                    prompt: buildReconcilePrompt(deps.findings),
                    abortSignal: AbortSignal.timeout(INVESTIGATION_TIMEOUT_MS),
                }),
            { label: "reconcile-investigation", tries: MODEL_CALL_TRIES },
        );

        // A tool loop that exhausts its step budget mid-tool-call ends on a tool step, so `.text` is empty. The
        // decision leg deliberately works from these reasoned notes ALONE, never the raw finding index - the
        // headlines lie (identical boilerplate across distinct causes), so feeding them in makes the model over-
        // merge on surface similarity. With no notes there is nothing to decide from, so we bail to "no merges"
        // with a warn - making a budget exhaustion visible instead of letting it masquerade as "nothing to merge".
        const investigationNotes = investigation.text.trim();
        if (investigationNotes === "") {
            logger.warn(
                "Investigation leg produced no notes (likely step-budget exhaustion); reporting findings unmerged",
            );
            return { merges: [] };
        }

        const decision = await withRetry(
            () =>
                generateText({
                    model: deps.model,
                    system: RECONCILE_SYSTEM_PROMPT,
                    output: Output.object({ schema: ReconciliationForModel }),
                    prompt: [
                        "Based on your investigation below, list the merges you are confident about.",
                        "Only group findings with the SAME underlying cause; return an empty list if none do.",
                        "",
                        "--- your investigation ---",
                        investigationNotes,
                    ].join("\n"),
                    abortSignal: AbortSignal.timeout(DECISION_TIMEOUT_MS),
                }),
            { label: "reconcile-decision", tries: MODEL_CALL_TRIES },
        );

        const result = toReconciliationResult(decision.output, validIds);
        logger.info("Reconciliation decided", {
            extra: {
                merges: result.merges.length,
                absorbed: result.merges.reduce((sum, merge) => sum + merge.memberIds.length - 1, 0),
            },
        });
        return result;
    } catch (error) {
        logger.warn("Reconciliation failed; reporting findings unmerged", { err: error });
        return { merges: [] };
    }
}
