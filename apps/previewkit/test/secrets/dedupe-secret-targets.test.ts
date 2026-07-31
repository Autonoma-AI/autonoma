import { describe, expect, it } from "vitest";
import { dedupeSecretRecordsByTarget } from "../../src/secrets/dedupe-secret-targets";
import { previewSecretName } from "../../src/secrets/preview-secret-name";

describe("dedupeSecretRecordsByTarget", () => {
    it("keeps every row when targets are distinct", () => {
        const records = [
            { applicationId: "app", id: "a", appName: "web" },
            { applicationId: "app", id: "b", appName: "api" },
        ];
        const { chosen, collisions } = dedupeSecretRecordsByTarget(records, previewSecretName);

        expect(collisions).toEqual([]);
        expect(chosen.map((c) => c.secretName)).toEqual(["web-secrets", "api-secrets"]);
        expect(chosen.map((c) => c.record.id)).toEqual(["a", "b"]);
    });

    it("collapses rows that fold to one target, keeping the oldest and reporting the rest", () => {
        // "boss-roast" and "boss--roast" both normalize to boss-roast-secrets.
        const records = [
            { applicationId: "app", id: "cmr2", appName: "boss--roast" },
            { applicationId: "app", id: "cmr1", appName: "boss-roast" },
        ];
        const { chosen, collisions } = dedupeSecretRecordsByTarget(records, previewSecretName);

        expect(chosen).toHaveLength(1);
        expect(chosen[0]?.secretName).toBe("boss-roast-secrets");
        // cmr1 sorts before cmr2, so it is the kept (oldest) row.
        expect(chosen[0]?.record.id).toBe("cmr1");

        expect(collisions).toHaveLength(1);
        expect(collisions[0]?.kept.id).toBe("cmr1");
        expect(collisions[0]?.dropped.map((r) => r.id)).toEqual(["cmr2"]);
    });

    it("returns nothing for no rows", () => {
        expect(dedupeSecretRecordsByTarget([], previewSecretName)).toEqual({ chosen: [], collisions: [] });
    });
});
