/**
 * CLI helper script that detects bounding boxes for a given image and prompt,
 * then saves the results to a gitignored `bounding-boxes/` directory.
 *
 * Usage:
 *   pnpm --filter @autonoma/visual-ai detect-object <image-path> "<prompt>"
 *
 * Output:
 *   bounding-boxes/{ISO-timestamp}-{image-basename}/result.json
 *   bounding-boxes/{ISO-timestamp}-{image-basename}/image.png
 */

import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MODEL_ENTRIES, ModelRegistry } from "@autonoma/ai";
import { type BoundingBox, Screenshot, boundingBoxCenter } from "@autonoma/image";
import { logger } from "@autonoma/logger";
import { GeminiObjectDetector } from "../src/index";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

async function main() {
    const [imagePath, prompt] = process.argv.slice(2);

    if (imagePath == null || prompt == null) {
        logger.error("Usage: tsx detect-object.ts <image-path> <prompt>");
        process.exit(1);
    }

    const basename = path.basename(imagePath, path.extname(imagePath));

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const outputDir = path.join(__dirname, "../bounding-boxes", `${timestamp}-${basename}`);

    mkdirSync(outputDir, { recursive: true });

    const absoluteImagePath = path.resolve(imagePath);
    copyFileSync(absoluteImagePath, path.join(outputDir, "image.png"));

    const imageBuffer = readFileSync(absoluteImagePath);
    const screenshot = Screenshot.fromBuffer(imageBuffer);

    const registry = new ModelRegistry({
        models: { vision: MODEL_ENTRIES.GEMINI_3_FLASH_PREVIEW },
    });
    const model = registry.getModel({ model: "vision", tag: "detect-bounding-box" });
    const detector = new GeminiObjectDetector(model);

    logger.info(`Detecting objects for: "${prompt}"`);
    const detectedRaw = await detector.detectObjects(screenshot, prompt);

    const detectedObjects = detectedRaw.map((obj) => ({
        label: obj.label,
        boundingBox: obj.boundingBox,
        center: boundingBoxCenter(obj.boundingBox),
    }));

    const result = {
        timestamp: new Date().toISOString(),
        imagePath: absoluteImagePath,
        prompt,
        detectedObjects,
    };

    const markedScreenshot = await screenshot.drawBoundingBoxes(
        detectedObjects.map((obj) => obj.boundingBox) as [BoundingBox, ...BoundingBox[]],
    );

    writeFileSync(path.join(outputDir, "image-marked.png"), markedScreenshot.buffer);
    writeFileSync(path.join(outputDir, "result.json"), JSON.stringify(result, null, 4));

    logger.info(`\nResults saved to: ${outputDir}`);
    logger.info(JSON.stringify(detectedObjects, null, 2));
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
