import type { PointDetector, VisualConditionChecker } from "@autonoma/visual-ai";
import type { BaseCommandContext, MouseDriver } from "../../../platform";
import { Command } from "../../command";
import type { CommandParams } from "../../command-spec";
import { type ScrollCommandSpec, scrollParamsSchema } from "./scroll.def";

const SETTLE_DELAY_MS = 500;

export interface ScrollCommandContext extends BaseCommandContext {
    mouse: MouseDriver;
}

function wait(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export class ScrollConditionNotMetError extends Error {
    constructor(
        public readonly condition: string,
        public readonly scrollsPerformed: number,
        public readonly lastReason: string,
    ) {
        super(
            `The scroll condition "${condition}" was not met after ${scrollsPerformed} scroll(s). Last reason: ${lastReason}.`,
        );
    }
}

const DEFAULT_MAX_SCROLLS = 10;

export class ScrollCommand extends Command<ScrollCommandSpec, ScrollCommandContext> {
    public readonly interaction = "scroll" as const;
    public readonly paramsSchema = scrollParamsSchema;

    constructor(
        private readonly pointDetector: PointDetector,
        private readonly visualConditionChecker: VisualConditionChecker,
    ) {
        super();
    }

    async execute(
        { elementDescription, direction, condition, maxScrolls: maxScrollsParam }: CommandParams<ScrollCommandSpec>,
        { screen, mouse, application }: ScrollCommandContext,
    ) {
        const maxScrolls = maxScrollsParam ?? DEFAULT_MAX_SCROLLS;
        this.logger.info("Executing scroll command", { elementDescription, direction, condition, maxScrolls });

        const screenshot = await screen.screenshot();
        const point = elementDescription ? await this.pointDetector.detectPoint(screenshot, elementDescription) : null;
        this.logger.info("Scroll target detected", { point });

        let lastReason = null;

        for (let scrollsPerformed = 0; scrollsPerformed <= maxScrolls; scrollsPerformed++) {
            this.logger.info("Checking condition...", { scrollsPerformed, condition });
            const conditionScreenshot = await screen.screenshot();
            const { metCondition, reason } = await this.visualConditionChecker.checkCondition(
                condition,
                conditionScreenshot,
            );
            lastReason = reason;

            if (metCondition) {
                this.logger.info("Scroll condition met", { scrollsPerformed, reason });
                return {
                    outcome: `Condition met after ${scrollsPerformed} scroll(s): ${reason}`,
                    conditionMet: true,
                    scrollsPerformed,
                    point,
                };
            }

            if (scrollsPerformed < maxScrolls) {
                this.logger.info("Performing scroll", {
                    scrollsPerformed: scrollsPerformed + 1,
                    maxScrolls,
                    direction,
                });
                await mouse.scroll({ point: point ?? undefined, direction });
                await wait(SETTLE_DELAY_MS);
                await application.waitUntilStable();
            }
        }

        this.logger.warn("Scroll condition not met after max scrolls", { maxScrolls, condition });
        throw new ScrollConditionNotMetError(condition, maxScrolls, lastReason ?? "No reason provided");
    }
}
