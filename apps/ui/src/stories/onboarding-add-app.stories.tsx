import type { Meta, StoryObj } from "@storybook/react-vite";
import { appShellHandlers } from "lib/storybook/base-fixtures";
import { PageStory } from "lib/storybook/page-story";
import type { TrpcFixtures } from "lib/storybook/trpc-handler";

/**
 * The first onboarding step before any GitHub App exists: the install CTA paired with
 * the "View demo" escape hatch for someone who wants to see the product before wiring
 * their own repositories into it.
 */
const installFixtures: TrpcFixtures = {
  github: {
    getInstallation: null,
    listRepositories: [],
    getConfig: { installUrl: "https://github.com/apps/autonoma-ai/installations/new" },
  },
  applications: { list: [] },
};

const meta = {
  title: "Pages/OnboardingAddApp",
  component: PageStory,
  parameters: {
    pageStory: true,
    msw: { handlers: appShellHandlers(installFixtures) },
  },
} satisfies Meta<typeof PageStory>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Install: Story = {
  args: { path: "/onboarding" },
};
