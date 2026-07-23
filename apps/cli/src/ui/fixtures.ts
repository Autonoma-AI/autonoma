import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { debugLog } from "../core/debug";
import { readForLive } from "./artifacts/reader";
import { basename, kindOf } from "./artifacts/registry";
import { STEP_ORDER } from "./steps";
import { createStore, type LiveReader, type RunStore } from "./store";
import type { StepName } from "./types";

/**
 * Fixture scenes for the gallery - each is a live RunStore built through real
 * store operations, so navigation (focus, cursor, opening artifacts, scroll)
 * behaves exactly as in a run.
 */
export interface Scene {
    id: string;
    label: string;
    store: RunStore;
}

const META = { title: "Generating your test suite", project: "acme-web", version: "0.1.21" };

/** Cap for the directory scene so a huge output dir doesn't flood the UI. */
const DIR_SCENE_MAX_FILES = 200;

const SAMPLE_MD = `---
flow: Account
category: core
priority: medium
---

# Update the display name

## Steps
1. Sign in as a verified user
2. Open account settings
3. Change the display name and save

## Expected
- A "Saved" confirmation toast appears
- The new name persists after reload
`;

const SAMPLE_KB = `---
app_name: "Acme Storefront"
app_description: "E-commerce web app for browsing a catalog, managing a cart, and checking out. Next.js frontend + Postgres."
feature_count: 12
core_flows:
  - feature: "Checkout"
    description: "Cart review, address, payment, confirmation"
    mission: "A paying customer can always complete a purchase"
    core: true
    coreReason: "If checkout breaks, no revenue"
  - feature: "Catalog"
    description: "Product browsing with filters and search"
    mission: "Every product is reachable and filterable"
    core: false
pages:
  - page: "/"
    description: "Landing page"
  - page: "/products"
    description: "Catalog with filters"
  - page: "/cart"
    description: "Cart and checkout entry"
  - page: "/account"
    description: "Profile, orders, settings"
---

# Acme Storefront

E-commerce web app. Next.js frontend + Postgres.

## Core flows
1. **Browse and purchase** - catalog, product page, cart, checkout
2. **Account management** - signup, profile edit, password change
`;

const SAMPLE_PAGES = `{
  "/": { "route": "/", "path": "src/app/page.tsx", "description": "Landing page" },
  "/products": { "route": "/products", "path": "src/app/products/page.tsx", "description": "Catalog with filters" },
  "/cart": { "route": "/cart", "path": "src/app/cart/page.tsx", "description": "Cart and checkout entry" },
  "/account": { "route": "/account", "path": "src/app/account/page.tsx", "description": "Profile, orders, settings" }
}
`;

const SAMPLE_JSON = `{
  "scenario": "standard",
  "entities": [
    { "model": "Organization", "count": 2 },
    { "model": "User", "count": 6 },
    { "model": "Product", "count": 24 }
  ]
}
`;

/**
 * Canned per-file content so opening any fixture artifact in the hero shows
 * something real to scroll (long files exercise scrolling and follow).
 */
const fixtureReader: LiveReader = async (absPath) => {
    const name = basename(absPath);
    const kind = kindOf(absPath);
    if (name === "pages.json") return { text: SAMPLE_PAGES, kind };
    if (kind === "json") return { text: SAMPLE_JSON, kind };
    if (name === "AUTONOMA.md") return { text: SAMPLE_KB, kind };
    const long = Array.from({ length: 8 }, (_, i) => SAMPLE_MD.replace("display name", `display name (v${i + 1})`));
    return { text: long.join("\n"), kind };
};

function makeStore(): RunStore {
    return createStore({ outputDir: "/tmp/fixture", meta: META, reader: fixtureReader });
}

function earlyScene(): RunStore {
    const store = makeStore();
    store.startStep("projectMapper");
    store.pushActivity({ call: "glob", arg: "**/package.json" });
    store.pushActivity({ call: "read", arg: "package.json", metric: "82 lines" });
    return store;
}

function midRunScene(): RunStore {
    const store = makeStore();
    store.startStep("projectMapper");
    store.noteWrite("project-map.json");
    store.endStep("projectMapper", "done");
    store.startStep("pagesFinder");
    store.noteWrite("pages.json");
    store.endStep("pagesFinder", "done");
    store.startStep("kb");
    store.setSubProgress("kb", { done: 9, total: 24, unit: "pages" });
    store.noteWrite("AUTONOMA.md");
    store.setLiveFile("AUTONOMA.md", SAMPLE_KB, "markdown");
    store.pushActivity({ call: "read", arg: "src/app/products/page.tsx", metric: "412 lines" });
    store.pushActivity({ call: "grep", arg: "addToCart" });
    store.pushActivity({ call: "write", arg: "AUTONOMA.md", metric: "8.2 KB" });
    store.setActivity("reading src/app/cart/page.tsx");
    return store;
}

const FIXTURE_STEP_ARTIFACTS: Partial<Record<StepName, string>> = {
    projectMapper: "project-map.json",
    pagesFinder: "pages.json",
    kb: "AUTONOMA.md",
    entityAudit: "entity-audit.md",
    scenarioRecipe: "scenarios.md",
    recipeBuilder: "recipe.json",
};

function runStepsThrough(store: RunStore, last: StepName): void {
    for (const s of STEP_ORDER) {
        store.startStep(s);
        const artifact = FIXTURE_STEP_ARTIFACTS[s];
        if (artifact != null) store.noteWrite(artifact);
        store.endStep(s, "done");
        if (s === last) return;
    }
}

function testWritingScene(): RunStore {
    const store = makeStore();
    runStepsThrough(store, "recipeBuilder");
    store.startStep("testGenerator");
    store.setSubProgress("testGenerator", { done: 32, total: 41, unit: "nodes", note: "~118 tests" });
    store.noteWrite("qa-tests/cart/add-to-cart.md");
    store.noteWrite("qa-tests/account/edit-profile.md");
    // Keep one file actively WRITING so the list spinner is inspectable
    // (fixture writes settle to DONE ~1s after scene creation otherwise).
    setInterval(() => store.noteWrite("qa-tests/account/edit-profile.md"), 500).unref();
    store.setLiveFile("qa-tests/account/edit-profile.md", SAMPLE_MD, "markdown");
    store.pushActivity({ call: "test", arg: "qa-tests/cart/add-to-cart.md", metric: "passed" });
    store.pushActivity({ call: "read", arg: "src/app/account/settings.tsx", metric: "217 lines" });
    store.pushActivity({ call: "test", arg: "qa-tests/account/edit-profile.md" });
    store.setActivity("writing tests for /account");
    return store;
}

function completeScene(): RunStore {
    const store = makeStore();
    runStepsThrough(store, "recipeBuilder");
    store.startStep("testGenerator");
    store.noteWrite("qa-tests/account/edit-profile.md");
    store.endStep("testGenerator", "done");
    store.setLiveFile("qa-tests/account/edit-profile.md", SAMPLE_MD, "markdown");
    store.pushActivity({ call: "success", arg: "suite ready - 142 tests across 24 pages" });
    store.finish({ kind: "complete" });
    return store;
}

function promptScene(): RunStore {
    const store = midRunScene();
    // Fire-and-forget: the gallery answers via the panel; queued ones follow.
    void store.requestPrompt({
        kind: "select",
        message: "Which frontend do you want to plan tests for?",
        options: [
            { value: "apps/web", label: "apps/web  [next.js]", hint: "the customer-facing storefront" },
            { value: "apps/admin", label: "apps/admin  [vite]", hint: "internal admin panel" },
            { value: "packages/widget", label: "packages/widget  [react]", hint: "embeddable checkout widget" },
        ],
    });
    void store.requestPrompt({
        kind: "multiselect",
        message: "Which backends does it need? (pre-checked: the ones it depends on)",
        options: [
            { value: "apps/api", label: "apps/api  [hono]", hint: "main REST API" },
            { value: "apps/jobs", label: "apps/jobs  [node]", hint: "background workers" },
        ],
        initialValues: ["apps/api"],
        required: false,
    });
    void store.requestPrompt({
        kind: "text",
        message: "What should the agent do differently?",
        placeholder: "e.g. the part that failed, or what to focus on",
    });
    void store.requestPrompt({
        kind: "confirm",
        message: "Next: Build a knowledge base - learn your app's features and flows. Continue?",
    });
    return store;
}

function countdownScene(): RunStore {
    const store = makeStore();
    runStepsThrough(store, "scenarioRecipe");
    store.startStep("recipeBuilder");
    // Long enough that the scene doesn't dismiss itself while being inspected.
    void store.runCountdown({
        title: "Handing off to Claude Code",
        lines: [
            "Your terminal is about to switch to Claude Code. It will implement the Autonoma SDK " +
                "integration inside your repo: install the SDK, wire the endpoint, and write a real " +
                "factory for every entity in the audit, validating each one against your locally running app.",
            "This dashboard disappears while it works - that's expected. Watch and steer it like any " +
                "Claude Code session; this usually takes a while.",
            "When it finishes and exits, you come straight back here and the planner continues where " +
                "it left off: submitting the validated recipe, then generating your test suite.",
        ],
        seconds: 600,
    });
    return store;
}

export function buildScenes(): Scene[] {
    return [
        { id: "early", label: "early - first step, nothing produced yet", store: earlyScene() },
        { id: "mid", label: "mid-run - knowledge base streaming", store: midRunScene() },
        { id: "prompt", label: "blocked on questions - answer them to clear the queue", store: promptScene() },
        {
            id: "countdown",
            label: "pre-handoff countdown - about to switch to the coding agent",
            store: countdownScene(),
        },
        { id: "tests", label: "test generation - hero shows a test file", store: testWritingScene() },
        { id: "done", label: "complete", store: completeScene() },
    ];
}

/** Root artifacts that map to a specific pipeline step, in registration order. */
const KNOWN_ROOT_FILES: [string, StepName][] = [
    ["project-map.json", "projectMapper"],
    ["pages.json", "pagesFinder"],
    ["AUTONOMA.md", "kb"],
    ["entity-audit.md", "entityAudit"],
    ["scenarios.md", "scenarioRecipe"],
    ["recipe.json", "recipeBuilder"],
    ["autonoma-config.json", "recipeBuilder"],
];

/**
 * A scene backed by a real planner output directory (`pnpm ui:gallery <dir>`,
 * e.g. a past run under ~/.autonoma/<slug>). Artifacts register from disk and
 * the hero reads real file contents, so navigation and scrolling can be tested
 * on real documents.
 */
export async function directoryScene(dir: string): Promise<Scene> {
    const store = createStore({ outputDir: dir, meta: { ...META, project: basename(dir) }, reader: readForLive });

    const exists = async (rel: string) => {
        try {
            return (await stat(join(dir, rel))).isFile();
        } catch (err) {
            debugLog("Directory scene: file not readable", { dir, rel, err });
            return false;
        }
    };

    const entries = await readdir(dir, { recursive: true });
    const candidates = entries
        .map((entry) => String(entry))
        .filter((rel) => !rel.split("/").some((part) => part.startsWith(".") || part === "node_modules"))
        .filter((rel) => (rel.includes("qa-tests/") || rel.startsWith("qa-tests")) && rel.endsWith(".md"))
        .slice(0, DIR_SCENE_MAX_FILES);
    // Stat everything concurrently - a sequential await per file makes the
    // gallery take visibly long to become interactive on big suites.
    const [isFile, rootPresent] = await Promise.all([
        Promise.all(candidates.map(exists)),
        Promise.all(KNOWN_ROOT_FILES.map(([file]) => exists(file))),
    ]);
    const testFiles = candidates.filter((_, i) => isFile[i]).sort();

    for (const step of STEP_ORDER) {
        if (step === "testGenerator") break;
        store.startStep(step);
        KNOWN_ROOT_FILES.forEach(([file, owner], i) => {
            if (owner === step && rootPresent[i]) store.noteWrite(file);
        });
        store.endStep(step, "done");
    }

    store.startStep("testGenerator");
    for (const rel of testFiles) store.noteWrite(rel);
    store.setSubProgress("testGenerator", { done: testFiles.length, total: testFiles.length, unit: "tests" });
    store.setActivity(`loaded ${testFiles.length} tests from ${dir}`);

    return { id: "dir", label: `real output - ${dir}`, store };
}
