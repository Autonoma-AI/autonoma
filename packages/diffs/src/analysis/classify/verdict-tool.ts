import { ReportResultTool } from "@autonoma/ai";
import type { RunVerdict } from "../schema";
import type { ClassifierAgentLoop } from "./classifier-agent-loop";
import { VerdictForModel, toRunVerdict } from "./verdict-schema";

/**
 * The classifier's terminal tool: the model fills the flat verdict schema and the loop finishes.
 *
 * Deliberately gate-free - it normalizes ({@link toRunVerdict} pipes the flat model shape into the
 * discriminated {@link RunVerdict}) and nothing else. Zod is the ONLY contract here: there is no evidence
 * check, no re-run-discipline check, no "you did not call prior_runs" retry. Verdict discipline lives in
 * the prompt, which is where it can explain itself; a structural gate would only teach the model to satisfy
 * the gate. Revisit that only with production evidence of false positives surviving to a finding.
 */
export class VerdictTool extends ReportResultTool<VerdictForModel, RunVerdict, ClassifierAgentLoop> {
    constructor() {
        super({
            name: "finish",
            description:
                "Commit to the verdict for this run and finish the investigation. Call this once, after you have gathered the evidence your verdict rests on.",
            inputSchema: VerdictForModel,
        });
    }

    async buildResult(input: VerdictForModel): Promise<RunVerdict> {
        return toRunVerdict(input);
    }
}
