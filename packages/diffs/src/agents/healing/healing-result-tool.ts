import { FixableToolError, ReportResultTool } from "@autonoma/ai";
import { z } from "zod";
import type { HealingResult } from "./healing-agent";
import type { HealingAgentLoop } from "./healing-agent-loop";

const healingResultInputSchema = z.object({
    reasoning: z
        .string()
        .min(1)
        .describe(
            "One-paragraph summary of what you did: which patterns you found, which tests were updated/quarantined/removed, which bugs were reported, which candidates you accepted or rejected, and why. Goes into the audit trail.",
        ),
    rejectedCandidates: z
        .array(
            z.object({
                candidateId: z.string().describe("The `candidate` id from the Test Candidates list that you rejected"),
                reasoning: z
                    .string()
                    .min(1)
                    .describe("Why this candidate was not turned into a test (e.g. duplicate coverage, out of scope)"),
            }),
        )
        .optional()
        .describe(
            "Every candidate you decided NOT to accept via `add_test`, each with a short reason. " +
                "Do not include candidates you accepted. Omit when there were no candidates.",
        ),
});

type HealingResultInput = z.infer<typeof healingResultInputSchema>;

class UnhandledFailuresError extends FixableToolError {
    constructor(public readonly keys: readonly string[]) {
        super(
            `Failure(s) not handled: ${keys.join(", ")}. Each must be addressed by update_plan, report_bug, report_engine_limitation, or remove_test before finishing.`,
        );
    }
}

class UndecidedCandidatesError extends FixableToolError {
    constructor(public readonly candidateIds: readonly string[]) {
        super(
            `Candidate(s) not decided: ${candidateIds.join(", ")}. Each candidate must either be accepted with add_test (referencing its id) or listed in rejectedCandidates before finishing.`,
        );
    }
}

class UnknownRejectedCandidateError extends FixableToolError {
    constructor(public readonly candidateIds: readonly string[]) {
        super(
            `rejectedCandidates references unknown candidate id(s): ${candidateIds.join(", ")}. Only list ids from the Test Candidates list.`,
        );
    }
}

class ContradictoryCandidateError extends FixableToolError {
    constructor(public readonly candidateIds: readonly string[]) {
        super(
            `Candidate(s) both accepted via add_test and listed in rejectedCandidates: ${candidateIds.join(", ")}. A candidate is either accepted or rejected, not both.`,
        );
    }
}

/**
 * Terminal tool for the {@link HealingAgent}. Enforces a conjunction before
 * letting the agent finish: every failure key must have a corresponding action,
 * AND every candidate must be decided (accepted via `add_test` referencing it,
 * or listed in `rejectedCandidates`). With no candidates the second clause is
 * vacuously satisfied, so iterations without candidates are unaffected.
 */
export class HealingResultTool extends ReportResultTool<HealingResultInput, HealingResult, HealingAgentLoop> {
    constructor() {
        super({
            name: "finish",
            description:
                "Call this when you have addressed every failure and decided every candidate. The call is rejected if any failure is unhandled (update_plan / report_bug / report_engine_limitation / remove_test) or any candidate is left undecided (accepted via add_test or listed in rejectedCandidates).",
            inputSchema: healingResultInputSchema,
        });
    }

    async buildResult(input: HealingResultInput, loop: HealingAgentLoop): Promise<HealingResult> {
        const unhandled = loop.unhandledFailureKeys();
        if (unhandled.length > 0) throw new UnhandledFailuresError(unhandled);

        const rejectedCandidates = input.rejectedCandidates ?? [];
        const rejectedIds = new Set(rejectedCandidates.map((c) => c.candidateId));

        const unknownRejected = [...rejectedIds].filter((id) => !loop.candidatesById.has(id));
        if (unknownRejected.length > 0) throw new UnknownRejectedCandidateError(unknownRejected);

        const contradictory = [...rejectedIds].filter((id) => loop.claimedCandidateIds.has(id));
        if (contradictory.length > 0) throw new ContradictoryCandidateError(contradictory);

        const undecided = [...loop.candidatesById.keys()].filter(
            (id) => !loop.claimedCandidateIds.has(id) && !rejectedIds.has(id),
        );
        if (undecided.length > 0) throw new UndecidedCandidatesError(undecided);

        return {
            actions: [...loop.actions],
            newTests: [...loop.newTests],
            rejectedCandidates,
            reasoning: input.reasoning,
        };
    }
}
