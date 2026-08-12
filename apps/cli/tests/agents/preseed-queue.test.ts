import { beforeAll, describe, expect, it } from "vitest";
import type { DiscoveredFeature } from "../../src/agents/00b-feature-discovery/index";
import { CoverageState } from "../../src/agents/05-test-generator/graph";
import { preseedQueue } from "../../src/agents/05-test-generator/index";
import { partitionByPage } from "../../src/agents/05-test-generator/partition";

/**
 * The graph the generator seeds before any model call - built from pages and
 * features alone, so it can be asserted without a provider.
 *
 * Two long-standing defects lived here. The "/" route slugs to no segments and
 * was skipped, so a dashboard-style app's main page was never a node. And a
 * feature's parent is reported as `parentPagePath` but holds the page's ROUTE,
 * while the lookup was keyed by source path - so no feature ever matched its
 * page and every one was created with no parentId and no routePath.
 */
beforeAll(() => {
    process.env.DONT_TRACK = "1";
});

const PAGES = new Map([
    ["app/page.tsx", { route: "/", path: "app/page.tsx", description: "Dashboard" }],
    ["app/login/page.tsx", { route: "/login", path: "app/login/page.tsx", description: "Login" }],
]);

const FEATURES = new Map<string, DiscoveredFeature>([
    [
        "send-money",
        {
            id: "send-money",
            name: "Send Money",
            type: "modal",
            parentPagePath: "/",
            sourceFiles: [],
            interactiveElements: 6,
            description: "Transfers",
        },
    ],
    [
        "add-funds",
        {
            id: "add-funds",
            name: "Add Funds",
            type: "modal",
            parentPagePath: "/",
            sourceFiles: [],
            interactiveElements: 4,
            description: "Deposits",
        },
    ],
    [
        "login-form",
        {
            id: "login-form",
            name: "Login Form",
            type: "form",
            parentPagePath: "/login",
            sourceFiles: [],
            interactiveElements: 3,
            description: "Sign in",
        },
    ],
]);

async function seedGraph() {
    const state = new CoverageState();
    await preseedQueue(state, "/project", PAGES, FEATURES);
    return state;
}

describe("preseeded graph", () => {
    it('includes the "/" page instead of dropping it', async () => {
        const state = await seedGraph();

        const home = [...state.nodes.values()].find((n) => n.routePath === "/");
        expect(home, 'the "/" route must be a node').toBeDefined();
    });

    it("links every feature to the page it belongs to", async () => {
        const state = await seedGraph();

        for (const id of ["send-money", "add-funds", "login-form"]) {
            expect(state.nodes.get(id)?.parentId, id).toBeDefined();
        }
    });

    it("gives every node a route", async () => {
        const state = await seedGraph();

        for (const node of state.nodes.values()) {
            expect(node.routePath, node.id).toBeDefined();
        }
    });

    it("partitions into one slice per page", async () => {
        const state = await seedGraph();

        expect(partitionByPage(state)).toHaveLength(PAGES.size);
    });
});
