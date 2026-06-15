import { describe, expect, it } from "vitest";
import { buildPreviewImageReference } from "../../src/builder/image-reference";

const REGISTRY = "140023360995.dkr.ecr.us-east-1.amazonaws.com";

// The Docker/OCI tag grammar: a word character followed by up to 127 of
// [word, '.', '-']. buildctl rejects anything else on push.
const DOCKER_TAG_REGEX = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

/** Everything after the fixed `previewkit/previews:` repo path is the tag. */
function tagOf(reference: string): string {
    const tag = reference.split("previewkit/previews:")[1];
    if (tag == null) throw new Error(`reference missing the shared repo path: ${reference}`);
    return tag;
}

describe("buildPreviewImageReference", () => {
    const base = {
        registry: REGISTRY,
        org: "acme",
        repo: "web",
        appName: "frontend",
        prNumber: 42,
        shortSha: "abc1234",
    };

    it("stores every image under the single shared repository", () => {
        const ref = buildPreviewImageReference(base);
        expect(ref.startsWith(`${REGISTRY}/previewkit/previews:`)).toBe(true);
    });

    it("keeps the readable identity plus a PR/SHA suffix in the tag", () => {
        const tag = tagOf(buildPreviewImageReference(base));
        expect(tag.startsWith("acme-web-frontend-")).toBe(true);
        expect(tag.endsWith("-pr-42-abc1234")).toBe(true);
    });

    it("inserts an 8-char hex discriminator between the slug and the PR suffix", () => {
        const tag = tagOf(buildPreviewImageReference(base));
        expect(tag).toMatch(/^acme-web-frontend-[0-9a-f]{8}-pr-42-abc1234$/);
    });

    it("lowercases and replaces disallowed characters, preserving dots and underscores", () => {
        const ref = buildPreviewImageReference({ ...base, org: "Acme.Corp", repo: "My_Repo", appName: "web/ui" });
        expect(tagOf(ref).startsWith("acme.corp-my_repo-web-ui-")).toBe(true);
    });

    it("stays within the 128-char tag limit for pathological lengths", () => {
        const tag = tagOf(
            buildPreviewImageReference({
                registry: REGISTRY,
                org: "a".repeat(39), // GitHub max owner length
                repo: "b".repeat(100), // GitHub max repo length
                appName: "c".repeat(100),
                prNumber: 9999999,
                shortSha: "abc1234",
            }),
        );
        expect(tag.length).toBeLessThanOrEqual(128);
        expect(tag).toMatch(DOCKER_TAG_REGEX);
    });

    it("distinguishes identities that collide after slug truncation", () => {
        // org+repo alone exceed the readable budget, so the app name is sliced
        // off the slug entirely - only the hash can tell these two apart.
        const shared = {
            registry: REGISTRY,
            org: "a".repeat(40),
            repo: "b".repeat(50),
            prNumber: 7,
            shortSha: "abc1234",
        };
        const web = buildPreviewImageReference({ ...shared, appName: "web" });
        const api = buildPreviewImageReference({ ...shared, appName: "api" });

        expect(tagOf(web)).not.toBe(tagOf(api));
        // ...but they share the truncated readable slug, proving the hash is what disambiguates.
        const slug = (ref: string) =>
            tagOf(ref)
                .split("-pr-")[0]!
                .replace(/-[0-9a-f]{8}$/, "");
        expect(slug(web)).toBe(slug(api));
    });

    it("produces a valid Docker tag across a range of inputs", () => {
        const cases = [
            { ...base },
            { ...base, org: "BigCorp", repo: "some.repo", appName: "API_Server" },
            { ...base, org: "a---b", repo: "..weird..", appName: "--app--" },
            { ...base, org: "x".repeat(60), repo: "y".repeat(60), appName: "z".repeat(60) },
        ];
        for (const input of cases) {
            expect(tagOf(buildPreviewImageReference(input))).toMatch(DOCKER_TAG_REGEX);
        }
    });

    it("is stable for the same input (idempotent)", () => {
        expect(buildPreviewImageReference(base)).toBe(buildPreviewImageReference(base));
    });
});
