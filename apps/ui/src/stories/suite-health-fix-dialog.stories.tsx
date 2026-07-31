import type { SuiteHealthFixPlan } from "@autonoma/types";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { baseSuiteHealthFixPlan } from "lib/storybook/base-fixtures";
import { suiteHealthFixture } from "lib/storybook/suite-health-fixtures";
import { SuiteHealthFixDialogPreview } from "routes/_blacklight/_app-shell/-layout/suite-health-fix-dialog";

const DEGRADED = suiteHealthFixture(
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
);

function plan(overrides: Partial<SuiteHealthFixPlan>): SuiteHealthFixPlan {
  return { ...baseSuiteHealthFixPlan, ...overrides };
}

const meta = {
  title: "Components/SuiteHealthFixDialog",
  component: SuiteHealthFixDialogPreview,
  parameters: { layout: "fullscreen" },
  args: { health: DEGRADED, open: true, onOpenChange: () => undefined },
} satisfies Meta<typeof SuiteHealthFixDialogPreview>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * What the meter's "Fix it" button opens: connect the MCP, see exactly what the prompt covers, copy the prompt.
 * The objective is one agent pass that clears enough of the backlog to put the suite back to Calibrating.
 */
export const Open: Story = {
  args: { plan: baseSuiteHealthFixPlan },
};

/**
 * An app whose runs never reach the Reporter has no issues to list, so the plan falls back to raw findings and
 * reports a floor rather than a count. `homa-next`'s real numbers.
 */
export const Truncated: Story = {
  args: {
    plan: plan({
      totalIssues: 200,
      truncated: true,
      byKind: { bug: 0, environment: 15, scenario: 185 },
      oldestAgeDays: 12,
    }),
  },
};

/** Nothing outstanding: the modal says so rather than showing an empty list under a "fix it" promise. */
export const NothingToFix: Story = {
  args: {
    plan: plan({ totalIssues: 0, byKind: { bug: 0, environment: 0, scenario: 0 } }),
  },
};
