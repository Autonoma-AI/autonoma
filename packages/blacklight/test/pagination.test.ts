import { describe, expect, it } from "vitest";
import { paginationSlots } from "../src/components/ui/pagination";

/**
 * The window arithmetic, which is the only part of the pager that can be wrong without looking wrong: an
 * off-by-one drops the last page or renders a gap marker with nothing behind it.
 */
describe("paginationSlots", () => {
    it("lists every page when they all fit", () => {
        expect(paginationSlots(1, 5)).toEqual([1, 2, 3, 4, 5]);
        expect(paginationSlots(4, 7)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    });

    it("keeps the first and last page reachable from anywhere in the middle", () => {
        const slots = paginationSlots(6, 12);
        expect(slots[0]).toBe(1);
        expect(slots[slots.length - 1]).toBe(12);
        expect(slots).toContain(6);
    });

    it("never elides a single page - a gap marker always stands for at least two", () => {
        // A marker hiding one page is worse than showing it: same width, less information.
        for (let pageCount = 1; pageCount <= 40; pageCount++) {
            for (let page = 1; page <= pageCount; page++) {
                const slots = paginationSlots(page, pageCount);
                const numbers = slots.filter((slot): slot is number => typeof slot === "number");
                slots.forEach((slot, index) => {
                    if (slot !== "ellipsis") return;
                    const before = slots[index - 1];
                    const after = slots[index + 1];
                    expect(typeof before).toBe("number");
                    expect(typeof after).toBe("number");
                    // Gap of exactly 1 would mean the marker replaced one page.
                    expect(Number(after) - Number(before)).toBeGreaterThan(2);
                });
                // Ascending, no duplicates, always includes the current page and both ends.
                expect([...numbers]).toEqual([...new Set(numbers)].sort((a, b) => a - b));
                expect(numbers).toContain(page);
                expect(numbers).toContain(1);
                expect(numbers).toContain(pageCount);
            }
        }
    });

    it("holds the window at full width against both ends", () => {
        const atStart = paginationSlots(1, 20).filter((slot) => typeof slot === "number");
        const atEnd = paginationSlots(20, 20).filter((slot) => typeof slot === "number");
        expect(atStart.length).toBe(atEnd.length);
    });
});
