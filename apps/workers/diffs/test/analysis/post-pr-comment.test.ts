import type { AutonomaCommentCta, AutonomaCommentPayload } from "@autonoma/github/comment";
import { describe, expect, test } from "vitest";
import {
    assembleSettledPrPayload,
    buildAnalyzingPayload,
    buildFailedPayload,
    describePreview,
} from "../../src/activities/analysis/post-pr-comment";

const OPEN_CTA: AutonomaCommentCta = { label: "Open in Autonoma", href: "https://app.example.com" };
const SEE_PREVIEW_CTA: AutonomaCommentCta = { label: "See preview", href: "https://front-door.example.com" };

/** A settled analysis payload; `ctas` is the part the pr assembly may rewrite. */
function analysisBase(ctas: AutonomaCommentCta[]): AutonomaCommentPayload {
    return {
        state: "critical",
        kind: "analysis",
        prNumber: 42,
        title: "Autonoma found 2 bugs in this PR",
        headline: "Autonoma found 2 bugs in this PR.",
        ctas,
        services: [],
        bugs: [],
        notes: [],
        flowGroups: [],
        warnings: [],
        details: [],
        previewUrls: [],
    };
}

describe("assembleSettledPrPayload", () => {
    test("sets the pr kind and the dash-form title", () => {
        const payload = assembleSettledPrPayload(analysisBase([OPEN_CTA]), undefined);
        expect(payload.kind).toBe("pr");
        expect(payload.title).toBe("Autonoma - found 2 bugs in this PR");
    });

    test("keeps the base CTAs - the preview button rides the bottom for both org types", () => {
        // BYO org: no section 1, base carries the button (a preview URL exists) - it must survive.
        const byo = assembleSettledPrPayload(analysisBase([OPEN_CTA, SEE_PREVIEW_CTA]), undefined);
        expect(byo.preview).toBeUndefined();
        expect(byo.ctas.map((c) => c.label)).toEqual(["Open in Autonoma", "See preview"]);

        // Previewkit ready: section 1 narrates status, the same bottom button is kept (not dropped, not duplicated).
        const section = { preview: describePreview("ready", "settled"), buildState: "ready" as const };
        const previewkit = assembleSettledPrPayload(analysisBase([OPEN_CTA, SEE_PREVIEW_CTA]), section);
        expect(previewkit.preview?.status).toContain("ready");
        expect(previewkit.ctas.map((c) => c.label)).toEqual(["Open in Autonoma", "See preview"]);
    });
});

describe("describePreview", () => {
    test("is a pure status banner with no inline link", () => {
        const ready = describePreview("ready", "settled");
        expect(ready.state).toBe("healthy");
        expect(ready.link).toBeUndefined();
        expect(describePreview("building", "in_flight").state).toBe("running");
        expect(describePreview("failed", "settled").state).toBe("critical");
    });

    test("reads 'missing' as preparing mid-flight and not-needed at settle", () => {
        expect(describePreview("missing", "in_flight").status).toContain("Preparing");
        expect(describePreview("missing", "settled").status).toContain("No preview");
    });
});

describe("buildAnalyzingPayload / buildFailedPayload", () => {
    test("titles the analyzing state from the build state and shows the preview button once browsable", () => {
        const building = { preview: describePreview("building", "in_flight"), buildState: "building" as const };
        expect(buildAnalyzingPayload(42, building).title).toBe("Autonoma - building preview");
        expect(buildAnalyzingPayload(42, building).ctas).toEqual([]);

        const ready = {
            preview: describePreview("ready", "in_flight"),
            buildState: "ready" as const,
            previewCta: SEE_PREVIEW_CTA,
        };
        expect(buildAnalyzingPayload(42, ready).title).toBe("Autonoma - analyzing this PR");
        expect(buildAnalyzingPayload(42, ready).ctas.map((c) => c.label)).toEqual(["See preview"]);

        expect(buildAnalyzingPayload(42, undefined).title).toBe("Autonoma - analyzing this PR");
    });

    test("names a failed preview build vs a generic failure", () => {
        const failed = { preview: describePreview("failed", "settled"), buildState: "failed" as const };
        expect(buildFailedPayload(42, failed).title).toBe("Autonoma - the preview build failed");
        expect(buildFailedPayload(42, undefined).title).toBe("Autonoma - couldn't analyze this PR");
    });
});
