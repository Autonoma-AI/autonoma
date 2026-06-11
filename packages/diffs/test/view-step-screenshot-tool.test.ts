import type { OverlayPoint } from "@autonoma/types";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ViewStepScreenshotTool } from "../src/agents/tools/screenshot/view-step-screenshot-tool";
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
    timing: z.enum(["before", "after"]),
    base64: z.string(),
    annotated: z.boolean(),
});

/** Validate the envelope is a successful, found screenshot result. */
function expectFound(envelope: ToolEnvelope<unknown>): z.infer<typeof foundSchema> {
    if (!envelope.success) throw new Error(`Expected success, got error: ${envelope.error}`);
    return foundSchema.parse(envelope.result);
}

async function viewStep(
    loop: ReturnType<typeof makeReviewerLoop>,
    timing: "before" | "after",
): Promise<z.infer<typeof foundSchema>> {
    const envelope = await executeTool<ToolEnvelope<unknown>>(
        new ViewStepScreenshotTool(),
        { stepOrder: 0, timing },
        loop,
    );
    return expectFound(envelope);
}

describe("ViewStepScreenshotTool", () => {
    const clickPoint: OverlayPoint = { x: 50, y: 50, role: "click" };

    it("annotates the before screenshot of a web click step at the resolved point", async () => {
        const before = await whiteScreenshot();
        const loop = makeReviewerLoop({
            architecture: "WEB",
            steps: [{ order: 0, screenshotBeforeKey: "before.png", overlayPoints: [clickPoint] }],
            screenshotLoader: { loadScreenshot: async () => before },
        });

        const out = await viewStep(loop, "before");
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

        const out = await viewStep(loop, "before");
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

        const out = await viewStep(loop, "after");
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

        const out = await viewStep(loop, "before");
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

        const out = await viewStep(loop, "before");
        expect(out.annotated).toBe(false);
    });
});
