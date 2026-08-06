import type { Meta, StoryObj } from "@storybook/react-vite";
import { appShellHandlers } from "lib/storybook/base-fixtures";
import { PageStory } from "lib/storybook/page-story";
import type { RouterOutputs } from "lib/trpc";
import { dashboardFixtures } from "./app-home.stories";

const generations: RouterOutputs["generations"]["list"] = [
  {
    id: "cmg7k2p9a0001qz8h3f7bd2e1",
    shortId: "cmg7k2p9",
    testName: "Checkout with a saved card",
    tags: ["checkout", "critical"],
    stepCount: 14,
    status: "success",
    createdAt: new Date("2026-01-07T15:42:00.000Z"),
  },
  {
    id: "cmg7n4t1c0002qz8h9v3xk1r7",
    shortId: "cmg7n4t1",
    testName: "Remove an item from the cart",
    tags: ["cart"],
    stepCount: 9,
    status: "failed",
    createdAt: new Date("2026-01-07T15:05:00.000Z"),
  },
  {
    id: "cmg7q8w5e0003qz8h2b6mn0f4",
    shortId: "cmg7q8w5",
    testName: "Sign in with an expired password",
    tags: ["auth"],
    stepCount: 6,
    status: "running",
    createdAt: new Date("2026-01-07T14:58:00.000Z"),
  },
];

/** The staff-only list of every run for an application: read-only, one row per run, no row actions. */
const meta = {
  title: "Pages/AdminGenerations",
  component: PageStory,
  parameters: {
    pageStory: true,
    layout: "fullscreen",
    msw: {
      handlers: appShellHandlers({ ...dashboardFixtures, generations: { list: generations } }, { role: "admin" }),
    },
  },
} satisfies Meta<typeof PageStory>;

export default meta;
type Story = StoryObj<typeof meta>;

export const List: Story = {
  args: { path: "/app/acme-web/admin/generations" },
};
