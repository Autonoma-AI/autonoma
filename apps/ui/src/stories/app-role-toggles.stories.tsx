import { previewConfigSchema } from "@autonoma/types";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { AppCard } from "../routes/_blacklight/onboarding/-components/previewkit/app-card";
import {
  draftFromConfig,
  emptyDraftIssues,
  sdkHostAppId,
  type AppDraft,
} from "../routes/_blacklight/onboarding/-components/previewkit/topology-draft";

// A split topology: the app the agents browse and the app serving the Environment
// Factory handler are different services, which is what the SDK toggle exists for.
const splitConfig = previewConfigSchema.parse({
  version: 2,
  apps: [
    {
      name: "hammer",
      repository: "eddifi/eddi-monorepo",
      path: ".",
      port: 4173,
      primary: true,
      build: { framework: "dockerfile", dockerfile: "./apps/hammer/Dockerfile", build_context: "root" },
    },
    {
      name: "anvil",
      repository: "eddifi/eddi-monorepo",
      path: ".",
      port: 3000,
      sdk_implemented: true,
      build: { framework: "dockerfile", dockerfile: "./apps/anvil/Dockerfile", build_context: "root" },
    },
  ],
});

// The same split topology, with the handler mounted somewhere other than the
// conventional path - which is what `sdk_path` exists to record.
const customPathConfig = previewConfigSchema.parse({
  version: 2,
  apps: [
    {
      name: "hammer",
      repository: "eddifi/eddi-monorepo",
      path: ".",
      port: 4173,
      primary: true,
      build: { framework: "dockerfile", dockerfile: "./apps/hammer/Dockerfile", build_context: "root" },
    },
    {
      name: "anvil",
      repository: "eddifi/eddi-monorepo",
      path: ".",
      port: 3000,
      sdk_implemented: true,
      sdk_path: "/autonoma",
      build: { framework: "dockerfile", dockerfile: "./apps/anvil/Dockerfile", build_context: "root" },
    },
  ],
});

// A full-stack app serves the pages under test AND the handler, so it carries both
// roles - the two flags are independent, not alternatives.
const fullStackConfig = previewConfigSchema.parse({
  version: 2,
  apps: [
    {
      name: "storefront",
      repository: "eddifi/eddi-monorepo",
      path: ".",
      port: 3000,
      primary: true,
      sdk_implemented: true,
      build: { framework: "dockerfile", dockerfile: "./Dockerfile" },
    },
    {
      name: "email-worker",
      repository: "eddifi/eddi-monorepo",
      path: ".",
      port: 3001,
      build: { framework: "dockerfile", dockerfile: "./worker.Dockerfile" },
    },
  ],
});

/**
 * The per-app role toggles as the config editor renders them, with the real
 * exclusivity rules wired: picking a frontend (or an SDK host) clears that role on
 * every other app, while leaving the other role untouched.
 */
function AppRoleToggles({ apps: initialApps, expanded = false }: { apps: AppDraft[]; expanded?: boolean }) {
  const [apps, setApps] = useState(initialApps);

  function setPrimaryApp(id: number) {
    setApps((current) => current.map((app) => ({ ...app, primary: app.id === id ? !app.primary : false })));
  }

  function setSdkApp(id: number) {
    setApps((current) =>
      current.map((app) => ({ ...app, sdkImplemented: app.id === id ? !app.sdkImplemented : false })),
    );
  }

  return (
    <div className="mx-auto max-w-4xl space-y-4 bg-surface-void p-6">
      {apps.map((app) => (
        <AppCard
          key={app.id}
          app={app}
          applicationId="app_fixture_01"
          issues={emptyDraftIssues()}
          dependencyOptions={apps.filter((other) => other.id !== app.id).map((other) => other.name)}
          showDependsOn={false}
          showRoleToggles
          defaultExpanded={expanded}
          onChange={(id, patch) =>
            setApps((current) => current.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry)))
          }
          onSetPrimary={setPrimaryApp}
          onSetSdkApp={setSdkApp}
          isSdkHost={sdkHostAppId(apps) === app.id}
          onRemove={() => undefined}
        />
      ))}
    </div>
  );
}

const meta = {
  title: "Onboarding/AppRoleToggles",
  component: AppRoleToggles,
} satisfies Meta<typeof AppRoleToggles>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * Front and API on separate services: `hammer` is the frontend the agents browse,
 * `anvil` serves `/api/autonoma`, so scenario up/down goes to anvil instead of
 * following the frontend.
 */
export const SplitTopology: Story = {
  args: { apps: draftFromConfig(splitConfig, [], "saved").apps },
};

/**
 * One app holding both roles, with a worker beside it. The toggles are independent:
 * a full-stack app is the browsed frontend and the SDK host at once.
 */
export const FullStackApp: Story = {
  args: { apps: draftFromConfig(fullStackConfig, [], "saved").apps },
};

/**
 * The mount path, on the one card that can serve the handler. `anvil` carries the SDK role and
 * therefore the "SDK path" field, here holding a non-conventional `/autonoma`; `hammer` serves no
 * handler, so the field is not offered on it at all and cannot be set on the wrong app by mistake.
 */
export const SdkPathOnTheHostApp: Story = {
  args: { apps: draftFromConfig(customPathConfig, [], "saved").apps, expanded: true },
};
