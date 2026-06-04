import { visit } from "unist-util-visit";

const CALLOUT_TYPES = new Set(["note", "tip", "caution", "danger"]);

/**
 * Remark plugin that transforms :::note / :::tip / :::caution / :::danger
 * container directives into HTML callout elements.
 *
 * Input markdown:
 *   :::note
 *   Some content
 *   :::
 *
 *   :::caution[Custom title]
 *   Some content
 *   :::
 *
 * This works by parsing the raw markdown lines since remark-directive
 * isn't being used. Instead we transform at the AST level.
 */
export function remarkCallouts() {
    return (tree) => {
        visit(tree, "containerDirective", (node) => {
            if (!CALLOUT_TYPES.has(node.name)) return;

            const variant = node.name;

            const hasLabel = node.children[0]?.data?.directiveLabel;
            const title = hasLabel ? (node.children[0].children[0]?.value ?? variant) : variant;

            if (hasLabel) {
                node.children.splice(0, 1);
            }

            const data = node.data ?? (node.data = {});
            data.hName = "aside";
            data.hProperties = {
                class: `callout callout-${variant}`,
                "data-variant": variant,
                "data-title": title,
            };
        });
    };
}
