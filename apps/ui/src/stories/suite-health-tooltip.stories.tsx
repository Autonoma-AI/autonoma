import type { Meta, StoryObj } from "@storybook/react-vite";
import { baseSuiteHealth } from "lib/storybook/base-fixtures";
import { suiteHealthFixture } from "lib/storybook/suite-health-fixtures";
import { SuiteHealthTooltip } from "routes/_blacklight/_app-shell/-layout/sidebar-suite-health";

const meta = {
  title: "Components/SuiteHealthTooltip",
  component: SuiteHealthTooltip,
} satisfies Meta<typeof SuiteHealthTooltip>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * The panel behind the sidebar meter, at every rung. This is where the copy lives, so it is the thing worth
 * reviewing - and the second paragraph is the part that makes two suites at the same level actionable
 * differently: horizon should keep shipping pull requests, agree should go fix its preview environment.
 *
 * At AT RISK and DEGRADED the header carries the "Fix it" button. It appears only there on purpose: at
 * CALIBRATING and above there is no backlog to hand an agent, and offering a repair would say otherwise.
 */
export const AllLevels: Story = {
  args: { health: baseSuiteHealth },
  render: () => (
    <div className="flex flex-wrap items-start gap-6 bg-surface-void p-10">
      {[
        suiteHealthFixture(
          {
            level: "proven",
            rank: 5,
            trust: 94,
            driver: "none",
            evidence: { ...baseSuiteHealth.evidence, runs: 34, pullRequests: 14, selfHeals: 6, selfHealAttempts: 7 },
          },
          { passed: 133, clientBug: 6, environmentFailure: 2, scenarioIssue: 1, planMismatch: 4, engineArtifact: 2 },
        ),
        suiteHealthFixture(
          {
            level: "steady",
            rank: 4,
            trust: 79.8,
            driver: "plan",
            gatedBy: "age",
            evidence: { ...baseSuiteHealth.evidence, runs: 20, pullRequests: 12, selfHeals: 3, selfHealAttempts: 13 },
          },
          { passed: 67, clientBug: 4, environmentFailure: 2, scenarioIssue: 0, planMismatch: 12, engineArtifact: 4 },
        ),
        baseSuiteHealth,
        suiteHealthFixture(
          {
            level: "at_risk",
            rank: 2,
            trust: 26.6,
            driver: "environment",
            staleIssues: 2,
            evidence: { ...baseSuiteHealth.evidence, runs: 20, pullRequests: 13, selfHeals: 3, selfHealAttempts: 6 },
          },
          { passed: 21, clientBug: 0, environmentFailure: 32, scenarioIssue: 19, planMismatch: 4, engineArtifact: 3 },
        ),
        suiteHealthFixture(
          {
            level: "degraded",
            rank: 1,
            trust: 0,
            driver: "scenario",
            staleIssues: 4,
            evidence: { ...baseSuiteHealth.evidence, runs: 20, pullRequests: 9, selfHeals: 0, selfHealAttempts: 0 },
          },
          { passed: 0, clientBug: 0, environmentFailure: 23, scenarioIssue: 144, planMismatch: 0, engineArtifact: 0 },
        ),
      ].map((health) => (
        <div key={health.level} className="border border-border-dim bg-card">
          <SuiteHealthTooltip health={health} onFixIt={() => undefined} />
        </div>
      ))}
    </div>
  ),
};
