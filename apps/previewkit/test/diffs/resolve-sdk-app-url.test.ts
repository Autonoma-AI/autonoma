import { describe, expect, it } from "vitest";
import type { AppRole } from "../../src/config/schema";
import { resolveSdkAppUrl } from "../../src/diffs/resolve-sdk-app-url";

const URLS = {
    api: "https://api.preview.example.com",
    web: "https://web.preview.example.com",
};

/** A single-repo project: the merged topology is exactly this repo's apps. */
const singleRepo = (apps: AppRole[]) => ({ all: apps, primaryRepo: apps });

describe("resolveSdkAppUrl", () => {
    it("targets the app flagged sdk_implemented, not the browsed frontend", () => {
        const apps: AppRole[] = [
            { name: "api", sdk_implemented: true },
            { name: "web", primary: true },
        ];
        expect(resolveSdkAppUrl(singleRepo(apps), URLS)).toBe(URLS.api);
    });

    it("targets an app that is both the frontend and the SDK host", () => {
        const apps: AppRole[] = [{ name: "web", primary: true, sdk_implemented: true }, { name: "api" }];
        expect(resolveSdkAppUrl(singleRepo(apps), URLS)).toBe(URLS.web);
    });

    it("falls back to the primary app when no app declares the SDK", () => {
        const apps: AppRole[] = [{ name: "api" }, { name: "web", primary: true }];
        expect(resolveSdkAppUrl(singleRepo(apps), URLS)).toBe(URLS.web);
    });

    it("falls back to the first app when nothing is declared at all", () => {
        const apps: AppRole[] = [{ name: "api" }, { name: "web" }];
        expect(resolveSdkAppUrl(singleRepo(apps), URLS)).toBe(URLS.api);
    });

    it("returns undefined when the SDK app has no deployed url", () => {
        const apps: AppRole[] = [{ name: "worker", sdk_implemented: true }];
        expect(resolveSdkAppUrl(singleRepo(apps), URLS)).toBeUndefined();
    });

    describe("multirepo", () => {
        // This repo serves the frontend; its API - and the handler - come from a
        // connected repo, so the declaration only exists in the merged topology.
        const primaryRepo: AppRole[] = [{ name: "web", primary: true }];
        const dependencyApps: AppRole[] = [{ name: "api", sdk_implemented: true }];

        it("targets a connected repo's app when that is where the handler lives", () => {
            const scope = { all: [...primaryRepo, ...dependencyApps], primaryRepo };
            expect(resolveSdkAppUrl(scope, URLS)).toBe(URLS.api);
        });

        it("never falls back to a connected repo's app when nothing is declared", () => {
            const scope = { all: [...primaryRepo, { name: "api" }], primaryRepo };
            expect(resolveSdkAppUrl(scope, URLS)).toBe(URLS.web);
        });
    });
});
