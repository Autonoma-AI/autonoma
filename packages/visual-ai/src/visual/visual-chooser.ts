import { ObjectGenerator, type LanguageModel } from "@autonoma/ai";
import type { BoundingBox, Screenshot } from "@autonoma/image";
import z from "zod";

interface VisualChoosingOption {
    boundingBox: BoundingBox;
    description?: string;
}

interface VisualChoosingInput<TOption> {
    options: [TOption, ...TOption[]];
    instruction: string;
    screenshot: Screenshot;
}

const visualChoosingSchema = z.object({
    reasoning: z.string().describe("The reasoning for choosing the element, or why you couldn't choose any element"),
    success: z.boolean().describe("Whether you were able to choose an element"),
    index: z.number().nullable().describe("The index of the element to click, if any"),
});
type VisualChooseModelResult = z.infer<typeof visualChoosingSchema>;

async function prepareVisualChoosingInput<TOption extends VisualChoosingOption>({
    options,
    instruction,
    screenshot,
}: VisualChoosingInput<TOption>) {
    const allOptionsHaveDescription = options.every((option) => option.description != null);

    const markedScreenshot = await screenshot.drawBoundingBoxes(
        options.map((option) => option.boundingBox) as [BoundingBox, ...BoundingBox[]],
        { labelled: true },
    );

    return {
        userPrompt: `The user instruction is: ${instruction}${
            allOptionsHaveDescription
                ? `

The options are: ${options.map((option, index) => `- ${index + 1}: ${option.description}`).join("\n")}`
                : ""
        }`,
        image: markedScreenshot,
    };
}

export const DEFAULT_VISUAL_CHOOSING_SYSTEM_PROMPT = `You are a UI analysis expert. You will receive an image with multiple marked elements, along with a user instruction asking you to click on a
specific element. Your task is to determine which of the elements the user wants to click on, if any.

Your task is to choose the element that matches more closely with the user instruction. In order to choose, we'll assign numbers to each element
and mark them in the image with colored boxes. The number will appear on the top right corner of each box, with the same color as the box.

Keep in mind that the user will never ask you to click on a specific box, since they have no context about the boxes and the indices.
So if the user asks you to click something related to numbers (like a keypad), assume there's something in the UI with numbers and
identify the index of the element that matches more closely.

If the user instruction does not refer to one of the marked elements, return \`null\` for the \`index\` and \`success\` should be \`false\`.`;

export class NoValidOptionFoundError extends Error {
    constructor(public readonly reasoning: string) {
        super(`No valid option found. Reasoning: ${reasoning}`);
    }
}

export class InvalidIndexError extends Error {
    constructor(
        public readonly index: number,
        public readonly optionsLength: number,
    ) {
        super(`Invalid index returned by model: ${index}. There were ${optionsLength} options.`);
    }
}

export interface VisualChooserConfig {
    model: LanguageModel;

    /** The system prompt to use for the model. Defaults to {@link DEFAULT_VISUAL_CHOOSING_SYSTEM_PROMPT} */
    systemPrompt?: string;
}

export interface VisualChooserOptions<TOption extends VisualChoosingOption> {
    options: [TOption, ...TOption[]];
    instruction: string;
    screenshot: Screenshot;
}

export class VisualChooser {
    private readonly choiceGenerator: ObjectGenerator<VisualChooseModelResult>;

    constructor(config: VisualChooserConfig) {
        this.choiceGenerator = new ObjectGenerator({
            model: config.model,
            schema: visualChoosingSchema,
            systemPrompt: config.systemPrompt ?? DEFAULT_VISUAL_CHOOSING_SYSTEM_PROMPT,
        });
    }

    async chooseOption<TOption extends VisualChoosingOption>({
        options,
        instruction,
        screenshot,
    }: VisualChooserOptions<TOption>): Promise<{
        reasoning: string;
        option: TOption;
    }> {
        const { userPrompt, image } = await prepareVisualChoosingInput({
            options,
            instruction,
            screenshot,
        });

        const result = await this.choiceGenerator.generate({
            userPrompt,
            images: [image],
        });

        const { reasoning, success, index } = result;

        if (!success || index == null) throw new NoValidOptionFoundError(reasoning);

        const option = options[index - 1];
        if (option == null) throw new InvalidIndexError(index, options.length);

        return { reasoning, option };
    }
}
