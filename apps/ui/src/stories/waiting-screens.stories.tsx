import type { Meta, StoryObj } from "@storybook/react-vite";
import { appShellHandlers, baseApplication } from "lib/storybook/base-fixtures";
import { PageStory } from "lib/storybook/page-story";
import type { TrpcFixtures } from "lib/storybook/trpc-handler";
import { HttpResponse, delay, http } from "msw";
import { userEvent, within } from "storybook/test";
import superjson from "superjson";
import { dashboardFixtures } from "./app-home.stories";

/**
 * What a screen shows WHILE it is waiting, and what it shows when the wait fails -
 * the states no other page story can reach, because they all answer their queries
 * instantly and can therefore only screenshot the settled result.
 *
 * Each story holds one screen still by never answering the query it is waiting on
 * (or by failing it), so a screenshot catches what a customer on a slow or broken
 * connection sits in front of. A procedure that is stalled or failed needs no
 * fixture.
 *
 * These are the regression net for the thing that made all of this necessary:
 * TanStack Router only wraps a match in a Suspense (or catch) boundary when the
 * route has a pending (or error) component, so before `main.tsx` set the router
 * defaults, 63 of 70 routes had no boundary at all - every wait and every throw
 * escaped to the root Outlet and blanked the whole app, sidebar included. If a
 * shot here ever comes back black again, that is what regressed.
 *
 * Shoot them with the document wait, since a held-open query never reaches
 * `networkidle`:
 *   storybook:shoot -- --wait-until domcontentloaded --settle-ms 2500 --story ...
 */

/** Longer than any screenshot run, so the waiting state is what gets captured. */
const STALL_MS = 600_000;
const SERVER_ERROR_CODE = -32603;
const SERVER_ERROR_STATUS = 500;

interface WaitingScreen {
  /** App path to render. */
  path: string;
  /** tRPC procedures to leave unanswered. Anything sharing their HTTP batch waits with them. */
  stall: readonly string[];
  /** tRPC procedures to answer with a server error, for the failure states. */
  fail?: readonly string[];
  fixtures?: TrpcFixtures;
  /** Runs after the first render, for the states only reachable by navigating within the app. */
  play?: StoryObj<typeof meta>["play"];
}

/**
 * Answers with a server error the way the real API does, so the failure reaches the route's catch boundary
 * rather than the story's. Deliberately not "no fixture": that path logs `[storybook-fixtures]` and the
 * screenshot script treats it as a broken story.
 */
function failHandler(fail: readonly string[]) {
  const failing: ReadonlySet<string> = new Set(fail);
  return http.all("*/v1/trpc/*", ({ request }) => {
    const url = new URL(request.url);
    const trpcPath = url.pathname.replace(/^.*\/v1\/trpc\//, "");
    const procedures = trpcPath.split(",").filter((procedure) => procedure.length > 0);
    if (!procedures.some((procedure) => failing.has(procedure))) return;

    const results = procedures.map((procedure) => ({
      error: superjson.serialize({
        message: `Simulated failure for "${procedure}"`,
        code: SERVER_ERROR_CODE,
        data: { code: "INTERNAL_SERVER_ERROR", httpStatus: SERVER_ERROR_STATUS, path: procedure },
      }),
    }));
    return HttpResponse.json(url.searchParams.get("batch") === "1" ? results : results[0]);
  });
}

/**
 * Leaves a request unanswered when it carries any stalled procedure. Returning
 * nothing makes MSW fall through, so every other call still reaches
 * `appShellHandlers` and its fixtures.
 *
 * The unit is the request rather than the procedure because that is how the
 * client behaves: a batch resolves only when its slowest member does, so one
 * stalled member stalls its batch.
 */
function stallHandler(stall: readonly string[]) {
  const stalled: ReadonlySet<string> = new Set(stall);
  return http.all("*/v1/trpc/*", async ({ request }) => {
    const trpcPath = new URL(request.url).pathname.replace(/^.*\/v1\/trpc\//, "");
    const procedures = trpcPath.split(",").filter((procedure) => procedure.length > 0);
    if (!procedures.some((procedure) => stalled.has(procedure))) return;
    await delay(STALL_MS);
  });
}

function waiting({ path, stall, fail, fixtures = {}, play }: WaitingScreen): StoryObj<typeof meta> {
  const handlers = fail == null ? [stallHandler(stall)] : [failHandler(fail), stallHandler(stall)];
  return {
    args: { path },
    parameters: { msw: { handlers: [...handlers, ...appShellHandlers(fixtures)] } },
    play,
  };
}

const meta = {
  title: "Waiting/Screens",
  component: PageStory,
  parameters: { pageStory: true, layout: "fullscreen" },
} satisfies Meta<typeof PageStory>;

export default meta;

/**
 * The case that used to be worst, and it is not a page: `app.$appSlug/route.tsx` is
 * the layout above every app screen, and its loader awaits `branches.detailByName`.
 * That one query used to blank the entire application. Here the page's own data
 * (`branches.list`) is answered and only the layout is outstanding, so the wait
 * belongs entirely to the layout - and it now happens inside a live shell.
 */
export const AppLayout = waiting({
  path: `/app/${baseApplication.slug}/pull-requests?state=open`,
  stall: ["branches.detailByName"],
  // The sidebar renders during this wait now that the layout has a boundary, so its own (non-suspending)
  // reads need answering - before, nothing rendered and nothing asked.
  fixtures: dashboardFixtures,
});

/** The control: nothing stalled, so the same screen paints in full. */
export const Settled = waiting({
  path: `/app/${baseApplication.slug}/pull-requests?state=open`,
  stall: [],
  fixtures: dashboardFixtures,
});

/** Home: three `ensure*` calls in the loader, behind its real header and the two panel outlines. */
export const Home = waiting({
  path: `/app/${baseApplication.slug}`,
  stall: ["branches.list"],
  fixtures: dashboardFixtures,
});

/**
 * The Pull Requests list on a COLD landing, where the layout's query and the list's
 * own arrive in the same batch - so the list's `pendingComponent` cannot appear
 * before its parent resolves. Compare with `PullRequestsWarm`.
 */
export const PullRequests = waiting({
  path: `/app/${baseApplication.slug}/pull-requests?state=open`,
  stall: ["branches.list"],
  fixtures: dashboardFixtures,
});

/** PR detail: the deepest loader chain in the app, now two round trips rather than three. */
export const PrDetail = waiting({
  path: `/app/${baseApplication.slug}/pull-requests/143`,
  stall: ["branches.detailByPr"],
  fixtures: dashboardFixtures,
});

/** The PR's Preview tab, whose two loader awaits are now parallel: one round trip rather than two. */
export const PrPreviewTab = waiting({
  path: `/app/${baseApplication.slug}/pull-requests/143/preview`,
  stall: ["branches.detailByPr"],
  fixtures: dashboardFixtures,
});

/** Tests: the layout answers, then the tree panel suspends inside its own boundary. */
export const Tests = waiting({
  path: `/app/${baseApplication.slug}/tests`,
  stall: ["tests.list", "folders.list"],
  fixtures: dashboardFixtures,
});

/**
 * The same stalled `branches.list`, reached by clicking through the sidebar instead
 * of landing cold. `branches.detailByName` is cached by then, so the layout does not
 * wait and the list's own `pendingComponent` is what shows - which is why a
 * per-route pending component is worth having on top of the router default, but
 * never a substitute for it.
 */
export const PullRequestsWarm = waiting({
  path: `/app/${baseApplication.slug}/settings`,
  stall: ["branches.list"],
  fixtures: dashboardFixtures,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("link", { name: /pull requests/i }));
  },
});

/**
 * Home reached by clicking, so the layout is warm and Home's own pending state is
 * what shows: the real header over the two-column body's outline. Cold, the
 * layout's query shares a batch with Home's and the generic default covers both -
 * which is the honest limit of a per-route pending component.
 */
export const HomeWarm = waiting({
  path: `/app/${baseApplication.slug}/tests`,
  stall: ["branches.list", "branches.mainOpenProblems"],
  fixtures: dashboardFixtures,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("link", { name: /^home$/i }));
  },
});

/**
 * The failure counterpart to `AppLayout`. Before the router had a
 * `defaultErrorComponent` this was a blank page with no message and no way back;
 * now the throw is caught at the route that owns it, so the shell survives and the
 * retry is offered in place.
 */
export const AppLayoutFailed = waiting({
  path: `/app/${baseApplication.slug}/pull-requests?state=open`,
  stall: [],
  fail: ["branches.detailByName"],
  fixtures: dashboardFixtures,
});

/** A page-level read failing rather than a layout one, contained the same way. */
export const HomeFailed = waiting({
  path: `/app/${baseApplication.slug}`,
  stall: [],
  fail: ["branches.list"],
  fixtures: dashboardFixtures,
});

// ─── Settings ─────────────────────────────────────────────────────────────────
// Rows 7, 11 and 17-20 of the survey below, which it left as a baseline for the settings redesign to close.
// The rail is the thing to look at in each: it belongs to the layout route, so it keeps rendering around a
// destination that is waiting or has thrown, and the other destinations stay one click away.

/** Billing waiting on the organization's balance. Before this it had no boundary anywhere on the route. */
export const SettingsBilling = waiting({
  path: `/app/${baseApplication.slug}/settings/billing`,
  stall: ["billing.status"],
  fixtures: dashboardFixtures,
});

/** Scenarios & SDK waiting on the discovered list. The SDK endpoint panel above it is static, so it paints. */
export const SettingsScenarios = waiting({
  path: `/app/${baseApplication.slug}/settings/scenarios`,
  stall: ["scenarios.list"],
  fixtures: dashboardFixtures,
});

/**
 * A settings destination that threw. The message names what failed rather than the router's generic
 * wording, and the rail beside it is untouched - the failure is contained to the Outlet.
 */
export const SettingsBillingFailed = waiting({
  path: `/app/${baseApplication.slug}/settings/billing`,
  stall: [],
  fail: ["billing.status"],
  fixtures: dashboardFixtures,
});

/** The same containment for the destination with the most moving parts. */
export const SettingsScenariosFailed = waiting({
  path: `/app/${baseApplication.slug}/settings/scenarios`,
  stall: [],
  fail: ["scenarios.list"],
  fixtures: dashboardFixtures,
});
