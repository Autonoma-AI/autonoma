import { type LanguageModel, ObjectGenerator } from "@autonoma/ai";
import type { Screenshot } from "@autonoma/image";
import { type Logger, logger } from "@autonoma/logger";
import z from "zod";
import type { CommandSpec, StepData } from "../../../commands";

export interface WaitPlannerConfig {
    /**
     * The model that will perform the wait planning.
     *
     * Must be capable of visual reasoning, since it will receive screenshots to analyze.
     */
    model: LanguageModel;
}

const waitUntilSchema = z.object({
    reasoning: z.string().describe("An explanation of why you chose the given wait condition."),
    condition: z.string().describe("A natural language description of the condition to wait for on the page."),
});
export type WaitUntilPlanningOutput = z.infer<typeof waitUntilSchema>;

export interface WaitPlannerInput<TSpec extends CommandSpec> {
    prevStep: StepData<TSpec>;
    prevScreenshot: Screenshot;
    newStep: StepData<TSpec>;
    newScreenshot: Screenshot;
}

const WAIT_UNTIL_PLANNING_SYSTEM_PROMPT = `You are a website interaction expert, part of a QA automation pipeline. A different AI agent has generated a step within a test case, and you are tasked with determining a wait condition to add before it.

You will receive the following information:
- A description of the previous step executed by the agent.
- A description of the new step executed.
- A screenshot of the page right after the previous step was executed.
- A screenshot of the page right before executing the new step.

For the instruction generated, follow these guidelines:
- The wait condition you generate will be added BEFORE the new step, so it should describe the state of the page needed to execute its action.
- Strike a balance between being specific and being concise.
- Avoid using dynamic/user-generated data in the instruction. We are creating a test in a live staging environment, and the data may change over time.
  - This is VERY IMPORTANT: especially in list-type interactions, avoid naming specific items in the list, unless it is explicitly referred to in the step parameters.

## Examples

### Example 1

The previous screenshot shows a dashboard, and the previous step was to click on a 'New Transaction' button. The next screenshot shows a form to create a new transaction, and the new step is to fill the "Amount" field with the value "100".

Expected result: { "reasoning": "The new step requires filling the 'Amount' field with the value '100', so we need to wait until the form is loaded and the field is visible.", "condition": "the new transaction form is loaded and the 'Amount' field is visible" }

### Example 2

The previous screenshot shows a search results page with a list of products, and the previous step was to click on a 'Filter' button. The next screenshot shows a filter panel that has appeared on the side, and the new step is to select the "Price Range" option from the filter panel.

Expected result: { "reasoning": "The new step requires selecting the 'Price Range' option from the filter panel, so we need to wait until the filter panel is fully loaded and the options are visible.", "condition": "the filter panel is loaded and the 'Price Range' option is visible" }

### Example 3

The previous screenshot shows a login page, and the previous step was to fill the "Email" field with "user@example.com". The next screenshot shows the same login page but with the email field filled, and the new step is to click on the "Submit" button.

Expected result: { "reasoning": "The new step requires clicking the 'Submit' button, so we need to wait until the button is enabled and clickable after the email field has been filled.", "condition": "the 'Submit' button is enabled and clickable" }`;

const REPLAN_WAIT_SYSTEM_PROMPT = `You are a website interaction expert, part of a QA automation pipeline. A wait condition was generated for a test step, but it was rejected because it does not match the actual state of the UI in the screenshot.

You will receive:
- A description of the previous step and a screenshot taken after it executed.
- A description of the new step and a screenshot taken before it executes.
- The condition that was tried and rejected.
- The reason it was rejected.

Generate a corrected wait condition that:
- Accurately describes what is visible in the screenshots at the moment the new step is about to execute.
- Does NOT repeat the mistake described in the failure reason.
- Follows the same guidelines as the original: be specific but concise, avoid dynamic data.

If no meaningful condition can be derived from the screenshots, set condition to an empty string.`;

export interface ReplanWaitInput<TSpec extends CommandSpec> extends WaitPlannerInput<TSpec> {
    failedCondition: string;
    failureReason: string;
}

/**
 * The wait planner creates `wait-until` steps in between agent-generated steps.
 */
export class WaitPlanner<TSpec extends CommandSpec> {
    private readonly logger: Logger;

    private readonly waitPlanGenerator: ObjectGenerator<WaitUntilPlanningOutput>;
    private readonly replanGenerator: ObjectGenerator<WaitUntilPlanningOutput>;

    constructor({ model }: WaitPlannerConfig) {
        this.logger = logger.child({
            name: this.constructor.name,
        });
        this.waitPlanGenerator = new ObjectGenerator({
            model,
            schema: waitUntilSchema,
            systemPrompt: WAIT_UNTIL_PLANNING_SYSTEM_PROMPT,
        });
        this.replanGenerator = new ObjectGenerator({
            model,
            schema: waitUntilSchema,
            systemPrompt: REPLAN_WAIT_SYSTEM_PROMPT,
        });
    }

    private shouldWait(_step: StepData<TSpec>): boolean {
        // For now, add a wait for all steps
        // Maybe in the future, steps that can reliably wait (like clicks) can be identified and skipped
        return true;
    }

    /** Generate a wait condition in between the given 2 steps */
    private async generateCondition({
        prevStep,
        prevScreenshot,
        newStep,
        newScreenshot,
    }: WaitPlannerInput<TSpec>): Promise<string> {
        this.logger.info("Planning wait in between steps", {
            prev: prevStep.interaction,
            new: newStep.interaction,
        });

        const { reasoning, condition } = await this.waitPlanGenerator.generate({
            userPrompt: JSON.stringify({ prevStep, newStep }),
            images: [prevScreenshot, newScreenshot],
        });

        this.logger.info("Wait plan generated", { condition, reasoning });

        return condition;
    }

    /** Generates a wait condition for the given step, if needed */
    async planWait({
        prevStep,
        prevScreenshot,
        newStep,
        newScreenshot,
    }: WaitPlannerInput<TSpec>): Promise<string | null> {
        if (!this.shouldWait(newStep)) {
            this.logger.info("No wait needed for step", { step: newStep.interaction });
            return null;
        }

        return this.generateCondition({ prevStep, prevScreenshot, newStep, newScreenshot });
    }

    /**
     * Derives a wait condition for the very first step of a test, where there is no previous step
     * to compare against. Synchronous and deterministic - no LLM call. Returns null when no useful
     * pre-wait can be derived (e.g. assertions, unknown commands).
     */
    async replanWait({
        prevStep,
        prevScreenshot,
        newStep,
        newScreenshot,
        failedCondition,
        failureReason,
    }: ReplanWaitInput<TSpec>): Promise<string | null> {
        this.logger.info("Replanning wait condition after validation failure", {
            interaction: newStep.interaction,
            failedCondition,
            failureReason,
        });

        const { reasoning, condition } = await this.replanGenerator.generate({
            userPrompt: JSON.stringify({ prevStep, newStep, failedCondition, failureReason }),
            images: [prevScreenshot, newScreenshot],
        });

        this.logger.info("Wait condition replanned", { condition, reasoning });

        return condition.trim().length > 0 ? condition : null;
    }

    public planFirstWait(step: StepData<TSpec>): string | null {
        const params = step.params as Record<string, unknown>;
        const description = typeof params.description === "string" ? params.description : undefined;

        const condition = (() => {
            switch (step.interaction) {
                case "click":
                case "hover":
                    return description != null
                        ? `the element described as "${description}" is visible and interactable`
                        : null;
                case "type":
                    return description != null
                        ? `the input field described as "${description}" is visible and editable`
                        : null;
                case "scroll":
                    return "the page is loaded and scrollable";
                default:
                    return null;
            }
        })();

        this.logger.info("First-step wait condition derived", { interaction: step.interaction, condition });
        return condition;
    }
}
