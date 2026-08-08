import { type CollectionEntry, getCollection } from "astro:content";
import { sidebarSlugsInOrder } from "../sidebar";

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
    // collapse to their directory). Normalizing it to the URL slug the sidebar
    // declares ("", "preview-environments", "preview-environments/apps") is what
    // makes the lookup match - matching on raw ids leaves every index page
    // falling back to collection order.
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

    for (const sidebarSlug of sidebarSlugsInOrder()) {
        const slug = slugFromId(sidebarSlug);
        const entry = docsBySlug.get(slug);
        if (entry == null || placed.has(slug)) continue;
        push(slug, entry);
    }

    // Append any page the sidebar does not link, in collection order.
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
