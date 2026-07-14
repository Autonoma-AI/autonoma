import { describe, expect, it } from "vitest";
import { dedupeSecretRecordsByTarget } from "../../src/secrets/dedupe-secret-targets";

// Mirrors AwsExternalSecretManager.toK8sName closely enough to exercise folding.
function toSecretName(appName: string): string {
    return appName
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 55)
        .concat("-secrets");
}

describe("dedupeSecretRecordsByTarget", () => {
    it("keeps every row when targets are distinct", () => {
        const records = [
            { id: "a", appName: "web", awsSecretArn: "arn:web" },
            { id: "b", appName: "api", awsSecretArn: "arn:api" },
        ];
        const { chosen, collisions } = dedupeSecretRecordsByTarget(records, toSecretName);

        expect(collisions).toEqual([]);
        expect(chosen.map((c) => c.secretName)).toEqual(["web-secrets", "api-secrets"]);
        expect(chosen.map((c) => c.record.id)).toEqual(["a", "b"]);
    });

    it("collapses rows that fold to one target, keeping the oldest and reporting the rest", () => {
        // "boss-roast" and "boss--roast" both normalize to boss-roast-secrets.
        const records = [
            { id: "cmr2", appName: "boss--roast", awsSecretArn: "arn:same" },
            { id: "cmr1", appName: "boss-roast", awsSecretArn: "arn:same" },
        ];
        const { chosen, collisions } = dedupeSecretRecordsByTarget(records, toSecretName);

        expect(chosen).toHaveLength(1);
        expect(chosen[0]?.secretName).toBe("boss-roast-secrets");
        // cmr1 sorts before cmr2, so it is the kept (oldest) row.
        expect(chosen[0]?.record.id).toBe("cmr1");

        expect(collisions).toHaveLength(1);
        expect(collisions[0]?.kept.id).toBe("cmr1");
        expect(collisions[0]?.dropped.map((r) => r.id)).toEqual(["cmr2"]);
    });

    it("returns nothing for no rows", () => {
        expect(dedupeSecretRecordsByTarget([], toSecretName)).toEqual({ chosen: [], collisions: [] });
    });
});
