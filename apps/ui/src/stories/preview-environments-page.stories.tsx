import type { Meta, StoryObj } from "@storybook/react-vite";
import { appShellHandlers } from "lib/storybook/base-fixtures";
import { PageStory } from "lib/storybook/page-story";
import type { RouterOutputs } from "lib/trpc";
import { dashboardFixtures } from "./app-home.stories";

type PreviewEnvironment = RouterOutputs["deployments"]["listActiveForApp"][number];

const EPOCH = new Date("2026-01-01T00:00:00.000Z");

function environment(
  overrides: Partial<PreviewEnvironment> & Pick<PreviewEnvironment, "id" | "prNumber">,
): PreviewEnvironment {
  return {
    repoFullName: "acme/web",
    headRef: "main",
    status: "ready",
    phase: null,
    health: "ready",
    deployedAt: EPOCH,
    updatedAt: EPOCH,
    apps: [
      {
        appName: "web",
        status: "ready",
        url: `https://pr${overrides.prNumber}.preview.autonoma.app`,
        error: undefined,
      },
    ],
    ...overrides,
  };
}

// A realistic spread across the runtime states (once deployed the row shows the
// live state, not "Ready") plus the deploy states that pre-empt liveness.
const ENVIRONMENTS: PreviewEnvironment[] = [
  environment({ id: "env_1", prNumber: 4, headRef: "refactor/consolidate-external-transfer" }),
  environment({ id: "env_2", prNumber: 3, headRef: "feat/fdic-insured-footer" }),
  environment({ id: "env_3", prNumber: 12, headRef: "chore/bump-deps" }),
  environment({ id: "env_4", prNumber: 7, headRef: "feat/statements-export", status: "building", health: "building" }),
  environment({
    id: "env_5",
    prNumber: 9,
    headRef: "fix/login-redirect",
    status: "failed",
    health: "failed",
    apps: [{ appName: "web", status: "build_failed", url: undefined, error: "build failed" }],
  }),
];

const LIVENESS: Record<string, RouterOutputs["previewAccess"]["liveness"][string]> = {
  "https://pr4.preview.autonoma.app": "error", // Crashing
  "https://pr3.preview.autonoma.app": "healthy", // Live
  "https://pr12.preview.autonoma.app": "asleep", // Idle
};

const meta = {
  title: "Pages/PreviewEnvironments",
  component: PageStory,
  parameters: {
    pageStory: true,
    msw: {
      handlers: appShellHandlers({
        ...dashboardFixtures,
        deployments: { listActiveForApp: ENVIRONMENTS },
        previewAccess: { liveness: LIVENESS },
      }),
    },
  },
} satisfies Meta<typeof PageStory>;
export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = { args: { path: "/app/acme-web/preview-environments" } };
