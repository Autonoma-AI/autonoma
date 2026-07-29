import { PREVIEW_FRONT_DOOR_PATH } from "@autonoma/types";
import { describe, expect, it } from "vitest";
import { resolveFrontDoorRedirect } from "../../../src/routes/preview-access/preview-front-door-decision";

// Imports the env-free decision module, NOT preview-front-door.ts: that file's
// `import { env }` createEnv-validates every var at module load and fails in a bare
// unit-test shard (the whole reason the decision lives in its own file). The handler
// just wires env into this.
const APP_URL = "https://autonoma.app";
const DOMAIN = "autonoma.app";
const PREVIEW = "https://a3f8b21c4d9e.preview.autonoma.app";

function decide(overrides: Partial<Parameters<typeof resolveFrontDoorRedirect>[0]>) {
    return resolveFrontDoorRedirect({
        to: PREVIEW,
        secFetchMode: undefined,
        accept: undefined,
        appUrl: APP_URL,
        internalDomain: DOMAIN,
        ...overrides,
    });
}

describe("resolveFrontDoorRedirect", () => {
    it("sends a browser navigation to the SPA waiting page (302)", () => {
        const decision = decide({ secFetchMode: "navigate", accept: "text/html" });
        expect(decision.kind).toBe("waiting");
        expect(decision.kind === "waiting" && decision.location).toBe(
            `${APP_URL}/preview-waiting?to=${encodeURIComponent(PREVIEW)}`,
        );
    });

    it("falls back to Accept: text/html when Sec-Fetch-Mode is absent", () => {
        expect(decide({ accept: "text/html,application/xhtml+xml" }).kind).toBe("waiting");
    });

    it("passes a non-browser caller straight through to the raw preview (307)", () => {
        const decision = decide({ accept: "*/*" });
        expect(decision.kind).toBe("passthrough");
        expect(decision.kind === "passthrough" && decision.location).toBe(PREVIEW);
    });

    it("rejects a non-preview or missing target", () => {
        expect(decide({ to: "https://evil.example", secFetchMode: "navigate" }).kind).toBe("invalid");
        expect(decide({ to: undefined }).kind).toBe("invalid");
    });
});

describe("PREVIEW_FRONT_DOOR_PATH", () => {
    // The one written form the API mount and every link emitter must agree on.
    it("is the previewkit /open path", () => {
        expect(PREVIEW_FRONT_DOOR_PATH).toBe("/v1/previewkit/open");
    });
});
