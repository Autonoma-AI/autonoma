import { LAST_SOCIAL_PROVIDER_COOKIE } from "@autonoma/types";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { authHandlers } from "lib/storybook/auth-handlers";
import { PageStory } from "lib/storybook/page-story";
import { trpcHandler } from "lib/storybook/trpc-handler";

/**
 * The logged-out login page. `authHandlers({})` deliberately omits a session -
 * with one, the page still renders, but it is no longer the screen a visitor sees.
 *
 * Which buttons appear is the API's answer, not the page's: `auth.socialProviders`
 * lists only the providers this environment holds credentials for, so the fixture is
 * what decides between the stories below.
 */
const meta = {
  title: "Pages/Login",
  component: PageStory,
  parameters: {
    pageStory: true,
    msw: {
      handlers: [trpcHandler({ auth: { socialProviders: ["google", "github"] } }), ...authHandlers({})],
    },
  },
} satisfies Meta<typeof PageStory>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * The API sets this cookie on a successful sign-in and the page reads it back. Every
 * story states which value it wants - cookies outlive a story navigation, so a story
 * that stayed silent would inherit whatever the previously shot one left behind.
 */
function withLastProvider(provider?: string) {
  return function LastProviderDecorator(Story: () => React.ReactElement) {
    document.cookie =
      provider == null
        ? `${LAST_SOCIAL_PROVIDER_COOKIE}=; path=/; max-age=0`
        : `${LAST_SOCIAL_PROVIDER_COOKIE}=${provider}; path=/`;
    return <Story />;
  };
}

/** A first-time visitor: both providers, neither preferred. */
export const Default: Story = {
  args: { path: "/login" },
  decorators: [withLastProvider()],
};

/**
 * A returning visitor who last signed in with GitHub. That provider moves to the top and
 * is badged, which is what keeps someone from signing up a second time on the other
 * provider under a different email.
 */
export const LastUsedGitHub: Story = {
  args: { path: "/login" },
  decorators: [withLastProvider("github")],
};

/**
 * An environment with no GitHub OAuth app - GITHUB_CLIENT_ID/SECRET unset. The button is
 * absent rather than present-and-broken, which is what it used to be.
 */
export const GoogleOnly: Story = {
  args: { path: "/login" },
  decorators: [withLastProvider()],
  parameters: {
    msw: {
      handlers: [trpcHandler({ auth: { socialProviders: ["google"] } }), ...authHandlers({})],
    },
  },
};
