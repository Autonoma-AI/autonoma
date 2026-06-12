import type { Point } from "@autonoma/image";
import z from "zod";

export interface TypeCommandSpec {
    interaction: "type";
    params: { description: string; text: string; overwrite: boolean };
    output: { outcome: string; point: Point; text: string };
}

export const typeParamsSchema = z.object({
    description: z
        .string()
        .describe(
            "A precise description of the interactive text area to focus-click before typing. " +
                "This is fed directly into a visual point detector that picks a single pixel to click — " +
                "describe the inner text area specifically (e.g. 'the white text area inside the chat input box, left of the send button'), " +
                "not the outer container, placeholder label, or any icon next to it. " +
                "A vague description that matches the border or a surrounding element will cause a silent typing failure.",
        ),
    text: z.string().describe("The text to type into the element."),
    overwrite: z
        .boolean()
        .default(false)
        .describe("If true, select all existing text before typing so the new text replaces it."),
});
