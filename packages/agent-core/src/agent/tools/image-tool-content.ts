import type { AgentToolModelOutput } from "./agent-tool";

export type ToolContentItem = Extract<
    Awaited<AgentToolModelOutput<unknown, unknown>>,
    { type: "content" }
>["value"][number];

export interface InlineImage {
    base64: string;
    mediaType: string;
}

/**
 * Put an image in front of the model as PIXELS. Build every frame part through here: the SDK has renamed this
 * content part twice, and a stale spelling is dropped at the provider rather than raised, so the model ends up
 * reasoning about a picture it never saw.
 */
export function imageToolContent({ base64, mediaType }: InlineImage): ToolContentItem {
    return { type: "file", data: { type: "data", data: base64 }, mediaType };
}
