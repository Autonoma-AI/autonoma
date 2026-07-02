import type { InvestigationTestResult, InvestigationVerdict } from "@autonoma/workflow/activities";
import { describe, expect, it } from "vitest";
import {
    buildInvestigationCommentPayload,
    type InvestigationCommentContext,
} from "../src/activities/investigation-comment-payload";

const context: InvestigationCommentContext = {
    prNumber: 42,
    commitSha: "e5d627abcdef",
    reportBaseUrl: "https://beta.autonoma.app/app/acme/pull-requests/42/snapshots/snap_1/investigation",
    previewUrl: "https://preview.example.com",
    assetBaseUrl: "https://beta.autonoma.app/github-comment/",
};

function verdict(category: string): InvestigationVerdict {
    return {
        category,
        isClientBug: category === "client_bug",
        ran: true,
        confidence: "high",
        headline: `${category} headline`,
        falsePositiveRisk: "low",
        whatHappened: "what happened",
        rootCause: "root cause",
        remediation: "do the fix",
        evidence: [{ source: "diff", detail: "the change", file: "app/x.ts", lines: "1-2", snippet: "- a\n+ b" }],
    };
}

function result(slug: string, category: string, extra: Partial<InvestigationTestResult> = {}): InvestigationTestResult {
    return { slug, plan: "", runSuccess: false, stepCount: 1, verdict: verdict(category), ...extra };
}

const noSign = async (): Promise<undefined> => undefined;

describe("buildInvestigationCommentPayload", () => {
    it("is critical, lists client bugs as rich findings, and signs their screenshots", async () => {
        const signed: string[] = [];
        const payload = await buildInvestigationCommentPayload(
            [result("csv-export", "client_bug", { finalScreenshotUrl: "s3://b/shot.png" }), result("ok", "passed")],
            context,
            async (url) => {
                signed.push(url);
                return `signed:${url}`;
            },
        );

        expect(payload.state).toBe("critical");
        expect(payload.bugs).toHaveLength(1);
        expect(payload.bugs[0]).toMatchObject({
            title: "client_bug headline",
            description: "what happened",
            remediation: "do the fix",
            screenshotUrl: "signed:s3://b/shot.png",
            evidence: [{ source: "diff", file: "app/x.ts", lines: "1-2", snippet: "- a\n+ b" }],
        });
        expect(payload.bugs[0]?.href).toContain("/investigation/csv-export");
        expect(signed).toEqual(["s3://b/shot.png"]);
    });

    it("is a warning when only actionable findings exist (no client bug)", async () => {
        const payload = await buildInvestigationCommentPayload(
            [result("scenario", "scenario_issue"), result("env", "environment_failure")],
            context,
            noSign,
        );

        expect(payload.state).toBe("warning");
        expect(payload.bugs).toHaveLength(2);
    });

    it("appends the scenario repair route (and client-factory change) to the remediation when diagnosed", async () => {
        const payload = await buildInvestigationCommentPayload(
            [
                result("integrations", "scenario_issue", {
                    scenarioDiagnosis: {
                        route: "recipe_and_sdk",
                        confidence: "high",
                        reasoning: "the factory has no handler for this model",
                        factoryIssue: "register a defineFactory for external_connectors",
                    },
                }),
            ],
            context,
            noSign,
        );

        const remediation = payload.bugs[0]?.remediation ?? "";
        expect(remediation).toContain("do the fix");
        expect(remediation).toContain("Repair route: `recipe_and_sdk`");
        expect(remediation).toContain("Client factory change: register a defineFactory for external_connectors");
    });

    it("is healthy when nothing is actionable", async () => {
        const payload = await buildInvestigationCommentPayload([result("ok", "passed")], context, noSign);

        expect(payload.state).toBe("healthy");
        expect(payload.bugs).toHaveLength(0);
    });

    it("adds the preview CTA only when a preview URL is present", async () => {
        const withPreview = await buildInvestigationCommentPayload([result("ok", "passed")], context, noSign);
        expect(withPreview.ctas.map((cta) => cta.label)).toEqual(["Open in Autonoma", "See preview"]);

        const withoutPreview = await buildInvestigationCommentPayload(
            [result("ok", "passed")],
            { ...context, previewUrl: undefined },
            noSign,
        );
        expect(withoutPreview.ctas.map((cta) => cta.label)).toEqual(["Open in Autonoma"]);
    });
});
