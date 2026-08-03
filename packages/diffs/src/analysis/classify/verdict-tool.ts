import { ReportResultTool } from "@autonoma/ai";
import { RunVerdict } from "../schema";
import type { ClassifierAgentLoop } from "./classifier-agent-loop";
import { VerdictForModel } from "./verdict-schema";

/**
 * The classifier's terminal tool: the model fills the flat verdict schema and the loop finishes.
 *
 * Deliberately gate-free: Zod is the only contract, with no evidence or re-run-discipline check on top. Verdict
 * discipline lives in the prompt, which is where it can explain itself; a structural gate would only teach the
 * model to satisfy the gate. Revisit that only with production evidence of false positives reaching a finding.
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
        return RunVerdict.parse(input);
    }
}
