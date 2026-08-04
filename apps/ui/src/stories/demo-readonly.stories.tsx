import type { Meta, StoryObj } from "@storybook/react-vite";
import { demoModalStore } from "lib/demo-modal-store";
import { appShellHandlers, baseApplication } from "lib/storybook/base-fixtures";
import { PageStory } from "lib/storybook/page-story";
import type { TrpcFixtures } from "lib/storybook/trpc-handler";
import { useEffect } from "react";
import { dashboardFixtures } from "./app-home.stories";

/**
 * The read-only demo UX rendered through the real app shell: the persistent top banner
 * shown while the active org is the demo, and the global "sign up to continue" modal the
 * write-block raises in place of a per-control guard. `isDemo` comes from a demo
 * `auth.activeOrg` fixture, so both stories reuse the flagship dashboard fixtures.
 */
const demoFixtures: TrpcFixtures = {
  ...dashboardFixtures,
  auth: {
    activeOrg: {
      id: "org_fixture_01",
      name: "Northwind Bank",
      slug: "northwind",
      isDemo: true,
      canReturnToAccount: false,
      mergeGateEnabled: false,
      vercelMarketplaceEntry: false,
    },
  },
};

const meta = {
  title: "Pages/DemoReadOnly",
  component: PageStory,
  parameters: {
    pageStory: true,
    msw: { handlers: appShellHandlers(demoFixtures) },
  },
} satisfies Meta<typeof PageStory>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Banner: Story = {
  args: { path: `/app/${baseApplication.slug}` },
};

/**
 * The banner for a visitor who entered the demo from their own signed-in session: the
 * conversion CTA gives way to the way back, since they already have an account waiting.
 */
export const BannerWithReturn: Story = {
  args: { path: `/app/${baseApplication.slug}` },
  parameters: {
    msw: {
      handlers: appShellHandlers({
        ...demoFixtures,
        auth: {
          activeOrg: {
            id: "org_fixture_01",
            name: "Northwind Bank",
            slug: "northwind",
            isDemo: true,
            canReturnToAccount: true,
            mergeGateEnabled: false,
            vercelMarketplaceEntry: false,
          },
        },
      }),
    },
  },
};

/**
 * The banner for a visitor who entered via Vercel's marketplace listing: the sign-up CTA
 * gives way to a link back to the listing, since a listing page can't push a direct
 * external sign-up.
 */
export const BannerWithVercelInstall: Story = {
  args: { path: `/app/${baseApplication.slug}` },
  parameters: {
    msw: {
      handlers: appShellHandlers({
        ...demoFixtures,
        auth: {
          activeOrg: {
            id: "org_fixture_01",
            name: "Northwind Bank",
            slug: "northwind",
            isDemo: true,
            canReturnToAccount: false,
            mergeGateEnabled: false,
            vercelMarketplaceEntry: true,
          },
        },
      }),
    },
  },
};

export const WriteBlockModal: Story = {
  args: { path: `/app/${baseApplication.slug}` },
  decorators: [
    (Story) => {
      useEffect(() => {
        demoModalStore.open();
        return () => demoModalStore.close();
      }, []);
      return <Story />;
    },
  ],
};
