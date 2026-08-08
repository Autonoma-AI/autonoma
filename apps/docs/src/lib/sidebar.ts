export interface SidebarLink {
    label: string;
    slug: string;
}

export interface SidebarSubGroup {
    label: string;
    collapsed?: boolean;
    items: SidebarLink[];
}

export interface SidebarGroup {
    label: string;
    items: (SidebarLink | SidebarSubGroup)[];
}

/**
 * The documentation navigation, and the only place page order is declared.
 *
 * Both the rendered sidebar and the generated `llms.txt` read it: the sidebar maps
 * it to links, and `getOrderedDocs` flattens it through {@link sidebarSlugsInOrder}
 * to order pages and their prev/next links. Kept in one place because a second,
 * hand-maintained copy of the order silently disagrees with this one - a reader
 * following prev/next then walks the pages in a different order than the sidebar
 * shows, and nothing fails to build.
 */
export const SIDEBAR_GROUPS: SidebarGroup[] = [
    {
        label: "Getting Started",
        items: [
            { label: "Introduction", slug: "" },
            { label: "Troubleshooting", slug: "troubleshooting" },
        ],
    },
    {
        label: "Preview Environments",
        items: [
            { label: "Overview", slug: "preview-environments" },
            { label: "Use your own deploys", slug: "preview-environments/your-own-deploys" },
            { label: "Apps and builds", slug: "preview-environments/apps" },
            { label: "Databases", slug: "preview-environments/databases" },
            { label: "Extra services", slug: "preview-environments/services" },
            { label: "Connections", slug: "preview-environments/connections" },
            { label: "Lifecycle hooks", slug: "preview-environments/hooks" },
            { label: "Multiple repositories", slug: "preview-environments/multirepo" },
        ],
    },
    {
        label: "Your Organization",
        items: [{ label: "Inviting your team", slug: "organization/members" }],
    },
    {
        label: "MCP Server",
        items: [
            { label: "Connect your agent", slug: "mcp" },
            { label: "Use it to set up a preview", slug: "mcp/configure-preview" },
        ],
    },
    {
        label: "Suite Health",
        items: [
            { label: "How it works", slug: "suite-health" },
            { label: "Fixing a degraded suite", slug: "suite-health/fixing" },
        ],
    },
    {
        label: "Test Generation",
        items: [{ label: "Test Planner", slug: "test-planner" }],
    },
    {
        label: "Environment Factory",
        items: [
            { label: "Overview", slug: "environment-factory" },
            { label: "Setup Guide", slug: "environment-factory/setup" },
            { label: "Factories & Payloads", slug: "environment-factory/factories" },
            { label: "Authentication", slug: "environment-factory/authentication" },
            { label: "Security & Troubleshooting", slug: "environment-factory/security" },
            {
                label: "Examples",
                collapsed: true,
                items: [
                    { label: "Overview", slug: "environment-factory/examples" },
                    { label: "TypeScript", slug: "environment-factory/examples/typescript" },
                    { label: "Python", slug: "environment-factory/examples/python" },
                    { label: "Elixir", slug: "environment-factory/examples/elixir" },
                    { label: "Java", slug: "environment-factory/examples/java" },
                    { label: "Ruby", slug: "environment-factory/examples/ruby" },
                    { label: "Rust", slug: "environment-factory/examples/rust" },
                    { label: "Go", slug: "environment-factory/examples/go" },
                    { label: "PHP", slug: "environment-factory/examples/php" },
                ],
            },
        ],
    },
    {
        label: "Reference",
        items: [
            { label: "Preview Environment Secrets", slug: "preview-environments/secrets" },
            { label: "Scenario Recipe Schema", slug: "reference/scenario-recipe-schema" },
        ],
    },
    {
        label: "Development",
        items: [
            { label: "Setup", slug: "development/setup" },
            { label: "Architecture", slug: "development/architecture" },
            { label: "Packages", slug: "development/packages" },
            { label: "Conventions", slug: "development/conventions" },
            { label: "Common Workflows", slug: "development/workflows" },
            { label: "Environment Variables", slug: "development/environment-variables" },
        ],
    },
    {
        label: "Architecture",
        items: [
            { label: "Execution Agent", slug: "architecture/execution-agent" },
            { label: "AI Package", slug: "architecture/ai-package" },
        ],
    },
];

export function isSidebarLink(item: SidebarLink | SidebarSubGroup): item is SidebarLink {
    return "slug" in item;
}

/** Every page slug in {@link SIDEBAR_GROUPS}, flattened top to bottom. */
export function sidebarSlugsInOrder(): string[] {
    return SIDEBAR_GROUPS.flatMap((group) =>
        group.items.flatMap((item) => (isSidebarLink(item) ? [item.slug] : item.items.map((sub) => sub.slug))),
    );
}
