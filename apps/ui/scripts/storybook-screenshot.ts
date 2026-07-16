import { mkdir } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { chromium } from "playwright";

const DEFAULT_STORYBOOK_URL = "http://localhost:6006";
const DEFAULT_OUT_DIR = "screenshots";
const DEFAULT_VIEWPORT = { width: 1440, height: 900 };
const DEFAULT_SETTLE_MS = 500;
const FIXTURE_ERROR_MARKER = "[storybook-fixtures]";

const DISABLE_MOTION_CSS = `
    *, *::before, *::after {
        animation: none !important;
        transition: none !important;
        caret-color: transparent !important;
    }
`;

interface CliOptions {
    storyIds: string[];
    storybookUrl: string;
    outDir: string;
    viewport: { width: number; height: number };
    fullPage: boolean;
    settleMs: number;
    allowUnmocked: boolean;
}

/**
 * Screenshots Storybook stories to PNG. Expects a running storybook dev
 * server (`pnpm --filter @autonoma/ui storybook`). Fails when a story hits a
 * tRPC procedure with no fixture, so screenshots never silently show error
 * states - pass --allow-unmocked to override.
 *
 * Usage:
 *   pnpm --filter @autonoma/ui storybook:shoot -- --story pages-apphome--default
 */
async function main() {
    const options = parseCliOptions();
    await mkdir(options.outDir, { recursive: true });

    const browser = await chromium.launch();
    const failures: string[] = [];
    try {
        for (const storyId of options.storyIds) {
            const fixtureErrors = await shootStory(browser, storyId, options);
            if (fixtureErrors.length > 0) {
                failures.push(...fixtureErrors.map((message) => `${storyId}: ${message}`));
            }
        }
    } finally {
        await browser.close();
    }

    if (failures.length > 0 && !options.allowUnmocked) {
        console.error("\nUnmocked tRPC procedures - the screenshots above show error states:");
        for (const failure of failures) console.error(`  - ${failure}`);
        console.error("Add the missing fixtures or pass --allow-unmocked.");
        process.exit(1);
    }
}

async function shootStory(
    browser: Awaited<ReturnType<typeof chromium.launch>>,
    storyId: string,
    options: CliOptions,
): Promise<string[]> {
    console.log(`[storybook-shoot] shooting ${storyId}`);
    const context = await browser.newContext({ viewport: options.viewport, reducedMotion: "reduce" });
    try {
        const page = await context.newPage();
        const fixtureErrors: string[] = [];
        page.on("console", (message) => {
            if (message.type() === "error" && message.text().includes(FIXTURE_ERROR_MARKER)) {
                fixtureErrors.push(message.text().replace(FIXTURE_ERROR_MARKER, "").trim());
            }
        });

        const url = `${options.storybookUrl}/iframe.html?id=${encodeURIComponent(storyId)}&viewMode=story`;
        await page.goto(url, { waitUntil: "networkidle" });
        await page.addStyleTag({ content: DISABLE_MOTION_CSS });
        await page.evaluate(() => document.fonts.ready);
        await page.waitForTimeout(options.settleMs);

        const file = path.join(options.outDir, `${storyId}.png`);
        await page.screenshot({ path: file, fullPage: options.fullPage });
        console.log(`[storybook-shoot] saved ${file}`);
        return fixtureErrors;
    } finally {
        await context.close();
    }
}

function parseCliOptions(): CliOptions {
    const { values } = parseArgs({
        options: {
            story: { type: "string", multiple: true },
            url: { type: "string" },
            out: { type: "string" },
            viewport: { type: "string" },
            "full-page": { type: "boolean" },
            "settle-ms": { type: "string" },
            "allow-unmocked": { type: "boolean" },
        },
    });

    const storyIds = values.story ?? [];
    if (storyIds.length === 0) {
        console.error("Usage: storybook:shoot -- --story <story-id> [--story <story-id> ...]");
        console.error("Story ids are the ?path=/story/<id> slug in the storybook URL.");
        process.exit(1);
    }

    return {
        storyIds,
        storybookUrl: values.url ?? DEFAULT_STORYBOOK_URL,
        outDir: values.out ?? DEFAULT_OUT_DIR,
        viewport: parseViewport(values.viewport),
        fullPage: values["full-page"] ?? false,
        settleMs: values["settle-ms"] != null ? Number(values["settle-ms"]) : DEFAULT_SETTLE_MS,
        allowUnmocked: values["allow-unmocked"] ?? false,
    };
}

function parseViewport(raw: string | undefined): { width: number; height: number } {
    if (raw == null) return DEFAULT_VIEWPORT;
    const match = raw.match(/^(\d+)x(\d+)$/);
    if (match == null || match[1] == null || match[2] == null) {
        console.error(`Invalid --viewport "${raw}", expected WIDTHxHEIGHT like 1440x900`);
        process.exit(1);
    }
    return { width: Number(match[1]), height: Number(match[2]) };
}

await main();
