import type { Artifact, ContentKind } from "../types";

/** Friendly one-liners for the well-known pipeline artifacts. */
const DESCRIPTIONS: Record<string, string> = {
    "project-map.json": "Your repo's frontend + backend layout",
    "pages.json": "Every route in the app",
    "AUTONOMA.md": "What your app does",
    "entity-audit.md": "What your app stores",
    "scenarios.md": "The data your tests run against",
    "recipe.json": "How test data is created",
    "IMPLEMENTATION.md": "SDK integration progress notes",
    "INDEX.md": "Test suite index",
};

export function basename(path: string): string {
    return path.split("/").pop() ?? path;
}

export function kindOf(path: string): ContentKind {
    if (path.endsWith(".json")) return "json";
    if (path.endsWith(".md") || path.endsWith(".markdown")) return "markdown";
    return "plain";
}

/** Whether a path is a generated test file (they sort alphabetically in the FILES list). */
export function isTestArtifact(relPath: string): boolean {
    return relPath.includes("qa-tests/") || relPath.includes("tests/");
}

export function iconOf(relPath: string): Artifact["icon"] {
    if (relPath.endsWith(".json")) return "json";
    if (isTestArtifact(relPath)) return "test";
    return "doc";
}

/** Human description for an artifact given its path relative to the output dir. */
export function describeArtifact(relPath: string): string | undefined {
    const name = basename(relPath);
    const known = DESCRIPTIONS[name];
    if (known != null) return known;
    // Tests nest arbitrarily deep (qa-tests/<area>/<sub>/...); the folder path
    // is what distinguishes same-named tests, so show it under the name.
    if (iconOf(relPath) === "test") {
        const dir = relPath.split("/").slice(0, -1).join("/");
        return dir === "" ? "natural-language test" : `${dir}/`;
    }
    return undefined;
}
