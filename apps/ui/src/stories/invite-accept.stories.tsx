import type { InvitationPreview } from "@autonoma/types";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { appShellHandlers } from "lib/storybook/base-fixtures";
import { PageStory } from "lib/storybook/page-story";
import type { TrpcFixtures } from "lib/storybook/trpc-handler";

const INVITATION_ID = "inv_fixture_01";
const INVITE_PATH = `/invite/${INVITATION_ID}`;

function invitationFixtures(invitation: InvitationPreview): TrpcFixtures {
  return { organization: { invitation } };
}

const BASE_INVITATION = {
  invitationId: INVITATION_ID,
  organizationName: "Acme",
  inviterName: "Dana Whitfield",
  invitedEmail: "priya@getacme.io",
} as const;

/** A valid invitation waiting on the invitee. Joining is additive - nothing is given up. */
const joinable: InvitationPreview = {
  ...BASE_INVITATION,
  outcome: "joinable",
};

const wrongAccount: InvitationPreview = {
  ...BASE_INVITATION,
  outcome: "wrong-account",
};

const expired: InvitationPreview = {
  ...BASE_INVITATION,
  outcome: "expired",
};

const meta = {
  title: "Pages/InviteAccept",
  component: PageStory,
  parameters: {
    pageStory: true,
    msw: { handlers: appShellHandlers(invitationFixtures(joinable)) },
  },
} satisfies Meta<typeof PageStory>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Joinable: Story = {
  args: { path: INVITE_PATH },
};

export const WrongAccount: Story = {
  parameters: { msw: { handlers: appShellHandlers(invitationFixtures(wrongAccount)) } },
  args: { path: INVITE_PATH },
};

export const Expired: Story = {
  parameters: { msw: { handlers: appShellHandlers(invitationFixtures(expired)) } },
  args: { path: INVITE_PATH },
};
