import type { TypeCommandContext, TypeCommandSpec } from "../../../../commands";
import { CommandTool } from "../command-tool";

export class TypeTool extends CommandTool<TypeCommandSpec, TypeCommandContext> {
    protected inputSchema() {
        return this.command.paramsSchema;
    }

    description(): string {
        return (
            "Focus-click on an input element and type text into it. " +
            "Internally, this tool uses a visual point detector to find the exact pixel for the focus click from your description — " +
            "if that pixel lands on a border, padding, label, or inactive overlay rather than the interactive text area, " +
            "the field will not receive focus and the typing will silently fail, leaving the field empty. " +
            "Always describe the interactive region precisely (e.g. 'the white text area inside the chat input, left of the send button') " +
            "rather than the surrounding container or label. " +
            "If overwrite is enabled, all existing text is selected before typing so the new text replaces it."
        );
    }

    protected async extractParams(input: TypeCommandSpec["params"]) {
        return {
            description: input.description,
            text: input.text,
            overwrite: input.overwrite,
        };
    }
}
