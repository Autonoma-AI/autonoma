import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { AssertChecker, GeminiObjectDetector, ObjectPointDetector } from "@autonoma/visual-ai";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Browser, remote } from "webdriverio";
import { AppiumKeyboardDriver } from "../../src/platform/drivers/appium-keyboard.driver";
import { AppiumScreenDriver } from "../../src/platform/drivers/appium-screen.driver";
import { AppiumTouchDriver } from "../../src/platform/drivers/appium-touch.driver";

const APPIUM_HOST = process.env.APPIUM_HOST ?? "localhost";
const APPIUM_PORT = Number(process.env.APPIUM_PORT ?? "4723");
const DEVICE_NAME = process.env.DEVICE_NAME ?? "emulator-5554";

function createGeminiModel() {
    const geminiApiKey = process.env.GEMINI_API_KEY;
    if (geminiApiKey == null) throw new Error("GEMINI_API_KEY env var is required");
    const google = createGoogleGenerativeAI({ apiKey: geminiApiKey });
    return google("gemini-3-flash-preview");
}

describe.runIf(process.env.RUN_E2E)("Appium drivers e2e", () => {
    let driver: Browser;
    let screen: AppiumScreenDriver;
    let touch: AppiumTouchDriver;
    let keyboard: AppiumKeyboardDriver;

    beforeAll(async () => {
        driver = await remote({
            logLevel: "warn",
            hostname: APPIUM_HOST,
            port: APPIUM_PORT,
            path: "/",
            capabilities: {
                platformName: "Android",
                "appium:deviceName": DEVICE_NAME,
                "appium:automationName": "UiAutomator2",
                "appium:noReset": true,
                "appium:newCommandTimeout": 0,
            },
        });

        const resolution = await driver.getWindowSize();

        screen = new AppiumScreenDriver(driver);
        touch = new AppiumTouchDriver(driver, resolution);
        keyboard = new AppiumKeyboardDriver(driver);
    }, 30_000);

    afterAll(async () => {
        if (driver != null) {
            await driver.deleteSession();
        }
    });

    it("can take a screenshot with valid image data", async () => {
        const screenshot = await screen.screenshot();
        expect(screenshot.buffer.length).toBeGreaterThan(0);
    });

    it("can get device resolution with positive dimensions", async () => {
        const resolution = await screen.getResolution();
        expect(resolution.width).toBeGreaterThan(0);
        expect(resolution.height).toBeGreaterThan(0);
    });

    it("can draw a cross on jspaint and verify it visually", async () => {
        const resolution = await screen.getResolution();
        const centerX = Math.round(resolution.width / 2);
        const centerY = Math.round(resolution.height / 2);
        const armLength = 150;

        // Draw horizontal line
        await touch.drag(centerX - armLength, centerY, centerX + armLength, centerY);
        await driver.pause(300);

        // Draw vertical line
        await touch.drag(centerX, centerY - armLength, centerX, centerY + armLength);
        await driver.pause(300);

        // Take screenshot and verify with AI
        const screenshot = await screen.screenshot();
        const model = createGeminiModel();
        const checker = new AssertChecker(model);

        const result = await checker.checkCondition(
            "There are two lines drawn on the canvas forming a cross or plus sign shape",
            screenshot,
        );

        expect(result.metCondition, `Visual assertion failed: ${result.reason}`).toBe(true);
    }, 60_000);

    it("can scroll at an AI-detected point", async () => {
        const model = createGeminiModel();
        const pointDetector = new ObjectPointDetector(new GeminiObjectDetector(model));
        const checker = new AssertChecker(model);

        const screenshot = await screen.screenshot();
        const resolution = await screen.getResolution();

        // Detect the red color swatch in the palette to get its X coordinate.
        // We use the AI-detected X but place Y at screen center so the drag
        // happens on the canvas (not on the palette UI element).
        const detectedPoint = await pointDetector.detectPoint(
            screenshot,
            "the red color swatch in the color palette",
            resolution,
        );

        const screenMidY = Math.round(resolution.height / 2);
        const point = { x: detectedPoint.x, y: screenMidY };

        // The red swatch is on the left side of the screen
        const screenMidX = resolution.width / 2;
        expect(detectedPoint.x, "AI should detect the red swatch left of screen center").toBeLessThan(screenMidX);

        // Scroll "down" at the detected point's X but on the canvas.
        // This drags upward from the center, drawing a vertical line
        // at the red swatch's X coordinate (left of center).
        await touch.scroll({ point, direction: "down" });
        await driver.pause(500);

        // Verify the drag drew a new vertical line to the left of the existing cross.
        // The cross test draws a black cross in the center. This scroll starts from
        // the red swatch's X coordinate, so the new line should be to the left of the cross.
        const afterScreenshot = await screen.screenshot();
        const result = await checker.checkCondition(
            "There is a cross in the center of the canvas AND a separate vertical line to the left of the cross",
            afterScreenshot,
        );

        expect(result.metCondition, `Scroll at detected point did not draw a red line: ${result.reason}`).toBe(true);
    }, 60_000);

    it("can press a keyboard key without error", async () => {
        await expect(keyboard.press("a")).resolves.not.toThrow();
    });
});
