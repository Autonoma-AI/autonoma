import type { PointDetector } from "@autonoma/visual-ai";
import type z from "zod";
import type { BaseCommandContext, MouseDriver } from "../../../platform";
import { Command } from "../../command";
import type { CommandParams } from "../../command-spec";
import { type ClickCommandSpec, clickBaseParamsSchema } from "./click.def";

export interface ClickCommandContext<TClickOptions extends object = Record<string, never>> extends BaseCommandContext {
    mouse: MouseDriver<TClickOptions>;
}

export abstract class ClickCommand<TClickOptions extends object = Record<string, never>> extends Command<
    ClickCommandSpec<TClickOptions>,
    ClickCommandContext<TClickOptions>
> {
    public readonly interaction = "click" as const;

    /** Zod schema for platform-specific click options. */
    protected abstract readonly clickOptionsSchema: z.ZodSchema<TClickOptions>;

    public get paramsSchema() {
        return clickBaseParamsSchema.extend({
            options: this.clickOptionsSchema,
        }) as unknown as z.ZodSchema<CommandParams<ClickCommandSpec<TClickOptions>>>;
    }

    constructor(protected readonly pointDetector: PointDetector) {
        super();
    }

    async execute(
        params: CommandParams<ClickCommandSpec<TClickOptions>>,
        { screen, mouse }: ClickCommandContext<TClickOptions>,
    ) {
        const { description, options } = params;
        this.logger.info("Executing click command", { description, options });

        // Take screenshot
        this.logger.info("Taking screenshot of the page...");
        const screenshot = await screen.screenshot();

        // Detect point using AI
        this.logger.info("Detecting point...", { description });
        const point = await this.pointDetector.detectPoint(screenshot, description);
        this.logger.info("Point detected", { point });

        // Click on the point
        this.logger.info("Clicking on the point...", { point, options });
        await mouse.click(point.x, point.y, options);
        this.logger.info("Click completed");

        return {
            outcome: `Clicked at (${point.x}, ${point.y})`,
            point,
        };
    }
}
