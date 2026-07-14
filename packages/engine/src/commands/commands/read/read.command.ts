import type { TextExtractor } from "@autonoma/visual-ai";
import type { BaseCommandContext } from "../../../platform";
import { Command } from "../../command";
import type { CommandParams } from "../../command-spec";
import { type ReadCommandSpec, readParamsSchema } from "./read.def";

export class ReadCommand extends Command<ReadCommandSpec, BaseCommandContext> {
    public readonly interaction = "read" as const;
    public readonly paramsSchema = readParamsSchema;

    constructor(private readonly textExtractor: TextExtractor) {
        super();
    }

    async execute(
        { description, variableName }: CommandParams<ReadCommandSpec>,
        { screen }: BaseCommandContext,
    ): Promise<ReadCommandSpec["output"]> {
        this.logger.info("Extracting text from screen", { description, variableName });

        const screenshot = await screen.screenshot();
        const { value } = await this.textExtractor.extractText(description, screenshot);

        this.logger.info("Text extracted successfully", { variableName, value });

        return {
            outcome: `Read "${value}" and stored as "{{${variableName}}}"`,
            value,
        };
    }
}
