import type { Screenshot } from "@autonoma/image";
import type { PointDetector } from "@autonoma/visual-ai";
import type { BaseCommandContext, MouseDriver } from "../../../platform";
import { Command } from "../../command";
import type { CommandParams } from "../../command-spec";
import { type DragCommandSpec, dragParamsSchema } from "./drag.def";

export interface DragCommandContext extends BaseCommandContext {
    mouse: MouseDriver;
}

export class DragCommand extends Command<DragCommandSpec, DragCommandContext> {
    public readonly interaction = "drag" as const;
    public readonly paramsSchema = dragParamsSchema;

    constructor(protected readonly pointDetector: PointDetector) {
        super();
    }

    async detectPoint(screenshot: Screenshot, description: string, label: "start" | "end") {
        const point = this.pointDetector.detectPoint(screenshot, description);
        this.logger.info(`${label} point detected`, { point });
        return point;
    }

    async execute(
        { startDescription, endDescription }: CommandParams<DragCommandSpec>,
        { screen, mouse }: DragCommandContext,
    ) {
        this.logger.info("Executing drag command", { startDescription, endDescription });

        this.logger.info("Taking screenshot of the page...");
        const screenshot = await screen.screenshot();

        this.logger.info("Detecting drag points...", { startDescription, endDescription });
        const [startPoint, endPoint] = await Promise.all([
            this.detectPoint(screenshot, startDescription, "start"),
            this.detectPoint(screenshot, endDescription, "end"),
        ]);

        this.logger.info("Dragging from start to end...", { startPoint, endPoint });
        await mouse.drag(startPoint.x, startPoint.y, endPoint.x, endPoint.y);
        this.logger.info("Drag completed");

        return {
            outcome: `Dragged from (${startPoint.x}, ${startPoint.y}) to (${endPoint.x}, ${endPoint.y})`,
            startPoint,
            endPoint,
        };
    }
}
