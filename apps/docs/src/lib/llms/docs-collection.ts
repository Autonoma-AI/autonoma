import { type CollectionEntry, getCollection } from "astro:content";

/**
 * Page order matching the sidebar configuration.
 * Each entry is the slug used in the sidebar config.
 * Empty string represents the index/introduction page.
 */
const SIDEBAR_ORDER: string[] = [
    "index",
    "previewkit/index",
    "test-planner/index",
    "environment-factory/index",
    "environment-factory/setup",
    "environment-factory/factories",
    "environment-factory/authentication",
    "environment-factory/security",
    "environment-factory/examples/index",
    "environment-factory/examples/typescript",
    "environment-factory/examples/python",
    "environment-factory/examples/elixir",
    "environment-factory/examples/java",
    "environment-factory/examples/ruby",
    "environment-factory/examples/rust",
    "environment-factory/examples/go",
    "environment-factory/examples/php",
    "previewkit/secrets",
    "reference/scenario-recipe-schema",
    "development/setup",
    "development/architecture",
    "development/packages",
    "development/conventions",
    "development/workflows",
    "development/environment-variables",
    "architecture/execution-agent",
    "architecture/ai-package",
];

export interface DocPage {
    entry: CollectionEntry<"docs">;
    slug: string;
    title: string;
    description: string;
}

export interface DocPageWithNav extends DocPage {
    previous?: { slug: string; title: string };
    next?: { slug: string; title: string };
}

function slugFromId(id: string): string {
    // With glob loader, id is like "index.mdx", "test-planner/index.md", "guides/environment-factory.md"
    return id
        .replace(/\.mdx?$/, "")
        .replace(/\/index$/, "")
        .replace(/^index$/, "");
}

function entryId(entry: CollectionEntry<"docs">): string {
    return entry.id;
}

export async function getOrderedDocs(): Promise<DocPage[]> {
    const allDocs = await getCollection("docs");
    const docsById = new Map<string, CollectionEntry<"docs">>();
    for (const doc of allDocs) {
        docsById.set(entryId(doc), doc);
    }

    const ordered: DocPage[] = [];
    for (const id of SIDEBAR_ORDER) {
        const entry = docsById.get(id);
        if (entry == null) continue;
        ordered.push({
            entry,
            slug: slugFromId(entryId(entry)),
            title: entry.data.title,
            description: entry.data.description ?? "",
        });
    }

    // Append any pages not in sidebar order
    for (const [id, entry] of docsById) {
        if (!SIDEBAR_ORDER.includes(id)) {
            ordered.push({
                entry,
                slug: slugFromId(id),
                title: entry.data.title,
                description: entry.data.description ?? "",
            });
        }
    }

    return ordered;
}

export function withNavigation(docs: DocPage[]): DocPageWithNav[] {
    return docs.map((doc, i) => {
        const previous = docs[i - 1];
        const next = docs[i + 1];
        return {
            ...doc,
            previous: previous != null ? { slug: previous.slug, title: previous.title } : undefined,
            next: next != null ? { slug: next.slug, title: next.title } : undefined,
        };
    });
}

/**
 * Convert a page slug to its llms.txt file path.
 * "" -> "/llms/index.txt"
 * "test-planner" -> "/llms/test-planner.txt"
 */
export function llmsPath(slug: string): string {
    const filename = slug === "" ? "index" : slug;
    return `/llms/${filename}.txt`;
}
