// @ts-nocheck - unified pipeline types are complex and don't play well with strict TS
import type { APIContext } from "astro";
import { type CollectionEntry, render } from "astro:content";
import type { RootContent } from "hast";
import { matches, select, selectAll } from "hast-util-select";
import rehypeParse from "rehype-parse";
import rehypeRemark from "rehype-remark";
import remarkGfm from "remark-gfm";
import remarkStringify from "remark-stringify";
import { unified } from "unified";
import { remove } from "unist-util-remove";

const htmlToMarkdownPipeline = unified()
    .use(rehypeParse, { fragment: true })
    .use(function improveExpressiveCodeHandling() {
        return (tree) => {
            const ecInstances = selectAll(".expressive-code", tree);
            for (const instance of ecInstances) {
                const figcaption = select("figcaption", instance);
                if (figcaption) {
                    const terminalWindowTextIndex = figcaption.children.findIndex((child) =>
                        matches("span.sr-only", child),
                    );
                    if (terminalWindowTextIndex > -1) {
                        figcaption.children.splice(terminalWindowTextIndex, 1);
                    }
                }
                const pre = select("pre", instance);
                const code = select("code", instance);
                if (pre?.properties.dataLanguage && code) {
                    if (!Array.isArray(code.properties.className)) code.properties.className = [];
                    code.properties.className.push(`language-${pre.properties.dataLanguage}`);
                }
            }
        };
    })
    .use(function improveCalloutHandling() {
        return (tree) => {
            // Handle our custom callout elements
            const callouts = selectAll("aside.callout", tree);
            for (const callout of callouts) {
                const variant = (callout.properties?.dataVariant as string) ?? "note";
                const title = (callout.properties?.dataTitle as string) ?? variant;

                // Convert callout to a blockquote with a strong title prefix
                callout.tagName = "blockquote";
                callout.properties = {};
                callout.children = [
                    {
                        type: "element",
                        tagName: "p",
                        children: [
                            {
                                type: "element",
                                tagName: "strong",
                                children: [
                                    { type: "text", value: `${title.charAt(0).toUpperCase() + title.slice(1)}:` },
                                ],
                                properties: {},
                            },
                        ],
                        properties: {},
                    },
                    ...callout.children,
                ];
            }
        };
    })
    .use(function removeMinifiableElements() {
        return (tree, file) => {
            if (!file.data.minify) return;
            remove(tree, (_node) => {
                const node = _node as RootContent;
                if (matches("aside.callout-note", node)) return true;
                if (matches("aside.callout-tip", node)) return true;
                if (matches("details", node)) return true;
                return false;
            });
        };
    })
    .use(rehypeRemark)
    .use(remarkGfm)
    .use(remarkStringify);

export async function entryToMarkdown(
    entry: CollectionEntry<"docs">,
    context: APIContext,
    options?: { minify?: boolean },
): Promise<string> {
    const { Content } = await render(entry);

    // Render the Content component to HTML string
    // Use a simpler approach: just render to string via Astro's built-in rendering
    const _response = new Response();
    let html = "";
    try {
        // For the LLM endpoint, we need the rendered HTML
        // The Content component is an Astro component, render it
        const { default: mdxServer } = await import("@astrojs/mdx/server.js");
        const { experimental_AstroContainer } = await import("astro/container");
        const container = await experimental_AstroContainer.create({
            renderers: [{ name: "astro:jsx", ssr: mdxServer }],
        });
        html = await container.renderToString(Content, context);
    } catch {
        // Fallback: return empty if rendering fails
        return "";
    }

    const file = await htmlToMarkdownPipeline.process({
        value: html,
        data: { minify: options?.minify ?? false },
    });
    let markdown = String(file).trim();
    if (options?.minify) {
        markdown = markdown.replace(/\s+/g, " ");
    }
    return markdown;
}
