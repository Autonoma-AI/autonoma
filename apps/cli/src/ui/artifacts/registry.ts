import type { Artifact, ContentKind } from "../types";

/**
 * The well-known pipeline artifacts: human title (the primary label in the
 * FILES list and hero header) plus a friendly one-liner. Display-only: the
 * on-disk names are contracts (downstream agents and the handoff prompt
 * reference them) and must never change. Test files aren't listed; their
 * kebab names are already self-describing.
 */
const KNOWN_FILES: Record<string, { title: string; description?: string }> = {
    "project-map.json": { title: "Project Map", description: "Your repo's frontend + backend layout" },
    "pages.json": { title: "Page Inventory", description: "Every route in the app" },
    "AUTONOMA.md": { title: "Knowledge Base", description: "What your app does" },
    "entity-audit.md": { title: "Database Entity Analysis", description: "What your app stores" },
    "scenarios.md": { title: "Test Data Scenarios", description: "The data your tests run against" },
    "recipe.json": { title: "Test Data Recipe", description: "How test data is created" },
    "IMPLEMENTATION.md": { title: "SDK Integration Checklist", description: "SDK integration progress notes" },
    "INDEX.md": { title: "Test Suite Index", description: "Every test in the suite" },
    "integration-prompt.md": { title: "Integration Instructions", description: "The coding agent's spec" },
    "autonoma-config.json": { title: "Planner Config", description: "How the planner runs on this repo" },
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

/** Human title for a well-known artifact; undefined for tests/unknown files. */
export function titleOf(relPath: string): string | undefined {
    return KNOWN_FILES[basename(relPath)]?.title;
}

/** Human description for an artifact given its path relative to the output dir. */
export function describeArtifact(relPath: string): string | undefined {
    const name = basename(relPath);
    const known = KNOWN_FILES[name]?.description;
    if (known != null) return known;
    // Tests nest arbitrarily deep (qa-tests/<area>/<sub>/...); the folder path
    // is what distinguishes same-named tests, so show it under the name.
    if (iconOf(relPath) === "test") {
        const dir = relPath.split("/").slice(0, -1).join("/");
        return dir === "" ? "natural-language test" : `${dir}/`;
    }
    return undefined;
}
