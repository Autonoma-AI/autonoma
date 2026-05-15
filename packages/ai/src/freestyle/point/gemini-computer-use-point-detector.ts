import { external } from "@autonoma/errors";
import type { ScreenResolution, Screenshot } from "@autonoma/image";
import { Environment, type FunctionCall, GoogleGenAI } from "@google/genai";
import z from "zod";
import { AI_REQUEST_TIMEOUT_MS } from "../../constants";
import { env } from "../../env";
import { GeminiModelRequestFailedError } from "../object/gemini-object-detector";
import { PointDetector } from "./point-detector";

export class GeminiNoToolCallsError extends Error {
    constructor(public readonly instruction: string) {
        super("No tool call was returned by the Gemini model");
    }
}

export class GeminiInvalidToolCallsError extends Error {
    constructor(
        public readonly instruction: string,
        public readonly toolCalls: FunctionCall[],
    ) {
        super(
            `Invalid tool calls were returned by the Gemini model for instruction "${instruction}": ${toolCalls.map((toolCall) => toolCall.name).join(", ")}`,
        );
    }
}

export type GeminiComputerUseToolName =
    | "open_web_browser"
    | "wait_5_seconds"
    | "go_back"
    | "go_forward"
    | "search"
    | "navigate"
    | "click_at"
    | "hover_at"
    | "type_text_at"
    | "key_combination"
    | "scroll_document"
    | "scroll_at"
    | "drag_and_drop";

const EXCLUDED_TOOLS: GeminiComputerUseToolName[] = [
    "open_web_browser",
    "wait_5_seconds",
    "go_back",
    "go_forward",
    "search",
    "navigate",
    "hover_at",
    "type_text_at",
    "key_combination",
    "scroll_document",
    "scroll_at",
    "drag_and_drop",
];

const clickAtToolSchema = z.object({
    name: z.literal("click_at"),
    args: z.object({
        x: z.number(),
        y: z.number(),
    }),
});

const computeUseToolSchema = z.discriminatedUnion("name", [clickAtToolSchema]);
export type GoogleToolCall = z.infer<typeof computeUseToolSchema>;

/**
 * Handles Gemini computer use requests, including the translation of tool call coords (0-1000)
 * to the actual screen resolution
 */
export class GeminiComputerUseModel {
    private readonly googleAI: GoogleGenAI;

    constructor(private readonly systemPrompt: string) {
        this.googleAI = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });
    }

    private preprocessToolCall(toolCall: GoogleToolCall, resolution: ScreenResolution): GoogleToolCall {
        switch (toolCall.name) {
            case "click_at":
                return {
                    name: "click_at",
                    args: {
                        x: Math.round((toolCall.args.x / 1000) * resolution.width),
                        y: Math.round((toolCall.args.y / 1000) * resolution.height),
                    },
                };
        }
    }

    public async request(
        screenshot: Screenshot,
        instruction: string,
        resolution: ScreenResolution,
    ): Promise<GoogleToolCall[]> {
        const response = await external(
            () =>
                this.googleAI.models.generateContent({
                    model: "gemini-2.5-computer-use-preview-10-2025",
                    contents: [
                        {
                            role: "user",
                            parts: [{ text: instruction }],
                        },
                        {
                            role: "user",
                            parts: [
                                {
                                    inlineData: {
                                        data: screenshot.base64,
                                        mimeType: "image/png",
                                    },
                                },
                            ],
                        },
                    ],
                    config: {
                        systemInstruction: this.systemPrompt,
                        abortSignal: AbortSignal.timeout(AI_REQUEST_TIMEOUT_MS),
                        tools: [
                            {
                                computerUse: {
                                    environment: Environment.ENVIRONMENT_BROWSER,
                                    excludedPredefinedFunctions: EXCLUDED_TOOLS,
                                },
                            },
                        ],
                    },
                }),
            { wrapper: (error) => new GeminiModelRequestFailedError(error) },
        );

        if (response.candidates == null || response.candidates.length === 0)
            throw new GeminiModelRequestFailedError(new Error("No response from Gemini model"));

        // biome-ignore lint/style/noNonNullAssertion: Length > 0
        const candidate = response.candidates[0]!;

        const rawToolCalls =
            candidate.content?.parts
                ?.filter((part) => "functionCall" in part && part.functionCall != null)
                // biome-ignore lint/style/noNonNullAssertion: ^^^ part.functionCall != null
                ?.map((part) => part.functionCall!) ?? [];

        if (rawToolCalls.length === 0) throw new GeminiNoToolCallsError(instruction);

        const parseResults = rawToolCalls.map((toolCall) => computeUseToolSchema.safeParse(toolCall));

        if (parseResults.some((result) => !result.success))
            throw new GeminiInvalidToolCallsError(instruction, rawToolCalls);

        return (
            parseResults
                // biome-ignore lint/style/noNonNullAssertion: result.success is true for all results
                .map((result) => result.data!)
                .map((toolCall) => this.preprocessToolCall(toolCall, resolution))
        );
    }
}

export class FreestyleClickNoItemFoundError extends Error {
    constructor(public readonly instruction: string) {
        super(`No item found for instruction "${instruction}"`);
    }
}

export class FreestyleClickToolCallsError extends Error {
    constructor(public readonly instruction: string) {
        super(`Multiple tool calls for instruction "${instruction}"`);
    }
}

export class FreestyleClickNoClickAtToolCallError extends Error {
    constructor(public readonly instruction: string) {
        super(`No click_at tool call for instruction "${instruction}"`);
    }
}

export const DEFAULT_SYSTEM_PROMPT =
    "Your task is to perform a single click on the screen, according to the user's instruction.";

export class GeminiComputerUsePointDetector extends PointDetector {
    private readonly computerUseModel: GeminiComputerUseModel;

    constructor(systemPrompt?: string) {
        super();
        this.computerUseModel = new GeminiComputerUseModel(systemPrompt ?? DEFAULT_SYSTEM_PROMPT);
    }

    protected async detectPointForResolution(
        screenshot: Screenshot,
        prompt: string,
        screenResolution: ScreenResolution,
    ): Promise<{ x: number; y: number }> {
        const toolCalls = await this.computerUseModel.request(screenshot, prompt, screenResolution);

        if (toolCalls.length === 0) throw new FreestyleClickNoItemFoundError(prompt);
        if (toolCalls.length > 1) throw new FreestyleClickToolCallsError(prompt);

        // biome-ignore lint/style/noNonNullAssertion: Length > 0
        const toolCall = toolCalls[0]!;

        if (toolCall.name !== "click_at") throw new FreestyleClickNoClickAtToolCallError(prompt);

        return toolCall.args;
    }
}
