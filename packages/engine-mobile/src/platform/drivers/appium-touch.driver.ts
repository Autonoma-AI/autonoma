import type { MouseDriver, ScrollArgs } from "@autonoma/engine";
import type { ScreenResolution } from "@autonoma/image";
import type { Browser } from "webdriverio";
import { runAppium } from "./appium-error";

export class AppiumTouchDriver implements MouseDriver {
    constructor(
        private readonly driver: Browser,
        private readonly screenResolution: ScreenResolution,
    ) {}

    private getScrollSectors() {
        const { width, height } = this.screenResolution;
        return {
            topCenter: { x: width / 2, y: height / 6 },
            bottomCenter: { x: width / 2, y: (height * 5) / 6 },
        };
    }

    async click(x: number, y: number): Promise<void> {
        await runAppium(() =>
            this.driver.performActions([
                {
                    type: "pointer",
                    id: "finger1",
                    parameters: { pointerType: "touch" },
                    actions: [
                        { type: "pointerMove", duration: 0, x, y },
                        { type: "pointerDown", button: 0 },
                        { type: "pointerUp", button: 0 },
                    ],
                },
            ]),
        );
    }

    async drag(startX: number, startY: number, endX: number, endY: number): Promise<void> {
        await runAppium(() =>
            this.driver.performActions([
                {
                    type: "pointer",
                    id: "finger1",
                    parameters: { pointerType: "touch" },
                    actions: [
                        { type: "pointerMove", duration: 0, x: startX, y: startY },
                        { type: "pointerDown", button: 0 },
                        { type: "pointerMove", duration: 500, x: endX, y: endY },
                        { type: "pointerUp", button: 0 },
                    ],
                },
            ]),
        );
    }

    async scroll({ point, direction }: ScrollArgs): Promise<void> {
        if (point != null) {
            const distanceToEdge = direction === "down" ? point.y : this.screenResolution.height - point.y;
            const swipeDistance = distanceToEdge / 2;
            const endY = direction === "down" ? point.y - swipeDistance : point.y + swipeDistance;

            await this.drag(point.x, point.y, point.x, endY);
            return;
        }

        const { topCenter, bottomCenter } = this.getScrollSectors();

        const start = direction === "down" ? bottomCenter : topCenter;
        const end = direction === "down" ? topCenter : bottomCenter;

        await this.drag(start.x, start.y, end.x, end.y);
    }
}
