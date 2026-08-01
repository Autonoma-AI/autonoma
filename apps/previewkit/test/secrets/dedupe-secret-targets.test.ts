import { describe, expect, it } from "vitest";
import { dedupeSecretRecordsByTarget } from "../../src/secrets/dedupe-secret-targets";
import { previewSecretName } from "../../src/secrets/preview-secret-name";

describe("dedupeSecretRecordsByTarget", () => {
    it("keeps every bundle when targets are distinct", () => {
        const records = [
            { applicationId: "app", appName: "web" },
            { applicationId: "app", appName: "api" },
        ];
        const { chosen, collisions } = dedupeSecretRecordsByTarget(records, previewSecretName);

        expect(collisions).toEqual([]);
        expect(chosen.map((c) => c.secretName)).toEqual(["web-secrets", "api-secrets"]);
        expect(chosen.map((c) => c.record.appName)).toEqual(["web", "api"]);
    });

    it("collapses bundles that fold to one target, keeping one and reporting the rest", () => {
        // "boss-roast" and "boss--roast" both normalize to boss-roast-secrets.
        const records = [
            { applicationId: "app", appName: "boss--roast" },
            { applicationId: "app", appName: "boss-roast" },
        ];
        const { chosen, collisions } = dedupeSecretRecordsByTarget(records, previewSecretName);

        expect(chosen).toHaveLength(1);
        expect(chosen[0]?.secretName).toBe("boss-roast-secrets");
        // Ascending appName, so the winner does not depend on the order rows came back in.
        expect(chosen[0]?.record.appName).toBe("boss--roast");

        expect(collisions).toHaveLength(1);
        expect(collisions[0]?.kept.appName).toBe("boss--roast");
        expect(collisions[0]?.dropped.map((r) => r.appName)).toEqual(["boss-roast"]);
    });

    it("picks the same winner whichever order the bundles arrive in", () => {
        const forwards = dedupeSecretRecordsByTarget(
            [
                { applicationId: "app", appName: "boss-roast" },
                { applicationId: "app", appName: "boss--roast" },
            ],
            previewSecretName,
        );
        const backwards = dedupeSecretRecordsByTarget(
            [
                { applicationId: "app", appName: "boss--roast" },
                { applicationId: "app", appName: "boss-roast" },
            ],
            previewSecretName,
        );

        // A deploy that picked differently each run would flip the preview's credentials.
        expect(forwards.chosen[0]?.record.appName).toBe(backwards.chosen[0]?.record.appName);
    });

    it("returns nothing for no bundles", () => {
        expect(dedupeSecretRecordsByTarget([], previewSecretName)).toEqual({ chosen: [], collisions: [] });
    });
});
