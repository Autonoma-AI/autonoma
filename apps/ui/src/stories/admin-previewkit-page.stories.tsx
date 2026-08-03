import type { Meta, StoryObj } from "@storybook/react-vite";
import { appShellHandlers } from "lib/storybook/base-fixtures";
import { PageStory } from "lib/storybook/page-story";
import type { RouterOutputs } from "lib/trpc";

/**
 * The admin previewkit fleet view: every active preview environment across every organization, with the runtime
 * liveness of each one.
 *
 * Storied because this is the page whose liveness read is cross-org - it has no single application to key on, so
 * it is the one surface that cannot use `livenessForApplication`. The badges here are the only visual proof that
 * the fleet-wide read resolves the same states as the per-application one.
 */

type PreviewEnvironment = RouterOutputs["admin"]["listPreviewkitEnvironments"][number];
type Liveness = RouterOutputs["previewAccess"]["livenessForFleet"];

const ACME_ORG = { id: "org_acme", name: "Acme Corp", slug: "acme" };
const NORTHWIND_ORG = { id: "org_northwind", name: "Northwind Bank", slug: "northwind" };

function environment(overrides: Partial<PreviewEnvironment> & Pick<PreviewEnvironment, "id">): PreviewEnvironment {
  return {
    namespace: "preview-acme-web-pr-0",
    prNumber: 0,
    repoFullName: "acme/web",
    headRef: "main",
    status: "ready",
    health: "ready",
    phase: null,
    deployedAt: new Date("2026-07-30T09:12:00Z"),
    updatedAt: new Date("2026-07-31T14:03:00Z"),
    organization: ACME_ORG,
    apps: [],
    ...overrides,
  };
}

const ENVIRONMENTS: PreviewEnvironment[] = [
  environment({
    id: "env_1",
    namespace: "preview-acme-web-pr-4187",
    prNumber: 4187,
    headRef: "feat/statements-export",
    updatedAt: new Date("2026-07-31T14:03:00Z"),
    apps: [{ appName: "web-app", status: "ready", url: "https://a1c9f2.preview.autonoma.app", error: undefined }],
  }),
  environment({
    id: "env_2",
    namespace: "preview-acme-web-pr-4162",
    prNumber: 4162,
    headRef: "chore/bump-deps",
    updatedAt: new Date("2026-07-31T09:41:00Z"),
    apps: [{ appName: "web-app", status: "ready", url: "https://b7d31e.preview.autonoma.app", error: undefined }],
  }),
  environment({
    id: "env_3",
    namespace: "preview-northwind-core-pr-812",
    prNumber: 812,
    repoFullName: "northwind/core",
    organization: NORTHWIND_ORG,
    headRef: "fix/ledger-rounding",
    updatedAt: new Date("2026-07-30T18:20:00Z"),
    apps: [{ appName: "api", status: "ready", url: "https://c04f8a.preview.autonoma.app", error: undefined }],
  }),
  environment({
    id: "env_4",
    namespace: "preview-northwind-core-pr-798",
    prNumber: 798,
    repoFullName: "northwind/core",
    organization: NORTHWIND_ORG,
    headRef: "feat/bulk-transfer-import",
    updatedAt: new Date("2026-07-31T15:12:00Z"),
    status: "building",
    health: "building",
    apps: [{ appName: "api", status: "building", url: undefined, error: undefined }],
  }),
  environment({
    id: "env_5",
    namespace: "preview-acme-web-pr-4090",
    prNumber: 4090,
    headRef: "refactor/consolidate-external-transfer",
    updatedAt: new Date("2026-07-29T11:05:00Z"),
    health: "failed",
    status: "failed",
    apps: [
      {
        appName: "web-app",
        status: "deploy_failed",
        url: undefined,
        error: "helm upgrade failed: timed out waiting for the condition",
      },
    ],
  }),
];

/**
 * Keyed by URL, exactly as `livenessForFleet` returns it. The three environments with a URL cover the states a
 * reader has to be able to tell apart at a glance: serving, asleep, and crash-looping.
 */
const LIVENESS: Liveness = {
  "https://a1c9f2.preview.autonoma.app": "healthy",
  "https://b7d31e.preview.autonoma.app": "asleep",
  "https://c04f8a.preview.autonoma.app": "error",
};

const meta = {
  title: "Pages/AdminPreviewkit",
  component: PageStory,
  parameters: { pageStory: true, layout: "fullscreen" },
} satisfies Meta<typeof PageStory>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Fleet: Story = {
  args: { path: "/admin/previewkit" },
  parameters: {
    msw: {
      handlers: appShellHandlers(
        {
          admin: {
            listPreviewkitEnvironments: ENVIRONMENTS,
            listPreviewkitDeployableApplications: [],
          },
          previewAccess: { livenessForFleet: LIVENESS },
        },
        { role: "admin" },
      ),
    },
  },
};
