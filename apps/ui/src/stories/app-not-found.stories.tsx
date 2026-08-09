import type { Meta, StoryObj } from "@storybook/react-vite";
import { appShellHandlers } from "lib/storybook/base-fixtures";
import { PageStory } from "lib/storybook/page-story";
import type { TrpcFixtures } from "lib/storybook/trpc-handler";

/**
 * What an application deep link resolves to when the active organization does not have that slug.
 *
 * Slugs are unique per organization, not globally, so the same link opens a different application -
 * or nothing - depending on who you are acting as. Anyone in more than one organization can be sent a
 * colleague's link, which is why this screen exists rather than a bare "not found".
 *
 * `/app/northwind-checkout` is deliberately absent from the baseline application list (`acme-web`), so
 * the route's loader throws `notFound()` and `AppNotFound` renders.
 */
const MISSING_SLUG_PATH = "/app/northwind-checkout";

/** Two of the caller's own organizations hold the slug, so the screen has to ask which one. */
const slugInTwoOrganizations: TrpcFixtures = {
  organization: {
    appSlugOwners: [
      { organizationId: "org_fixture_02", organizationName: "Northwind QA", organizationSlug: "northwind-qa" },
      { organizationId: "org_fixture_03", organizationName: "Northwind Staging", organizationSlug: "northwind-stg" },
    ],
  },
};

/** Nobody the caller can reach has it - the only case that is genuinely "not found". */
const slugNowhere: TrpcFixtures = {
  organization: { appSlugOwners: [] },
};

const meta = {
  title: "Pages/AppNotFound",
  component: PageStory,
  parameters: { pageStory: true },
} satisfies Meta<typeof PageStory>;

export default meta;

type Story = StoryObj<typeof meta>;

export const ChooseOrganization: Story = {
  args: { path: MISSING_SLUG_PATH },
  parameters: { msw: { handlers: appShellHandlers(slugInTwoOrganizations) } },
};

export const NotFoundAnywhere: Story = {
  args: { path: MISSING_SLUG_PATH },
  parameters: { msw: { handlers: appShellHandlers(slugNowhere) } },
};
