import { describe, expect, it, vi } from "vitest";
import type { Browser } from "webdriverio";
import { AppiumTouchDriver } from "../../src/platform/drivers/appium-touch.driver";

interface PointerAction {
    type: string;
    duration?: number;
    x?: number;
    y?: number;
    button?: number;
}

interface PointerActionSequence {
    type: string;
    id: string;
    parameters: { pointerType: string };
    actions: PointerAction[];
}

function createMockDriver(): Browser {
    return {
        performActions: vi.fn().mockResolvedValue(undefined),
    } as unknown as Browser;
}

function extractMoves(mockDriver: Browser): PointerAction[] {
    const call = vi.mocked(mockDriver.performActions).mock.calls[0];
    const sequence = call?.[0]?.[0] as unknown as PointerActionSequence;
    return sequence.actions.filter((a) => a.type === "pointerMove");
}

const SCREEN_WIDTH = 1440;
const SCREEN_HEIGHT = 2560;

describe("AppiumTouchDriver", () => {
    describe("scroll", () => {
        it("scroll down without point drags from bottomCenter to topCenter", async () => {
            const mockDriver = createMockDriver();
            const driver = new AppiumTouchDriver(mockDriver, { width: SCREEN_WIDTH, height: SCREEN_HEIGHT });

            await driver.scroll({ direction: "down" });

            const moves = extractMoves(mockDriver);
            expect(moves).toHaveLength(2);

            // bottomCenter sector: (width/2, height*5/6)
            expect(moves[0]?.x).toBe(SCREEN_WIDTH / 2);
            expect(moves[0]?.y).toBe((SCREEN_HEIGHT * 5) / 6);

            // topCenter sector: (width/2, height/6)
            expect(moves[1]?.x).toBe(SCREEN_WIDTH / 2);
            expect(moves[1]?.y).toBe(SCREEN_HEIGHT / 6);
        });

        it("scroll up without point drags from topCenter to bottomCenter", async () => {
            const mockDriver = createMockDriver();
            const driver = new AppiumTouchDriver(mockDriver, { width: SCREEN_WIDTH, height: SCREEN_HEIGHT });

            await driver.scroll({ direction: "up" });

            const moves = extractMoves(mockDriver);

            // topCenter sector: (width/2, height/6)
            expect(moves[0]?.x).toBe(SCREEN_WIDTH / 2);
            expect(moves[0]?.y).toBe(SCREEN_HEIGHT / 6);

            // bottomCenter sector: (width/2, height*5/6)
            expect(moves[1]?.x).toBe(SCREEN_WIDTH / 2);
            expect(moves[1]?.y).toBe((SCREEN_HEIGHT * 5) / 6);
        });

        it("scroll down with point drags from point upward by half distance to edge", async () => {
            const mockDriver = createMockDriver();
            const driver = new AppiumTouchDriver(mockDriver, { width: SCREEN_WIDTH, height: SCREEN_HEIGHT });

            const point = { x: 400, y: 1800 };
            await driver.scroll({ point, direction: "down" });

            const moves = extractMoves(mockDriver);

            // Starts at the point
            expect(moves[0]?.x).toBe(point.x);
            expect(moves[0]?.y).toBe(point.y);

            // distanceToEdge = point.y = 1800
            // swipeDistance = 1800 / 2 = 900
            // endY = 1800 - 900 = 900
            expect(moves[1]?.x).toBe(point.x);
            expect(moves[1]?.y).toBe(900);
        });

        it("scroll up with point drags from point downward by half distance to edge", async () => {
            const mockDriver = createMockDriver();
            const driver = new AppiumTouchDriver(mockDriver, { width: SCREEN_WIDTH, height: SCREEN_HEIGHT });

            const point = { x: 400, y: 600 };
            await driver.scroll({ point, direction: "up" });

            const moves = extractMoves(mockDriver);

            // Starts at the point
            expect(moves[0]?.x).toBe(point.x);
            expect(moves[0]?.y).toBe(point.y);

            // distanceToEdge = height - point.y = 2560 - 600 = 1960
            // swipeDistance = 1960 / 2 = 980
            // endY = 600 + 980 = 1580
            expect(moves[1]?.x).toBe(point.x);
            expect(moves[1]?.y).toBe(1580);
        });
    });
});
