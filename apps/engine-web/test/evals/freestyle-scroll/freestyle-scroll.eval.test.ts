import path from "node:path";
import type { PointDetector, VisualConditionChecker } from "@autonoma/ai";
import { ScrollCommand } from "@autonoma/engine";
import type { ScreenResolution, Screenshot } from "@autonoma/image";
import { type Browser, type BrowserContext, type Page, chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ActivePageManager } from "../../../src/platform/active-page-manager";
import { PlaywrightApplicationDriver } from "../../../src/platform/drivers/playwright-application.driver";
import { PlaywrightMouseDriver } from "../../../src/platform/drivers/playwright-mouse.driver";
import { PlaywrightScreenDriver } from "../../../src/platform/drivers/playwright-screen.driver";

const VIEWPORT = { width: 1920, height: 1080 };
const FIXTURES_DIR = path.join(import.meta.dirname, "fixtures");

/**
 * Creates a PointDetector that queries the DOM for an element's center coordinates.
 * This avoids needing AI for the eval — we use real DOM positions instead.
 */
function createDomPointDetector(page: Page): PointDetector {
    return {
        async detectPoint(_screenshot: Screenshot, prompt: string) {
            const point = await page.evaluate((selector: string) => {
                const elements = document.querySelectorAll("*");
                for (const el of elements) {
                    if (selector.includes("sidebar") && el.classList.contains("sidebar")) {
                        const rect = el.getBoundingClientRect();
                        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
                    }
                    if (selector.includes("year") && el.classList.contains("year-picker")) {
                        const rect = el.getBoundingClientRect();
                        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
                    }
                    if (selector.includes("catalog") && el.classList.contains("catalog")) {
                        const rect = el.getBoundingClientRect();
                        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
                    }
                    if (selector.includes("product") && el.classList.contains("catalog")) {
                        const rect = el.getBoundingClientRect();
                        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
                    }
                }
                return undefined;
            }, prompt);

            if (point == null) {
                throw new Error(`DomPointDetector: could not find element for "${prompt}"`);
            }

            return point;
        },
        detectPointForResolution(_screenshot: Screenshot, _prompt: string, _resolution: ScreenResolution) {
            throw new Error("Not implemented for eval");
        },
    } as unknown as PointDetector;
}

/**
 * Creates a VisualConditionChecker that queries the DOM to check if an element is visible in the viewport.
 */
function createDomVisualConditionChecker(page: Page): VisualConditionChecker {
    return {
        async checkCondition(condition: string, _screenshot: Screenshot) {
            const result = await page.evaluate((cond: string) => {
                const elements = document.querySelectorAll("*");
                // Extract text patterns from condition
                const lowerCond = cond.toLowerCase();

                for (const el of elements) {
                    const directText = Array.from(el.childNodes)
                        .filter((n) => n.nodeType === Node.TEXT_NODE)
                        .map((n) => n.textContent?.trim() ?? "")
                        .join(" ")
                        .toLowerCase();

                    // Check if the element contains the target text and is visible
                    let matched = false;

                    if (lowerCond.includes("logout") && directText.includes("logout")) matched = true;
                    if (lowerCond.includes("2020") && directText === "2020") matched = true;
                    if (lowerCond.includes("wireless headphones") && directText.includes("wireless headphones"))
                        matched = true;
                    if (lowerCond.includes("delete account") && directText.includes("delete account")) matched = true;

                    if (matched) {
                        const rect = el.getBoundingClientRect();
                        const viewportHeight = window.innerHeight;
                        const viewportWidth = window.innerWidth;
                        const isVisible =
                            rect.top >= 0 &&
                            rect.bottom <= viewportHeight &&
                            rect.left >= 0 &&
                            rect.right <= viewportWidth &&
                            rect.height > 0 &&
                            rect.width > 0;
                        if (isVisible) {
                            return { metCondition: true, reason: `Element "${directText}" is visible in viewport` };
                        }
                    }
                }
                return { metCondition: false, reason: "Target element not visible in viewport" };
            }, condition);

            return result;
        },
    } as unknown as VisualConditionChecker;
}

describe("Freestyle Scroll Eval", { timeout: 30000 }, () => {
    let browser: Browser;
    let browserContext: BrowserContext;

    beforeAll(async () => {
        browser = await chromium.launch({ headless: true });
        browserContext = await browser.newContext({
            viewport: VIEWPORT,
        });
    });

    afterAll(async () => {
        await browserContext?.close();
        await browser?.close();
    });

    async function setupPage(fixture: string) {
        const page = await browserContext.newPage();
        const filePath = path.join(FIXTURES_DIR, fixture);
        await page.goto(`file://${filePath}`);
        await page.waitForLoadState("domcontentloaded");
        // Let randomized positions settle
        await page.waitForTimeout(200);
        return page;
    }

    function createCommand(page: Page) {
        const pageManager = new ActivePageManager(page, browserContext);
        const screenDriver = new PlaywrightScreenDriver(pageManager);
        const mouseDriver = new PlaywrightMouseDriver(pageManager, VIEWPORT);
        const applicationDriver = new PlaywrightApplicationDriver(pageManager);
        const pointDetector = createDomPointDetector(page);
        const visualConditionChecker = createDomVisualConditionChecker(page);

        const command = new ScrollCommand(pointDetector, visualConditionChecker);
        const context = { screen: screenDriver, mouse: mouseDriver, application: applicationDriver };

        return { command, context };
    }

    it("scrolls down a sidebar until the logout button is visible", async () => {
        const page = await setupPage("scrollable-sidebar.html");

        try {
            const { command, context } = createCommand(page);

            const result = await command.execute(
                {
                    elementDescription: "the sidebar navigation panel",
                    direction: "down",
                    condition: "the Logout button is visible",
                    maxScrolls: 10,
                },
                context,
            );

            expect(result.conditionMet).toBe(true);
            expect(result.scrollsPerformed).toBeGreaterThanOrEqual(1);
            expect(result.scrollsPerformed).toBeLessThanOrEqual(10);
            expect(result.point?.x).toBeGreaterThan(0);
            expect(result.point?.y).toBeGreaterThan(0);
        } finally {
            await page.close();
        }
    });

    it("scrolls down a year picker until year 2020 is visible", async () => {
        const page = await setupPage("scrollable-year-picker.html");

        try {
            const { command, context } = createCommand(page);

            const result = await command.execute(
                {
                    elementDescription: "the year picker scrollable list",
                    direction: "down",
                    condition: "the year 2020 is visible",
                    maxScrolls: 15,
                },
                context,
            );

            expect(result.conditionMet).toBe(true);
            expect(result.scrollsPerformed).toBeGreaterThanOrEqual(1);
        } finally {
            await page.close();
        }
    });

    it("scrolls up a product catalog to find Wireless Headphones", async () => {
        const page = await setupPage("scrollable-product-list.html");

        try {
            const { command, context } = createCommand(page);

            const result = await command.execute(
                {
                    elementDescription: "the product catalog list",
                    direction: "up",
                    condition: "Wireless Headphones is visible",
                    maxScrolls: 15,
                },
                context,
            );

            expect(result.conditionMet).toBe(true);
            expect(result.scrollsPerformed).toBeGreaterThanOrEqual(1);
        } finally {
            await page.close();
        }
    });

    it("returns conditionMet: false when target does not exist", async () => {
        const page = await setupPage("scrollable-sidebar.html");

        try {
            const { command, context } = createCommand(page);

            const result = await command.execute(
                {
                    elementDescription: "the sidebar navigation panel",
                    direction: "down",
                    condition: "a button labeled 'Delete Account' is visible",
                    maxScrolls: 3,
                },
                context,
            );

            expect(result.conditionMet).toBe(false);
            expect(result.scrollsPerformed).toBe(3);
        } finally {
            await page.close();
        }
    });

    it("scrolls down a sparse sidebar with blank space to find Delete Account", async () => {
        const page = await setupPage("sparse-sidebar.html");

        try {
            const { command, context } = createCommand(page);

            const result = await command.execute(
                {
                    elementDescription: "the dark sidebar navigation panel",
                    direction: "down",
                    condition: "the Delete Account option is visible",
                    maxScrolls: 10,
                },
                context,
            );

            expect(result.conditionMet).toBe(true);
            expect(result.scrollsPerformed).toBeGreaterThanOrEqual(1);
        } finally {
            await page.close();
        }
    });

    it("works with randomized positions across multiple runs", async () => {
        // Run 3 times — each reload randomizes the sidebar position
        for (let run = 0; run < 3; run++) {
            const page = await setupPage("scrollable-sidebar.html");

            try {
                const { command, context } = createCommand(page);

                const result = await command.execute(
                    {
                        elementDescription: "the sidebar navigation panel",
                        direction: "down",
                        condition: "the Logout button is visible",
                        maxScrolls: 10,
                    },
                    context,
                );

                expect(result.conditionMet).toBe(true);
            } finally {
                await page.close();
            }
        }
    });
});
