import { logger as rootLogger } from "@autonoma/logger";
import { type LanguageModel, Output, generateText } from "ai";
import { withRetry } from "../retry";
import { buildDiagnosisPrompt, SCENARIO_DIAGNOSER_SYSTEM_PROMPT, type ScenarioFailureInput } from "./prompt";
import { ScenarioDiagnosisForModel, type ScenarioDiagnosis, toScenarioDiagnosis } from "./schema";

// A single structured pass over one failure - no tool loop - so a tight window is plenty; a slow call means an
// overloaded provider, not progress worth waiting on.
const DIAGNOSE_TIMEOUT_MS = 2 * 60_000;

export interface DiagnoseScenarioFailureDeps {
    /** The model that produces the diagnosis (the investigation classifier model). */
    model: LanguageModel;
}

/**
 * Diagnose why a test failed on its seeded scenario data and route the repair (fix the test, edit the recipe, or
 * escalate to a client-factory change), preferring the lowest-risk route. Analysis only - it mutates nothing; the
 * caller decides what to do with the route. A model/parse failure surfaces as `route: "unknown"` so a single
 * diagnosis can never sink the surrounding investigation run.
 */
export async function diagnoseScenarioFailure(
    input: ScenarioFailureInput,
    deps: DiagnoseScenarioFailureDeps,
): Promise<ScenarioDiagnosis> {
    const logger = rootLogger.child({ name: "diagnoseScenarioFailure" });
    logger.info("Diagnosing scenario-data failure");
    try {
        const result = await withRetry(
            () =>
                generateText({
                    model: deps.model,
                    system: SCENARIO_DIAGNOSER_SYSTEM_PROMPT,
                    output: Output.object({ schema: ScenarioDiagnosisForModel }),
                    prompt: buildDiagnosisPrompt(input),
                    abortSignal: AbortSignal.timeout(DIAGNOSE_TIMEOUT_MS),
                }),
            { label: "scenario-diagnose", tries: 2 },
        );
        const diagnosis = toScenarioDiagnosis(result.output);
        logger.info("Scenario failure diagnosed", {
            extra: { route: diagnosis.route, confidence: diagnosis.confidence },
        });
        return diagnosis;
    } catch (error) {
        logger.warn("Scenario diagnosis failed; routing as unknown", { extra: { error: String(error) } });
        return {
            route: "unknown",
            confidence: "low",
            reasoning: `The diagnosis could not be produced: ${String(error)}`,
        };
    }
}
