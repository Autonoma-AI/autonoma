import { describe, expect, it } from "vitest";
import { buildPreviewCacheReference, buildPreviewImageReference } from "../../src/builder/image-reference";

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
    };

    it("stores every image under the single shared repository", () => {
        const ref = buildPreviewImageReference(base);
        expect(ref.startsWith(`${REGISTRY}/previewkit/previews:`)).toBe(true);
    });

    it("keeps the readable identity plus a PR suffix in the tag, with no commit SHA", () => {
        const tag = tagOf(buildPreviewImageReference(base));
        expect(tag.startsWith("acme-web-frontend-")).toBe(true);
        expect(tag.endsWith("-pr-42")).toBe(true);
    });

    it("inserts an 8-char hex discriminator between the slug and the PR suffix", () => {
        const tag = tagOf(buildPreviewImageReference(base));
        expect(tag).toMatch(/^acme-web-frontend-[0-9a-f]{8}-pr-42$/);
    });

    it("is stable across commits for the same (app, PR), so a rebuild overwrites the same tag", () => {
        expect(buildPreviewImageReference(base)).toBe(buildPreviewImageReference({ ...base, prNumber: 42 }));
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

describe("buildPreviewCacheReference", () => {
    const base = { registry: REGISTRY, org: "acme", repo: "web", appName: "frontend" };

    it("stores the cache under the single shared repository", () => {
        const ref = buildPreviewCacheReference(base);
        expect(ref.startsWith(`${REGISTRY}/previewkit/previews:`)).toBe(true);
    });

    it("uses a `-cache` suffix with no PR/SHA in the tag", () => {
        const tag = tagOf(buildPreviewCacheReference(base));
        expect(tag).toMatch(/^acme-web-frontend-[0-9a-f]{8}-cache$/);
    });

    it("matches the same discriminator buildPreviewImageReference uses for this identity", () => {
        const cacheTag = tagOf(buildPreviewCacheReference(base));
        const imageTag = tagOf(buildPreviewImageReference({ ...base, prNumber: 1 }));
        const discriminatorOf = (tag: string) => tag.match(/-([0-9a-f]{8})-/)?.[1];
        expect(discriminatorOf(cacheTag)).toBe(discriminatorOf(imageTag));
    });

    it("is stable across PRs and commits for the same app (idempotent)", () => {
        expect(buildPreviewCacheReference(base)).toBe(buildPreviewCacheReference(base));
    });

    it("differs between apps in the same repo", () => {
        expect(buildPreviewCacheReference(base)).not.toBe(buildPreviewCacheReference({ ...base, appName: "api" }));
    });

    it("produces a valid Docker tag across a range of inputs", () => {
        const cases = [
            { ...base },
            { ...base, org: "BigCorp", repo: "some.repo", appName: "API_Server" },
            { ...base, org: "x".repeat(60), repo: "y".repeat(60), appName: "z".repeat(60) },
        ];
        for (const input of cases) {
            expect(tagOf(buildPreviewCacheReference(input))).toMatch(DOCKER_TAG_REGEX);
        }
    });
});
