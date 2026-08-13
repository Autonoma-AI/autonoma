import type { SuiteHealth } from "@autonoma/types";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { appShellHandlers, baseSuiteHealth } from "lib/storybook/base-fixtures";
import { dashboardFixtures } from "lib/storybook/dashboard-fixtures";
import { PageStory } from "lib/storybook/page-story";
import { suiteHealthFixture } from "lib/storybook/suite-health-fixtures";
import { HttpResponse, http } from "msw";
import { userEvent, within } from "storybook/test";

/**
 * The suite-health meter in the top bar, at each rung of the ladder. Every fixture is a real production
 * application's numbers as of 2026-07-31, so what these render is what a customer sees, not an invented shape.
 */

function handlers(suiteHealth: SuiteHealth) {
  return appShellHandlers({ ...dashboardFixtures, applications: { suiteHealth } });
}

const meta = {
  title: "Components/SuiteHealthMeter",
  component: PageStory,
  parameters: { pageStory: true, layout: "fullscreen" },
} satisfies Meta<typeof PageStory>;

export default meta;
type Story = StoryObj<typeof meta>;

const PATH = "/app/acme-web/pull-requests";

/** Matches the meter's own request only - it is deliberately unbatched, so it is never in a URL with anything else. */
const SUITE_HEALTH_ENDPOINT = "*/v1/trpc/applications.suiteHealth";

/** `autonoma/online-bank`: the cleanest suite we run. Its score earns Proven; only its age holds it at Steady. */
export const Steady: Story = {
  args: { path: PATH },
  parameters: {
    msw: {
      handlers: handlers(
        suiteHealthFixture(
          {
            level: "steady",
            rank: 4,
            score: 85.8,
            trust: 79.8,
            driver: "plan",
            gatedBy: "age",
            evidence: {
              runs: 20,
              pullRequests: 12,
              selfHeals: 3,
              selfHealAttempts: 13,
              findings: 89,
              ageDays: 15,
              daysSinceLastRun: 0,
            },
          },
          { passed: 67, clientBug: 4, environmentFailure: 2, scenarioIssue: 0, planMismatch: 12, engineArtifact: 4 },
        ),
      ),
    },
  },
};

/** The state every new app opens in, and the one most real suites sit at today. */
export const Calibrating: Story = {
  args: { path: PATH },
  parameters: { msw: { handlers: handlers(baseSuiteHealth) } },
};

/** `centinel-finance/centinel-app`: half its runs never reach the app because the preview is down. */
export const AtRisk: Story = {
  args: { path: PATH },
  parameters: {
    msw: {
      handlers: handlers(
        suiteHealthFixture(
          {
            level: "at_risk",
            rank: 2,
            score: 30.6,
            trust: 26.6,
            driver: "environment",
            staleIssues: 2,
            evidence: {
              runs: 20,
              pullRequests: 13,
              selfHeals: 3,
              selfHealAttempts: 6,
              findings: 79,
              ageDays: 56,
              daysSinceLastRun: 0,
            },
          },
          { passed: 21, clientBug: 0, environmentFailure: 32, scenarioIssue: 19, planMismatch: 4, engineArtifact: 3 },
        ),
      ),
    },
  },
};

/** `homa/homa-next`: its scenario recipe has never worked, so not one run in twenty reached a verdict. */
export const Degraded: Story = {
  args: { path: PATH },
  parameters: {
    msw: {
      handlers: handlers(
        suiteHealthFixture(
          {
            level: "degraded",
            rank: 1,
            score: 0,
            trust: 0,
            driver: "scenario",
            staleIssues: 4,
            evidence: {
              runs: 20,
              pullRequests: 9,
              selfHeals: 0,
              selfHealAttempts: 0,
              findings: 167,
              ageDays: 48,
              daysSinceLastRun: 0,
            },
          },
          { passed: 0, clientBug: 0, environmentFailure: 23, scenarioIssue: 144, planMismatch: 0, engineArtifact: 0 },
        ),
      ),
    },
  },
};

/** Weeks of green runs behind it, a clean backlog, and issues that get triaged. Nobody is here yet. */
export const Proven: Story = {
  args: { path: PATH },
  parameters: {
    msw: {
      handlers: handlers(
        suiteHealthFixture(
          {
            level: "proven",
            rank: 5,
            score: 96,
            trust: 94,
            driver: "none",
            evidence: {
              runs: 34,
              pullRequests: 14,
              selfHeals: 6,
              selfHealAttempts: 7,
              findings: 148,
              ageDays: 62,
              daysSinceLastRun: 0,
            },
          },
          { passed: 133, clientBug: 6, environmentFailure: 2, scenarioIssue: 1, planMismatch: 4, engineArtifact: 2 },
        ),
      ),
    },
  },
};

/** No pull request has been analysed yet, so there is nothing to score. */
export const WaitingForFirstRun: Story = {
  args: { path: PATH },
  parameters: {
    msw: {
      handlers: handlers(
        suiteHealthFixture(
          {
            level: "calibrating",
            rank: 3,
            score: 0,
            trust: 0,
            driver: "none",
            hasEverRun: false,
            evidence: {
              runs: 0,
              pullRequests: 0,
              selfHeals: 0,
              selfHealAttempts: 0,
              findings: 0,
              ageDays: 0,
              daysSinceLastRun: 0,
            },
          },
          { passed: 0, clientBug: 0, environmentFailure: 0, scenarioIssue: 0, planMismatch: 0, engineArtifact: 0 },
        ),
      ),
    },
  },
};

/**
 * The meter's request fails. The top bar renders on every page, so the failure has to stop here: the meter
 * simply is not there, and the rest of the shell - navigation, the page itself - keeps working around the gap.
 */
export const Unavailable: Story = {
  args: { path: PATH },
  parameters: {
    msw: {
      handlers: [
        http.get(SUITE_HEALTH_ENDPOINT, () => new HttpResponse(null, { status: 500 })),
        ...handlers(baseSuiteHealth),
      ],
    },
  },
};

/**
 * The fix modal as a user actually reaches it: hover the meter in the bar, then click "Fix it" in the tooltip
 * header. Driven through the real interaction rather than rendered open, because a button living inside a hover
 * tooltip is the part most likely to break - if the popup stops being hoverable, this story fails rather than
 * quietly screenshotting a closed dialog.
 */
export const FixItInContext: Story = {
  args: { path: PATH },
  parameters: {
    msw: {
      handlers: handlers(
        suiteHealthFixture(
          {
            level: "degraded",
            rank: 1,
            score: 0,
            trust: 0,
            driver: "scenario",
            staleIssues: 4,
            evidence: {
              runs: 20,
              pullRequests: 9,
              selfHeals: 0,
              selfHealAttempts: 0,
              findings: 167,
              ageDays: 48,
              daysSinceLastRun: 0,
            },
          },
          { passed: 0, clientBug: 0, environmentFailure: 23, scenarioIssue: 144, planMismatch: 0, engineArtifact: 0 },
        ),
      ),
    },
  },
  play: async ({ canvasElement }) => {
    const meter = await within(canvasElement).findByLabelText("Suite health");
    await userEvent.hover(meter);

    // The tooltip renders in a portal, so it is outside `canvasElement` - reach it through the document body.
    const fixIt = await within(document.body).findByRole("button", { name: /fix it/i });
    await userEvent.click(fixIt);

    await within(document.body).findByText("Put the suite back in order");
  },
};
