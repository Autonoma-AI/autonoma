import { DialogObserver, type NativeDialogEvent } from "@autonoma/engine";
import { describe, expect, it } from "vitest";

function event(message: string): NativeDialogEvent {
    return { type: "confirm", message, outcome: "accepted", occurredAt: 0 };
}

describe("DialogObserver", () => {
    it("takePending returns recorded dialogs then drains the buffer", () => {
        const observer = new DialogObserver();
        observer.record(event("a"));
        observer.record(event("b"));

        const first = observer.takePending();
        expect(first.map((e) => e.message)).toEqual(["a", "b"]);
        expect(observer.takePending()).toEqual([]);
    });

    it("caps the unread buffer, dropping the oldest events", () => {
        const observer = new DialogObserver();
        // Record well past the cap (50) to simulate a page firing dialogs in a loop between steps.
        for (let i = 0; i < 60; i++) observer.record(event(`d${i}`));

        const pending = observer.takePending();
        expect(pending).toHaveLength(50);
        // The most recent 50 survive; the oldest 10 (d0..d9) are dropped.
        expect(pending[0]?.message).toBe("d10");
        expect(pending.at(-1)?.message).toBe("d59");
    });
});
