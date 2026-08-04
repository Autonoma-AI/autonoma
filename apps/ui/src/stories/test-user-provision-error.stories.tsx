import type { Meta, StoryObj } from "@storybook/react-vite";
import { baseApplication } from "lib/storybook/base-fixtures";
import { trpcHandler } from "lib/storybook/trpc-handler";
import { http, HttpResponse } from "msw";
import { Suspense } from "react";
import {
  TestUserButton,
  TestUserButtonSkeleton,
} from "routes/_blacklight/_app-shell/app.$appSlug/pull-requests/-components/preview/test-user-button";
import { expect, userEvent, waitFor, within } from "storybook/test";
import superjson from "superjson";

const ENVIRONMENT_ID = "env_fixture_01";
const PREVIEW_URL = "https://web-app.preview-2624.internal";

/**
 * The failure a customer actually reported: a recipe that hardcodes a user's email provisions
 * once and then collides with itself, so the second `up` returns a 500 the SDK handler surfaces
 * verbatim. The state worth pinning is the escape hatch under that message, since a recipe fix
 * is what the error actually calls for.
 */
const provisionFails = http.post("*/v1/trpc/*", ({ request }) => {
  const path = new URL(request.url).pathname;
  if (!path.includes("deployments.testUserProvision")) return undefined;
  return HttpResponse.json([
    {
      error: superjson.serialize({
        message: "SDK returned HTTP 500: User with this email already exists",
        code: -32603,
        data: { code: "INTERNAL_SERVER_ERROR", httpStatus: 500, path: "deployments.testUserProvision" },
      }),
    },
  ]);
});

const meta = {
  title: "Components/TestUserProvisionError",
  component: TestUserButton,
  parameters: {
    msw: {
      // The narrow provision override has to win over the catch-all fixture handler, so it goes first.
      handlers: [
        provisionFails,
        trpcHandler({
          // The escape hatch's dialog reads the org to stay inert in the demo, so the card
          // pulls this in even with the dialog closed.
          auth: {
            activeOrg: {
              id: "org_fixture_01",
              name: "Acme",
              slug: "acme",
              isDemo: false,
              canReturnToAccount: false,
              mergeGateEnabled: false,
              vercelMarketplaceEntry: false,
            },
          },
          deployments: {
            testUserOptions: {
              applicationId: baseApplication.id,
              applicationName: baseApplication.name,
              scenarios: [{ id: "scenario_default", name: "standard" }],
              appUrls: [{ appName: "web-app", url: PREVIEW_URL }],
              suggestedSdkUrl: PREVIEW_URL,
              previewUrl: PREVIEW_URL,
              disabledReason: undefined,
            },
          },
        }),
      ],
    },
  },
  decorators: [
    // The Suspense boundary is the button's own contract: it reads its options with a
    // suspense query, so every real call site wraps it too.
    (Story) => (
      <div className="flex min-h-96 justify-center bg-surface-void p-14">
        <Suspense fallback={<TestUserButtonSkeleton />}>
          <Story />
        </Suspense>
      </div>
    ),
  ],
} satisfies Meta<typeof TestUserButton>;

export default meta;
type Story = StoryObj<typeof meta>;

// The body lives in a dialog, so a story has to open it before provisioning. The queries run
// against the document rather than the canvas because the dialog portals out of the story root.
async function provisionUntilItFails(canvasElement: HTMLElement) {
  await userEvent.click(await within(canvasElement).findByRole("button", { name: /create test user/i }));
  const dialog = within(document.body);
  await userEvent.click(await dialog.findByRole("button", { name: /provision user/i }));
  await waitFor(async () => {
    await expect(dialog.getByText(/couldn't provision/i)).toBeInTheDocument();
  });
  return dialog;
}

export const ProvisionFailed: Story = {
  args: { applicationId: baseApplication.id, environmentId: ENVIRONMENT_ID },
  play: async ({ canvasElement }) => {
    await provisionUntilItFails(canvasElement);
  },
};

/**
 * What the escape hatch opens: the DEBUG MCP, so the install snippet registers `autonoma` and
 * step 3 is "Ask your agent" rather than "Pair your app". No pairing code is minted here - this
 * failure is only reachable once a scenario carries an active recipe, so the user is past
 * onboarding and their agent keys itself off the repo it already sits in.
 */
export const FixDialog: Story = {
  args: { applicationId: baseApplication.id, environmentId: ENVIRONMENT_ID },
  play: async ({ canvasElement }) => {
    const dialog = await provisionUntilItFails(canvasElement);
    await userEvent.click(await dialog.findByRole("button", { name: /fix with coding agent/i }));
    await waitFor(async () => {
      await expect(dialog.getByText(/install the autonoma mcp/i)).toBeInTheDocument();
    });
  },
};
