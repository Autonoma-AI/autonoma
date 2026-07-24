import { describe, expect, it } from "vitest";
import { toPlainSummary } from "../../../src/analysis/report/summary";

describe("toPlainSummary", () => {
    it("keeps plain prose untouched", () => {
        const authored = "Checkout is broken: the Place order button never enables, so no purchase completes.";
        expect(toPlainSummary(authored)).toBe(authored);
    });

    it("unwraps token links to their text so the sentence still reads", () => {
        const authored =
            "One bug: the [Place order button never enables](issue:issue_1), seen in " +
            "[checkout-place-order](finding:checkout-place-order).";

        expect(toPlainSummary(authored)).toBe(
            "One bug: the Place order button never enables, seen in checkout-place-order.",
        );
    });

    it("removes an embedded image outright rather than leaving its alt text behind", () => {
        // The subtle case: `![alt](src)` contains a link-shaped tail, so unwrapping links before stripping images
        // would leave a stray "!alt" in the middle of the sentence.
        const authored = "Checkout fails. ![The disabled Place order button](evidence:asset_1) Cart still works.";

        const plain = toPlainSummary(authored);
        expect(plain).toBe("Checkout fails. Cart still works.");
        expect(plain).not.toContain("!");
        expect(plain).not.toContain("asset_1");
    });

    it("flattens headings and multi-paragraph markdown into one paragraph", () => {
        const authored = ["## This checkpoint", "", "Checkout is broken.", "", "Cart and search still work."].join(
            "\n",
        );

        expect(toPlainSummary(authored)).toBe("This checkpoint Checkout is broken. Cart and search still work.");
    });

    it("drops a raw image URL the same way as an evidence token", () => {
        const authored = "Checkout fails. ![shot](https://example.com/a.png)";
        expect(toPlainSummary(authored)).toBe("Checkout fails.");
    });
});
