import { useBugsSummary } from "lib/query/bugs.queries";
import { useGithubInstallation } from "lib/query/github.queries";
import { useRuns } from "lib/query/runs.queries";
import { useCurrentApplication } from "../../-use-current-application";

// ─── Types ───────────────────────────────────────────────────────────────────

type MilestoneStatus = "completed" | "in_progress" | "upcoming";

interface Milestone {
  id: string;
  step: number;
  label: string;
  tooltip: string;
  status: MilestoneStatus;
  href: string;
}

// ─── Hook ────────────────────────────────────────────────────────────────────

const DEFINITIONS = [
  {
    id: "install_agent",
    label: "INSTALL AGENT",
    tooltip: "Install the Autonoma agent in your application",
  },
  {
    id: "configure_tests",
    label: "CONFIGURE TESTS",
    tooltip: "Configure your initial test scenarios",
  },
  {
    id: "ci",
    label: "SET UP CI",
    tooltip: "Connect your GitHub repository to trigger tests on deployments",
  },
  {
    id: "first_run",
    label: "FIRST RUN",
    tooltip: "Execute your first test run against your application",
  },
  {
    id: "first_bug",
    label: "FIRST BUG FIX",
    tooltip: "Find and resolve your first bug detected by Autonoma",
  },
] as const;

export function useMilestones(): Milestone[] {
  const { slug: appSlug } = useCurrentApplication();

  const base = `/app/${appSlug}`;

  const { data: runs } = useRuns();
  const { data: bugs } = useBugsSummary();
  const { data: installation } = useGithubInstallation();

  const completionMap: Record<string, boolean> = {
    install_agent: true,
    configure_tests: true,
    ci: installation != null,
    first_run: runs.length > 0,
    first_bug: bugs.some((b) => b.status === "resolved"),
  };

  const hrefMap: Record<string, string> = {
    install_agent: base,
    configure_tests: base,
    ci: `${base}/settings`,
    first_run: `${base}/tests`,
    first_bug: `${base}/bugs`,
  };

  const firstIncompleteIndex = DEFINITIONS.findIndex((d) => !completionMap[d.id]);

  return DEFINITIONS.map((def, index) => ({
    ...def,
    step: index + 1,
    href: hrefMap[def.id]!,
    status: completionMap[def.id]! ? "completed" : index === firstIncompleteIndex ? "in_progress" : "upcoming",
  }));
}
