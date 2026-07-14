import type { PointDetector } from "@autonoma/visual-ai";
import type { BaseCommandContext, KeyboardDriver, MouseDriver } from "../../../platform";
import { Command } from "../../command";
import type { CommandParams } from "../../command-spec";
import { type TypeCommandSpec, typeParamsSchema } from "./type.def";

export interface TypeCommandContext extends BaseCommandContext {
    mouse: MouseDriver;
    keyboard: KeyboardDriver;
}

export class TypeCommand extends Command<TypeCommandSpec, TypeCommandContext> {
    public readonly interaction = "type" as const;
    public readonly paramsSchema = typeParamsSchema;

    constructor(private readonly pointDetector: PointDetector) {
        super();
    }

    async execute(
        { description, text, overwrite }: CommandParams<TypeCommandSpec>,
        { screen, mouse, keyboard }: TypeCommandContext,
    ) {
        this.logger.info("Executing type command", {
            description,
            text,
            overwrite,
        });

        // Take screenshot
        this.logger.info("Taking screenshot of the page...");
        const screenshot = await screen.screenshot();

        // Detect point using AI
        this.logger.info("Detecting input element...", { description });
        const point = await this.pointDetector.detectPoint(screenshot, description);
        this.logger.info("Input element detected", { point });

        // Click on the input element
        this.logger.info("Clicking on the input element...", { point });
        await mouse.click(point.x, point.y);
        this.logger.info("Input element clicked");

        // Type the text
        this.logger.info("Typing text...", { text, overwrite });
        await keyboard.type(text, { overwrite });
        this.logger.info("Text typed");

        return {
            outcome: `Typed "${text}" at (${point.x}, ${point.y})`,
            point,
            text,
        };
    }
}
