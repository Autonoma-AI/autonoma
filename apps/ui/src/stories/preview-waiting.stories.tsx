import type { Meta, StoryObj } from "@storybook/react-vite";
import { appShellHandlers } from "lib/storybook/base-fixtures";
import { PageStory } from "lib/storybook/page-story";
import type { TrpcFixtures } from "lib/storybook/trpc-handler";
import type { RouterOutputs } from "lib/trpc";

/** A real preview hostname shape: 12 hex characters of an HMAC under the preview domain. */
const PREVIEW_URL = "https://a3f8b21c4d9e.preview.autonoma.app";
const WAITING_PATH = `/preview-waiting?to=${encodeURIComponent(PREVIEW_URL)}`;

type PreviewState = RouterOutputs["previewAccess"]["status"]["state"];

function withStatus(state: PreviewState): TrpcFixtures {
  return { previewAccess: { status: { state } } };
}

/**
 * The waiting room a browser lands on when it opens a preview link. Each story
 * pins one outcome of `previewAccess.status`.
 *
 * `ready` has no story on purpose: it fires `window.location.replace` on mount, so
 * it navigates away instead of rendering something a screenshot could capture.
 */
const meta = {
  title: "Pages/PreviewWaiting",
  component: PageStory,
  parameters: { pageStory: true },
} satisfies Meta<typeof PageStory>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The common case: the environment is asleep and the visit is waking it. */
export const Waking: Story = {
  args: { path: WAITING_PATH },
  parameters: { msw: { handlers: appShellHandlers(withStatus("waking")) } },
};

/** The build has not finished, so there is nothing to wake yet. */
export const Deploying: Story = {
  args: { path: WAITING_PATH },
  parameters: { msw: { handlers: appShellHandlers(withStatus("deploying")) } },
};

/** The deploy failed - waiting will never resolve, so the page says so and stops polling. */
export const Failed: Story = {
  args: { path: WAITING_PATH },
  parameters: { msw: { handlers: appShellHandlers(withStatus("failed")) } },
};

/** The pull request closed or a newer commit superseded this environment. */
export const Gone: Story = {
  args: { path: WAITING_PATH },
  parameters: { msw: { handlers: appShellHandlers(withStatus("gone")) } },
};

/** No such preview, or it belongs to an org this account is not a member of - deliberately indistinguishable. */
export const NotFound: Story = {
  args: { path: WAITING_PATH },
  parameters: { msw: { handlers: appShellHandlers(withStatus("not_found")) } },
};

/**
 * `to` is attacker-controlled, so a non-preview target is rejected before anything
 * renders or polls. No status fixture is needed - the guard returns first.
 */
export const InvalidLink: Story = {
  args: { path: `/preview-waiting?to=${encodeURIComponent("https://evil.example")}` },
  parameters: { msw: { handlers: appShellHandlers() } },
};
