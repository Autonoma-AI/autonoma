import { type CollectionEntry, getCollection } from "astro:content";

/**
 * Page order matching the sidebar configuration.
 * Each entry is the slug used in the sidebar config.
 * Empty string represents the index/introduction page.
 */
const SIDEBAR_ORDER: string[] = [
    "index",
    "preview-environments/index",
    "preview-environments/apps",
    "preview-environments/databases",
    "preview-environments/services",
    "preview-environments/connections",
    "preview-environments/hooks",
    "preview-environments/multirepo",
    "mcp/index",
    "mcp/configure-preview",
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
    "preview-environments/secrets",
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
    // The glob loader's id form varies (extension present or not; index files
    // collapse to their directory), and SIDEBAR_ORDER lists ids in yet another
    // form ("preview-environments/index"). Normalizing both sides through this to
    // the URL slug ("", "preview-environments", "preview-environments/apps") is what makes the lookup match -
    // matching on raw ids leaves every index page falling back to collection order.
    return id
        .replace(/\.mdx?$/, "")
        .replace(/\/index$/, "")
        .replace(/^index$/, "");
}

export async function getOrderedDocs(): Promise<DocPage[]> {
    const allDocs = await getCollection("docs");
    const docsBySlug = new Map<string, CollectionEntry<"docs">>();
    for (const doc of allDocs) {
        docsBySlug.set(slugFromId(doc.id), doc);
    }

    const ordered: DocPage[] = [];
    const placed = new Set<string>();

    function push(slug: string, entry: CollectionEntry<"docs">) {
        placed.add(slug);
        ordered.push({ entry, slug, title: entry.data.title, description: entry.data.description ?? "" });
    }

    for (const orderedId of SIDEBAR_ORDER) {
        const slug = slugFromId(orderedId);
        const entry = docsBySlug.get(slug);
        if (entry == null || placed.has(slug)) continue;
        push(slug, entry);
    }

    // Append any pages not listed in SIDEBAR_ORDER, in collection order.
    for (const [slug, entry] of docsBySlug) {
        if (placed.has(slug)) continue;
        push(slug, entry);
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
