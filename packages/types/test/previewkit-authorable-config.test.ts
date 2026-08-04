import { describe, expect, it } from "vitest";
import { toAuthorableDocument } from "../src/schemas/previewkit-authorable-config";
import { authoringPreviewConfigSchema, previewConfigSchema } from "../src/schemas/previewkit-config";

function storedDocument(build: unknown, appName = "web") {
    return previewConfigSchema.parse({
        version: 2,
        apps: [{ name: appName, repository: "acme/web", port: 3000, build }],
    });
}

describe("toAuthorableDocument", () => {
    it("makes a document carrying a retired preset saveable again", () => {
        const stored = storedDocument({ framework: "next", package_manager: "pnpm", node_version: "22" });
        // The read-back document is what an agent would echo, and it is rejected.
        expect(authoringPreviewConfigSchema.safeParse(stored).success).toBe(false);

        const authorable = toAuthorableDocument(stored);

        expect(authoringPreviewConfigSchema.safeParse(authorable.document).success).toBe(true);
        expect(authorable.unconvertible).toEqual([]);
        expect(authorable.converted).toEqual([
            {
                app: "web",
                from: "next",
                buildScript: "corepack enable\npnpm install --frozen-lockfile\npnpm run build",
                entrypoint: "pnpm start",
            },
        ]);
    });

    it("carries the preset's own commands through rather than the defaults", () => {
        const stored = storedDocument({
            framework: "vite",
            package_manager: "npm",
            node_version: "20",
            install_command: "npm ci --ignore-scripts",
            build_command: "npm run build:prod",
            run_command: "npm run serve",
        });

        const [converted] = toAuthorableDocument(stored).converted;

        expect(converted?.buildScript).toBe("npm ci --ignore-scripts\nnpm run build:prod");
        expect(converted?.entrypoint).toBe("npm run serve");
    });

    it("leaves an already-authorable document exactly as it was", () => {
        const stored = storedDocument({ framework: "dockerfile", dockerfile: "./Dockerfile" });

        const authorable = toAuthorableDocument(stored);

        expect(authorable.document).toEqual(stored);
        expect(authorable.converted).toEqual([]);
        expect(authorable.unconvertible).toEqual([]);
    });

    it("refuses to invent a build for bun, whose image the runtime catalog does not offer", () => {
        const stored = storedDocument({ framework: "bun" });

        const authorable = toAuthorableDocument(stored);

        expect(authorable.converted).toEqual([]);
        expect(authorable.unconvertible).toEqual([
            { app: "web", framework: "bun", reason: expect.stringContaining("Dockerfile") },
        ]);
        // The blocked app keeps its stored build, so nothing is silently rewritten.
        expect(authorable.document.apps[0]?.build).toEqual(stored.apps[0]?.build);
    });

    it("refuses a root build whose turbo filter is resolved from the repository, not the document", () => {
        const stored = storedDocument({
            framework: "next",
            package_manager: "pnpm",
            node_version: "22",
            build_context: "root",
        });

        const authorable = toAuthorableDocument(stored);

        expect(authorable.converted).toEqual([]);
        expect(authorable.unconvertible[0]?.reason).toContain("--filter");
    });

    it("converts a root build once its commands are spelled out", () => {
        const stored = storedDocument({
            framework: "next",
            package_manager: "pnpm",
            node_version: "22",
            build_context: "root",
            build_command: "pnpm exec turbo run build --filter=web",
            run_command: "pnpm exec turbo run start --filter=web",
        });

        const authorable = toAuthorableDocument(stored);

        expect(authorable.unconvertible).toEqual([]);
        expect(authoringPreviewConfigSchema.safeParse(authorable.document).success).toBe(true);
        expect(authorable.converted[0]?.entrypoint).toBe("pnpm exec turbo run start --filter=web");
    });
});
