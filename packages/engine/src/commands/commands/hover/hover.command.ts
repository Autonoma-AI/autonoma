import type { PointDetector } from "@autonoma/visual-ai";
import type { BaseCommandContext, MouseDriver } from "../../../platform";
import { Command } from "../../command";
import type { CommandParams } from "../../command-spec";
import { type HoverCommandSpec, hoverParamsSchema } from "./hover.def";

export interface HoverCommandContext extends BaseCommandContext {
    mouse: MouseDriver & Required<Pick<MouseDriver, "hover">>;
}

export class HoverCommand extends Command<HoverCommandSpec, HoverCommandContext> {
    public readonly interaction = "hover" as const;

    public get paramsSchema() {
        return hoverParamsSchema;
    }

    constructor(protected readonly pointDetector: PointDetector) {
        super();
    }

    async execute(params: CommandParams<HoverCommandSpec>, { screen, mouse }: HoverCommandContext) {
        const { description } = params;
        this.logger.info("Executing hover command", { description });

        // Take screenshot
        this.logger.info("Taking screenshot of the page...");
        const screenshot = await screen.screenshot();

        // Detect point using AI
        this.logger.info("Detecting point...", { description });
        const point = await this.pointDetector.detectPoint(screenshot, description);
        this.logger.info("Point detected", { point });

        // Hover on the point
        this.logger.info("Hovering on the point...", { point });
        await mouse.hover(point.x, point.y);
        this.logger.info("Hover completed");

        return {
            outcome: `Hovered at (${point.x}, ${point.y})`,
            point,
        };
    }
}
