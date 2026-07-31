import type { OverlayPoint } from "@autonoma/types";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ViewStepDetailsTool } from "../src/agents/tools/run-evidence/view-step-details-tool";
import { executeTool, type ToolEnvelope } from "./execute-tool";
import { makeReviewerLoop } from "./test-loops";

const WIDTH = 100;
const HEIGHT = 100;

/** A solid-white PNG so any annotation pixel is trivially distinguishable. */
async function whiteScreenshot(): Promise<Buffer> {
    return sharp({
        create: { width: WIDTH, height: HEIGHT, channels: 3, background: { r: 255, g: 255, b: 255 } },
    })
        .png()
        .toBuffer();
}

/** Whether the pixel at (x, y) of a PNG buffer is no longer pure white. */
async function isPixelMarked(png: Buffer, x: number, y: number): Promise<boolean> {
    const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
    const offset = (y * info.width + x) * info.channels;
    const r = data[offset] ?? 255;
    const g = data[offset + 1] ?? 255;
    const b = data[offset + 2] ?? 255;
    return r !== 255 || g !== 255 || b !== 255;
}

const foundSchema = z.object({
    found: z.literal(true),
    stepOrder: z.number(),
    summary: z.string(),
    frames: z.array(z.object({ timing: z.enum(["before", "after"]), base64: z.string(), annotated: z.boolean() })),
});

type FoundResult = z.infer<typeof foundSchema>;

async function viewStep(loop: ReturnType<typeof makeReviewerLoop>): Promise<FoundResult> {
    const envelope = await executeTool<ToolEnvelope<unknown>>(new ViewStepDetailsTool(), { stepOrder: 0 }, loop);
    if (!envelope.success) throw new Error(`Expected success, got error: ${envelope.error}`);
    return foundSchema.parse(envelope.result);
}

function frame(result: FoundResult, timing: "before" | "after") {
    const match = result.frames.find((candidate) => candidate.timing === timing);
    if (match == null) throw new Error(`Expected a ${timing} frame, got ${result.frames.length}`);
    return match;
}

describe("ViewStepDetailsTool", () => {
    const clickPoint: OverlayPoint = { x: 50, y: 50, role: "click" };

    it("returns both frames for a step that captured both", async () => {
        const shot = await whiteScreenshot();
        const loop = makeReviewerLoop({
            steps: [{ order: 0, screenshotBeforeKey: "before.png", screenshotAfterKey: "after.png" }],
            screenshotLoader: { loadScreenshot: async () => shot },
        });

        const out = await viewStep(loop);

        expect(out.frames.map((f) => f.timing)).toEqual(["before", "after"]);
    });

    it("annotates the before screenshot of a web click step at the resolved point", async () => {
        const before = await whiteScreenshot();
        const loop = makeReviewerLoop({
            architecture: "WEB",
            steps: [{ order: 0, screenshotBeforeKey: "before.png", overlayPoints: [clickPoint] }],
            screenshotLoader: { loadScreenshot: async () => before },
        });

        const out = frame(await viewStep(loop), "before");
        expect(out.annotated).toBe(true);

        const annotated = Buffer.from(out.base64, "base64");
        expect(await isPixelMarked(annotated, 50, 50)).toBe(true);
        expect(await isPixelMarked(annotated, 2, 2)).toBe(false);
    });

    it("annotates a web drag step with both endpoints", async () => {
        const before = await whiteScreenshot();
        const dragPoints: OverlayPoint[] = [
            { x: 20, y: 20, role: "drag-start" },
            { x: 80, y: 80, role: "drag-end" },
        ];
        const loop = makeReviewerLoop({
            architecture: "WEB",
            steps: [{ order: 0, screenshotBeforeKey: "before.png", overlayPoints: dragPoints }],
            screenshotLoader: { loadScreenshot: async () => before },
        });

        const out = frame(await viewStep(loop), "before");
        expect(out.annotated).toBe(true);

        const annotated = Buffer.from(out.base64, "base64");
        expect(await isPixelMarked(annotated, 20, 20)).toBe(true);
        expect(await isPixelMarked(annotated, 80, 80)).toBe(true);
    });

    it("does not annotate the after screenshot", async () => {
        const after = await whiteScreenshot();
        const loop = makeReviewerLoop({
            architecture: "WEB",
            steps: [{ order: 0, screenshotAfterKey: "after.png", overlayPoints: [clickPoint] }],
            screenshotLoader: { loadScreenshot: async () => after },
        });

        const out = frame(await viewStep(loop), "after");
        expect(out.annotated).toBe(false);
        expect(await isPixelMarked(Buffer.from(out.base64, "base64"), 50, 50)).toBe(false);
    });

    it("does not annotate non-web steps even with a resolved point", async () => {
        const before = await whiteScreenshot();
        const loop = makeReviewerLoop({
            architecture: "IOS",
            steps: [{ order: 0, screenshotBeforeKey: "before.png", overlayPoints: [clickPoint] }],
            screenshotLoader: { loadScreenshot: async () => before },
        });

        const out = frame(await viewStep(loop), "before");
        expect(out.annotated).toBe(false);
        expect(await isPixelMarked(Buffer.from(out.base64, "base64"), 50, 50)).toBe(false);
    });

    it("does not annotate when the step has no resolved point", async () => {
        const before = await whiteScreenshot();
        const loop = makeReviewerLoop({
            architecture: "WEB",
            steps: [{ order: 0, screenshotBeforeKey: "before.png" }],
            screenshotLoader: { loadScreenshot: async () => before },
        });

        expect(frame(await viewStep(loop), "before").annotated).toBe(false);
    });

    it("discloses the engine's step record whole, however long", async () => {
        // The trace line that indexes this step is capped; the drill-down is not, or a long assertion
        // breakdown - the exact thing the model asks for a step to read - would come back cut in half.
        const assertions = Array.from({ length: 40 }, (_, i) => ({
            assertion: `validate that row ${i} shows the settled balance for the quarter`,
            metCondition: i !== 17,
        }));
        const loop = makeReviewerLoop({
            steps: [{ order: 0, interaction: "assert", status: "failed", output: { results: assertions } }],
        });

        const { summary } = await viewStep(loop);

        expect(summary).toContain("validate that row 39 shows the settled balance");
        expect(summary).toContain('"metCondition": false');
    });
});
