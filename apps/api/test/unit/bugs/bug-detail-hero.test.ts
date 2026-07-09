import { tmpdir } from "node:os";
import { LocalStorageProvider } from "@autonoma/storage";
import type { IssueReport } from "@autonoma/types";
import { describe, expect, it } from "vitest";
import { buildHeroMedia } from "../../../src/routes/bugs/bug-detail-hero";
import type { LatestOccurrenceEvidence } from "../../../src/routes/bugs/bug-detail-latest-occurrence";

type Latest = NonNullable<LatestOccurrenceEvidence>;

const storage = new LocalStorageProvider(tmpdir());

function report(primaryScreenshot: IssueReport["primaryScreenshot"]): IssueReport {
    return {
        actualBehavior: "the page stayed on the login screen",
        narrativeMarkdown: "## Why\nThe click is swallowed.",
        primaryScreenshot,
    };
}

function makeLatest(overrides: Partial<Latest>): Latest {
    return {
        issueId: "i1",
        source: "run",
        sourceId: "r1",
        runId: "r1",
        generationId: undefined,
        testSlug: "login-flow",
        stepIndex: 2,
        stepCount: 5,
        actionLabel: 'agent.click("Login")',
        outcomeLabel: "success",
        whatHappened: "nothing happened after the click",
        lastPassingScreenshotUrl: undefined,
        failureScreenshotUrl: undefined,
        point: undefined,
        startPoint: undefined,
        endPoint: undefined,
        reproductionSteps: [],
        videoUrl: undefined,
        ...overrides,
    };
}

describe("buildHeroMedia", () => {
    it("prefers the healing-designated primary screenshot and draws its pin, even when a failing-step frame also exists", async () => {
        const latest = makeLatest({
            failureScreenshotUrl: "file:///signed/failing-step.png",
            point: { x: 1, y: 2 },
            videoUrl: "file:///signed/run.webm",
        });

        const hero = await buildHeroMedia(
            report({ s3Key: "runs/r1/primary.png", pin: { x: 5, y: 6 } }),
            latest,
            storage,
        );

        expect(hero.screenshot?.url).toContain("runs/r1/primary.png");
        expect(hero.screenshot?.points).toEqual([{ x: 5, y: 6, role: "click" }]);
        expect(hero.video?.url).toBe("file:///signed/run.webm");
    });

    it("renders the primary screenshot without a pin when it carries no coordinate", async () => {
        const hero = await buildHeroMedia(report({ s3Key: "runs/r1/primary.png" }), makeLatest({}), storage);

        expect(hero.screenshot?.url).toContain("runs/r1/primary.png");
        expect(hero.screenshot?.points).toEqual([]);
    });

    it("falls back to the failing-step screenshot and its resolved points when no primary is designated", async () => {
        const latest = makeLatest({
            failureScreenshotUrl: "file:///signed/failing-step.png",
            point: { x: 1, y: 2 },
        });

        const hero = await buildHeroMedia(report(undefined), latest, storage);

        expect(hero.screenshot?.url).toBe("file:///signed/failing-step.png");
        expect(hero.screenshot?.points).toEqual([{ x: 1, y: 2, role: "click" }]);
    });

    it("still resolves the video and screenshot when there is no report at all", async () => {
        const latest = makeLatest({
            failureScreenshotUrl: "file:///signed/failing-step.png",
            videoUrl: "file:///v.webm",
        });

        const hero = await buildHeroMedia(undefined, latest, storage);

        expect(hero.screenshot?.url).toBe("file:///signed/failing-step.png");
        expect(hero.video?.url).toBe("file:///v.webm");
    });

    it("returns no screenshot when neither a primary nor a failing-step frame exists", async () => {
        const hero = await buildHeroMedia(report(undefined), makeLatest({ videoUrl: "file:///v.webm" }), storage);

        expect(hero.screenshot).toBeUndefined();
        expect(hero.video?.url).toBe("file:///v.webm");
    });

    it("omits the video when the run produced none", async () => {
        const hero = await buildHeroMedia(
            report({ s3Key: "runs/r1/primary.png" }),
            makeLatest({ videoUrl: undefined }),
            storage,
        );

        expect(hero.video).toBeUndefined();
        expect(hero.screenshot?.url).toContain("runs/r1/primary.png");
    });

    it("returns an empty hero when there is neither media nor an occurrence", async () => {
        const hero = await buildHeroMedia(undefined, undefined, storage);

        expect(hero.screenshot).toBeUndefined();
        expect(hero.video).toBeUndefined();
    });
});
