import type { Point } from "@autonoma/image";
import type { MouseDriver, ScrollArgs } from "../../platform";

export interface FakeClick<TClickOptions extends object = Record<string, never>> {
    point: Point;
    options?: TClickOptions;
}

export interface FakeDrag {
    startPoint: Point;
    endPoint: Point;
}

export class FakeMouseDriver<
    TClickOptions extends object = Record<string, never>,
> implements MouseDriver<TClickOptions> {
    /** The clicks performed by the driver. */
    public readonly clicks: FakeClick<TClickOptions>[] = [];

    /** The hovers performed by the driver. */
    public readonly hovers: Point[] = [];

    /** The drags performed by the driver. */
    public readonly drags: FakeDrag[] = [];

    /** The scrolls performed by the driver. */
    public readonly scrolls: ScrollArgs[] = [];

    async click(x: number, y: number, options?: TClickOptions): Promise<void> {
        this.clicks.push({ point: { x, y }, options });
    }

    async hover(x: number, y: number): Promise<void> {
        this.hovers.push({ x, y });
    }

    async drag(startX: number, startY: number, endX: number, endY: number): Promise<void> {
        this.drags.push({ startPoint: { x: startX, y: startY }, endPoint: { x: endX, y: endY } });
    }

    async scroll(args: ScrollArgs): Promise<void> {
        this.scrolls.push(args);
    }
}
