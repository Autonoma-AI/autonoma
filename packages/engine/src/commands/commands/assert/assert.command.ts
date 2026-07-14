import type { AssertionSplitter } from "@autonoma/ai";
import type { Screenshot } from "@autonoma/image";
import type { AssertChecker } from "@autonoma/visual-ai";
import type { BaseCommandContext } from "../../../platform";
import { Command } from "../../command";
import type { CommandParams } from "../../command-spec";
import { type AssertCommandSpec, type AssertionResult, assertParamsSchema } from "./assert.def";

export class AssertionFailedError extends Error {
    constructor(public readonly failedAssertions: AssertionResult[]) {
        const message = `Assertion${failedAssertions.length > 1 ? "s" : ""} failed:\n${failedAssertions.map(({ assertion, reason }) => `- ${assertion}: ${reason}`).join("\n")}`;
        super(message);
    }
}

export class AssertCommand extends Command<AssertCommandSpec, BaseCommandContext> {
    public readonly interaction = "assert" as const;
    public readonly paramsSchema = assertParamsSchema;

    constructor(
        private readonly assertChecker: AssertChecker,
        private readonly assertionSplitter: AssertionSplitter,
    ) {
        super();
    }

    private async checkAssertion(assertion: string, screenshot: Screenshot): Promise<AssertionResult> {
        const result = await this.assertChecker.checkCondition(assertion, screenshot);

        const output: AssertionResult = {
            assertion,
            metCondition: result.metCondition,
            reason: result.reason,
        };

        const icon = result.metCondition ? "pass" : "fail";
        this.logger.info(`Assertion result: ${icon}`, {
            assertion,
            metCondition: result.metCondition,
            reason: result.reason,
        });

        return output;
    }

    async execute({ instruction }: CommandParams<AssertCommandSpec>, { screen }: BaseCommandContext) {
        this.logger.info("Executing assert command", { instruction });

        // Split instruction into individual assertions
        this.logger.info("Splitting instruction into individual assertions...");
        const { assertions } = await this.assertionSplitter.splitAssertions(instruction);
        this.logger.info("Found assertions", { assertionCount: assertions.length, assertions });

        // Take screenshot once for all assertions
        this.logger.info("Taking screenshot of the page...");
        const screenshot = await screen.screenshot();

        // Evaluate all assertions in parallel
        this.logger.info("Evaluating all assertions in parallel...");
        const results = await Promise.all(assertions.map((assertion) => this.checkAssertion(assertion, screenshot)));

        // Log summary
        const allPassed = results.every((r) => r.metCondition);
        const passedCount = results.filter((r) => r.metCondition).length;
        this.logger.info("Assertion summary", {
            total: results.length,
            passed: passedCount,
            failed: results.length - passedCount,
            allPassed,
        });

        // Return failure if any assertion failed
        if (!allPassed) {
            const failedAssertions: AssertionResult[] = results.filter((r) => !r.metCondition);
            throw new AssertionFailedError(failedAssertions);
        }

        return {
            outcome: `All ${results.length} assertion(s) passed`,
            results,
        };
    }
}
