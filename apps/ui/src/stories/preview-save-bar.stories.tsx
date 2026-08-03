import { previewConfigSchema } from "@autonoma/types";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { appShellHandlers, baseApplication } from "lib/storybook/base-fixtures";
import { PageStory } from "lib/storybook/page-story";
import type { TrpcFixtures } from "lib/storybook/trpc-handler";
import { userEvent, within } from "storybook/test";

const FIXTURE_EPOCH = new Date("2026-01-01T00:00:00.000Z");

/** A two-app preview on Postgres, saved - what the settings page loads for a live app. */
const savedConfig = previewConfigSchema.parse({
  version: 2,
  apps: [
    {
      name: "web",
      repository: "acme/storefront",
      path: "apps/web",
      port: 3000,
      primary: true,
      dockerfile: "apps/web/Dockerfile",
      connections: [{ key: "DATABASE_URL", value: "{{db.url}}" }],
    },
    {
      name: "api",
      repository: "acme/storefront",
      path: "apps/api",
      port: 8080,
      dockerfile: "apps/api/Dockerfile",
      connections: [{ key: "DATABASE_URL", value: "{{db.url}}" }],
    },
  ],
  services: [{ name: "db", recipe: "postgres", version: "16" }],
});

const savedResponse = {
  applicationId: baseApplication.id,
  saved: true,
  document: savedConfig,
  deployBranch: "main",
  repos: [{ repo: "acme/storefront", primary: true, githubRepositoryId: 101 }],
};

/** The app's existing secret bundle - keys only, the way the API hands it back. */
const storedSecrets = [
  { key: "STRIPE_SECRET_KEY", maskedLength: 8, updatedAt: FIXTURE_EPOCH, fingerprint: "aa11" },
  { key: "RESEND_API_KEY", maskedLength: 8, updatedAt: FIXTURE_EPOCH, fingerprint: "bb22" },
];

/** A live app: onboarding done, previews on PreviewKit and verified. */
const completedOnboardingState = {
  id: "onboarding_fixture_01",
  applicationId: baseApplication.id,
  step: "completed" as const,
  agentConnectedAt: null,
  agentLogs: [],
  productionUrl: "https://app.acme.example.com",
  previewEnvironmentMode: "previewkit" as const,
  previewUrl: null,
  previewVerificationStatus: "ready" as const,
  previewDeployRequestedAt: null,
  completedAt: FIXTURE_EPOCH,
  lastDiscoveryError: null,
  lastDiscoveredAt: FIXTURE_EPOCH,
  lastDiscoveredModels: 12,
  discoveringStartedAt: null,
  dryRunPassedAt: FIXTURE_EPOCH,
  diffTriggerConfirmedAt: FIXTURE_EPOCH,
  agentHolder: "human" as const,
  agentLastActivityAt: null,
  agentPendingRequest: null,
  agentPairingCode: null,
  agentPairingExpiresAt: null,
  agentClient: null,
  createdAt: FIXTURE_EPOCH,
  updatedAt: FIXTURE_EPOCH,
  sdkConfigured: true,
  dryRunPassed: true,
  discoveryInProgress: false,
  artifactsUploaded: true,
  hasContent: true,
  setupComplete: true,
};

/** Page fixtures for the Preview Environments settings tab of a live app. */
const previewConfigFixtures: TrpcFixtures = {
  auth: {
    activeOrg: { id: "org_fixture_01", name: "Acme Corp", slug: "acme-corp", isDemo: false, canReturnToAccount: false },
  },
  branches: {
    list: [],
    detailByName: {
      id: baseApplication.mainBranchId ?? "branch_fixture_01",
      name: "main",
      pendingSnapshotId: null,
      createdAt: FIXTURE_EPOCH,
      updatedAt: FIXTURE_EPOCH,
      activeSnapshot: {
        id: "snapshot_fixture_01",
        status: "active",
        source: "MANUAL",
        createdAt: FIXTURE_EPOCH,
        testCaseAssignments: [],
      },
    },
  },
  bugs: { listSummary: [] },
  onboarding: {
    getState: completedOnboardingState,
    getPreviewkitConfig: savedResponse,
    savePreviewkitConfig: savedResponse,
    upsertPreviewkitSecrets: storedSecrets,
    deletePreviewkitSecret: storedSecrets,
    listDeployBranches: { branches: ["main"], defaultBranch: "main", currentBranch: "main", truncated: false },
  },
  secrets: { list: storedSecrets },
  github: {
    getApplicationRepository: {
      id: 123456,
      name: "storefront",
      fullName: "acme/storefront",
      defaultBranch: "main",
      private: true,
    },
  },
};

const meta = {
  title: "Pages/PreviewConfigPage",
  component: PageStory,
  parameters: { pageStory: true, msw: { handlers: appShellHandlers(previewConfigFixtures) } },
} satisfies Meta<typeof PageStory>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * The Preview Environments settings tab on a saved two-app config: the app rail,
 * the selected app's variable manager with its stored secrets merged in as masked
 * rows, and the shared save bar below.
 */
export const Variables: Story = {
  args: { path: `/app/${baseApplication.slug}/preview-config` },
};

/**
 * A freshly added variable: build-time injection starts on, so a value the build
 * needs is there without the user knowing to ask, and the copy under the switch
 * says what turning it off buys. The stored secrets above it keep whatever they
 * were saved with - the default applies to new rows only.
 */
export const NewVariableDefaults: Story = {
  args: { path: `/app/${baseApplication.slug}/preview-config` },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: /Add variable/ }));
    await userEvent.type(canvas.getByLabelText("Key"), "SENTRY_DSN");
  },
};

/**
 * The same page for an app stored before the framework presets were retired: the
 * document still parses (read schema), but the authoring contract rejects its
 * build block, so the config itself cannot be saved. The story rotates a stored
 * secret, which is the case that used to be a dead end - the bar names what
 * blocks the config, and still offers Save secrets, because a secret is written
 * to its own store rather than through the document.
 */
export const RetiredBuildPreset: Story = {
  args: { path: `/app/${baseApplication.slug}/preview-config` },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByText("STRIPE_SECRET_KEY"));
    await userEvent.click(await canvas.findByRole("button", { name: "Replace value" }));
    await userEvent.type(canvas.getByLabelText("Value"), "sk_live_rotated");
  },
  parameters: {
    pageStory: true,
    msw: {
      handlers: appShellHandlers({
        ...previewConfigFixtures,
        onboarding: {
          ...previewConfigFixtures.onboarding,
          getPreviewkitConfig: {
            ...savedResponse,
            document: previewConfigSchema.parse({
              version: 2,
              apps: [
                {
                  name: "web",
                  repository: "acme/storefront",
                  path: ".",
                  port: 3000,
                  primary: true,
                  build: { framework: "next", package_manager: "pnpm", node_version: "22" },
                  connections: [{ key: "DATABASE_URL", value: "{{db.url}}" }],
                },
              ],
              services: [{ name: "db", recipe: "postgres", version: "16" }],
            }),
          },
        },
      }),
    },
  },
};
