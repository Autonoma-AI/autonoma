import { previewConfigSchema, type SuggestedEnvVar } from "@autonoma/types";
import { describe, expect, it } from "vitest";
import {
    PRIMARY_REPO_KEY,
    diffAppSecrets,
    documentsFromDraft,
    emptyAppDraft,
    envRow,
    envRowsFromSuggestions,
    withSecretRows,
    type TopologyDraft,
} from "./topology-draft";

function suggestion(key: string, opts: Partial<SuggestedEnvVar> = {}): SuggestedEnvVar {
    return { key, sensitive: false, confidence: "medium", evidence: [], ...opts };
}

function draftWithApp(env: ReturnType<typeof envRow>[]): TopologyDraft {
    const app = emptyAppDraft(PRIMARY_REPO_KEY);
    app.name = "web";
    app.path = ".";
    app.port = "3000";
    app.origin = "manual";
    app.env = env;
    return {
        apps: [app],
        services: [],
        repos: [],
        branchConvention: { type: "none" },
        hooks: { pre_deploy: [], post_deploy: [] },
        passthrough: {},
    };
}

describe("topology-draft secrets", () => {
    it("keeps sensitive rows out of the compiled plaintext env", () => {
        const draft = draftWithApp([
            envRow("PUBLIC_URL", "http://x", false, "new"),
            envRow("SECRET_TOKEN", "shhh", true, "new"),
        ]);
        const parsed = previewConfigSchema.parse(documentsFromDraft(draft).primary.document);
        expect(parsed.apps[0]?.env).toEqual({ PUBLIC_URL: "http://x" });
    });

    it("diffs sensitive rows into upserts (with values) and deletes (removed keys)", () => {
        const rows = [
            envRow("API_KEY", "new-value", true, "new"),
            // An existing secret re-loaded with no value must not be re-uploaded.
            envRow("KEEP_KEY", "", true, "secret"),
        ];
        const diff = diffAppSecrets(rows, ["KEEP_KEY", "GONE_KEY"]);
        expect(diff.upserts).toEqual([{ key: "API_KEY", value: "new-value" }]);
        expect(diff.deletes).toEqual(["GONE_KEY"]);
    });

    it("seeds existing secret keys as masked sensitive rows without duplicating present keys", () => {
        const seeded = withSecretRows([envRow("PUBLIC_URL", "http://x", false, "config")], ["API_KEY", "PUBLIC_URL"]);
        const apiKey = seeded.find((row) => row.key === "API_KEY");
        expect(apiKey).toMatchObject({ sensitive: true, value: "", origin: "secret" });
        // PUBLIC_URL already present as a plaintext row is not re-added as a secret.
        expect(seeded.filter((row) => row.key === "PUBLIC_URL")).toHaveLength(1);
    });
});

describe("envRowsFromSuggestions", () => {
    it("adds every non-duplicate suggestion in one batch, so Accept all keeps them all", () => {
        const rows = envRowsFromSuggestions(
            [],
            [suggestion("A", { value: "1" }), suggestion("B", { value: "2" }), suggestion("C")],
            true,
        );
        expect(rows.map((row) => row.key)).toEqual(["A", "B", "C"]);
    });

    it("dedupes against existing rows and within the batch", () => {
        const rows = envRowsFromSuggestions(
            [envRow("A", "x", false, "config")],
            [suggestion("A"), suggestion("B"), suggestion("B")],
            true,
        );
        expect(rows.map((row) => row.key)).toEqual(["B"]);
    });

    it("forces the sensitive flag off when the owner cannot store secrets", () => {
        const [plain] = envRowsFromSuggestions([], [suggestion("TOKEN", { sensitive: true })], false);
        expect(plain?.sensitive).toBe(false);
        const [secret] = envRowsFromSuggestions([], [suggestion("TOKEN", { sensitive: true })], true);
        expect(secret?.sensitive).toBe(true);
    });

    it("uses the service reference token as the row value when present", () => {
        const [row] = envRowsFromSuggestions(
            [],
            [suggestion("DATABASE_URL", { reference: "{{db.url}}", value: "ignored" })],
            true,
        );
        expect(row?.value).toBe("{{db.url}}");
    });
});
