import type { Meta, StoryObj } from "@storybook/react-vite";
import { ScenarioInstancesList } from "components/scenarios/scenario-instances-list";
import { trpcHandler } from "lib/storybook/trpc-handler";
import type { RouterOutputs } from "lib/trpc";
import { Suspense } from "react";

const SCENARIO_ID = "scn_7f3a91c4";

/**
 * Two runs of one scenario. The newer used the recipe as it stands; the older used a recipe that has
 * since been edited. Without the badge the older result reads as describing the recipe on screen,
 * which is exactly the confusion this surfaces.
 */
const instances: RouterOutputs["scenarios"]["listInstances"] = [
  {
    id: "inst_4c81b0e2a7d9",
    applicationId: "app_acme",
    organizationId: "org_acme",
    scenarioId: SCENARIO_ID,
    status: "DOWN_SUCCESS",
    requestedAt: new Date("2026-07-27T15:42:00Z"),
    upAt: new Date("2026-07-27T15:42:11Z"),
    downAt: new Date("2026-07-27T15:46:03Z"),
    completedAt: new Date("2026-07-27T15:46:03Z"),
    expiresAt: new Date("2026-07-27T17:42:00Z"),
    auth: null,
    refs: null,
    refsToken: null,
    metadata: null,
    generatedData: null,
    lastError: null,
    resolvedVariables: null,
    deploymentId: "dep_main",
    recipeVersionId: "rcv_9d21",
    recipeFingerprint: "3f9a1c04e7b25d68",
    recipeSuperseded: false,
    createdAt: new Date("2026-07-27T15:42:00Z"),
    updatedAt: new Date("2026-07-27T15:46:03Z"),
  },
  {
    id: "inst_11a7fe30c845",
    applicationId: "app_acme",
    organizationId: "org_acme",
    scenarioId: SCENARIO_ID,
    status: "DOWN_SUCCESS",
    requestedAt: new Date("2026-07-26T09:05:00Z"),
    upAt: new Date("2026-07-26T09:05:09Z"),
    downAt: new Date("2026-07-26T09:08:40Z"),
    completedAt: new Date("2026-07-26T09:08:40Z"),
    expiresAt: new Date("2026-07-26T11:05:00Z"),
    auth: null,
    refs: null,
    refsToken: null,
    metadata: null,
    generatedData: null,
    lastError: null,
    resolvedVariables: null,
    deploymentId: "dep_main",
    recipeVersionId: "rcv_9d21",
    recipeFingerprint: "b70e42aa19c3f5d1",
    recipeSuperseded: true,
    createdAt: new Date("2026-07-26T09:05:00Z"),
    updatedAt: new Date("2026-07-26T09:08:40Z"),
  },
];

const meta = {
  title: "Components/ScenarioInstancesList",
  // The component suspends on its query; the route wraps it in a boundary and so must the story,
  // or React has nothing to catch the suspension and the tree never commits.
  render: () => (
    <Suspense fallback={null}>
      <ScenarioInstancesList scenarioId={SCENARIO_ID} />
    </Suspense>
  ),
  parameters: {
    msw: { handlers: [trpcHandler({ scenarios: { listInstances: instances } })] },
  },
} satisfies Meta<typeof ScenarioInstancesList>;

export default meta;
type Story = StoryObj<typeof meta>;

export const WithSupersededRecipe: Story = {};
