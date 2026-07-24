import { DEPRECATED_BUILD_FRAMEWORKS } from "@autonoma/types";
import { describe, expect, it } from "vitest";
import {
    defaultPreviewkitConfig,
    kebabCaseAppName,
    parseAuthoredConfigShapeOrThrow,
    parseConfigShapeOrThrow,
} from "../../../src/routes/onboarding/previewkit-config-helpers";

describe("kebabCaseAppName", () => {
    it.each([
        ["Boss Roast", "boss-roast"],
        ["TOMASPIAGGIO/Boss-Roast", "tomaspiaggio-boss-roast"],
        ["my_v0 project!!", "my-v0-project"],
        ["  spaced  out  ", "spaced-out"],
        ["already-kebab", "already-kebab"],
    ])("kebab-cases %j -> %j", (input, expected) => {
        expect(kebabCaseAppName(input)).toBe(expected);
    });

    it.each([undefined, "", "  ", "!!!", "x", "@"])("falls back to web for unusable input %j", (input) => {
        expect(kebabCaseAppName(input)).toBe("web");
    });

    it("never exceeds the 63-char Kubernetes limit", () => {
        const result = kebabCaseAppName("a".repeat(200));
        expect(result.length).toBeLessThanOrEqual(63);
    });
});

describe("defaultPreviewkitConfig", () => {
    it("names the starter app after the application (kebab-cased)", () => {
        const config = defaultPreviewkitConfig("Boss Roast");
        expect(config.apps[0]?.name).toBe("boss-roast");
        expect(config.apps[0]?.primary).toBe(true);
    });

    it("falls back to web when no application name is given", () => {
        expect(defaultPreviewkitConfig().apps[0]?.name).toBe("web");
    });

    it("always produces a schema-valid name, even for a single-character app name", () => {
        // The k8s name schema requires >= 2 chars; a 1-char slug must fall back.
        expect(() => defaultPreviewkitConfig("Q")).not.toThrow();
        expect(defaultPreviewkitConfig("Q").apps[0]?.name).toBe("web");
    });

    it("seeds a complete runtime build block so the starter is deployable as-is", () => {
        // The starter must be a valid, complete app out of the box - no separate
        // "edit before you can deploy" gate. A runtime build with a non-empty
        // entrypoint is what makes it schema-valid and immediately deployable.
        const build = defaultPreviewkitConfig("Boss Roast").apps[0]?.build;
        expect(build?.framework).toBe("runtime");
        if (build?.framework !== "runtime") throw new Error("expected a runtime build");
        expect(build.runtime).toBe("node");
        expect(build.entrypoint.trim()).not.toBe("");
    });
});

describe("config write contracts", () => {
    function documentWithBuild(build: unknown) {
        return {
            version: 1,
            apps: [{ name: "web", port: 3000, build }],
        };
    }

    const runtimeBuild = { framework: "runtime", runtime: "node", entrypoint: "npm start" };

    it.each(DEPRECATED_BUILD_FRAMEWORKS)("keeps the shared write path open for a stored %s preset", (framework) => {
        // The debug surfaces read a stored document, patch one field and save it
        // back; a build block they never touched must not block that.
        expect(() => parseConfigShapeOrThrow(documentWithBuild({ framework }))).not.toThrow();
    });

    it.each(DEPRECATED_BUILD_FRAMEWORKS)("refuses to let onboarding author a %s preset", (framework) => {
        expect(() => parseAuthoredConfigShapeOrThrow(documentWithBuild({ framework }))).toThrow(/runtime/);
    });

    it("accepts an authorable build on both paths", () => {
        expect(() => parseConfigShapeOrThrow(documentWithBuild(runtimeBuild))).not.toThrow();
        expect(() => parseAuthoredConfigShapeOrThrow(documentWithBuild(runtimeBuild))).not.toThrow();
    });

    it("rejects a malformed document on both paths", () => {
        expect(() => parseConfigShapeOrThrow({ version: 1, apps: [] })).toThrow();
        expect(() => parseAuthoredConfigShapeOrThrow({ version: 1, apps: [] })).toThrow();
    });
});
