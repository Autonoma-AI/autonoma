import type { WebClickOptions, WebMouseDriver } from "@autonoma/engine";
import type { ScrollArgs } from "@autonoma/engine";
import { type ScreenResolution, boundingBoxCenter } from "@autonoma/image";
import type { ActivePageManager } from "../active-page-manager";
import type { CursorOverlay } from "../cursor-overlay";
import { runPlaywright } from "./playwright-error";

export class PlaywrightMouseDriver implements WebMouseDriver {
    constructor(
        private readonly pageManager: ActivePageManager,
        private readonly screenResolution: ScreenResolution,
        private readonly cursor?: CursorOverlay,
    ) {}

    async click(x: number, y: number, options?: WebClickOptions): Promise<void> {
        // Glide first, dispatch second: the recording then reads as pointer-arrives-then-app-reacts,
        // and the real pointer never travels across the elements in between.
        await this.cursor?.moveTo({ x, y });
        await this.cursor?.markClick({ x, y });

        await runPlaywright(() =>
            this.pageManager.current.mouse.click(x, y, {
                button: options?.button,
                clickCount: options?.clickCount,
            }),
        );
    }

    async hover(x: number, y: number): Promise<void> {
        await this.cursor?.moveTo({ x, y });
        await runPlaywright(() => this.pageManager.current.mouse.move(x, y));
    }

    async drag(startX: number, startY: number, endX: number, endY: number): Promise<void> {
        const page = this.pageManager.current;

        await this.cursor?.moveTo({ x: startX, y: startY });
        await this.cursor?.markClick({ x: startX, y: startY });

        await runPlaywright(async () => {
            await page.mouse.move(startX, startY);
            await page.mouse.down();
            await page.mouse.move(endX, endY, { steps: 10 });
            await page.mouse.up();
        });

        await this.cursor?.dragTo({ x: endX, y: endY });
    }

    async scroll({ point, direction }: ScrollArgs): Promise<void> {
        const halfScreenHeight = this.screenResolution.height / 2;
        const amount = direction === "up" ? -halfScreenHeight : halfScreenHeight;

        const { x, y } = point ?? boundingBoxCenter({ x: 0, y: 0, ...this.screenResolution });
        const page = this.pageManager.current;

        await this.cursor?.moveTo({ x, y });

        await runPlaywright(async () => {
            await page.mouse.move(x, y);
            await page.mouse.wheel(0, amount);
        });
    }
}
