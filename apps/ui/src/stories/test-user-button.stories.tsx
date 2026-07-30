import type { Meta, StoryObj } from "@storybook/react-vite";
import { TestUserButtonUnavailable } from "routes/_blacklight/_app-shell/app.$appSlug/pull-requests/-components/preview/test-user-button";

/**
 * The test-user button's disabled state, which sits beside a service's URL when the environment
 * exists but isn't serving traffic (stale, stopped, still building). The reason lives in the (i)
 * tooltip, so the disabled button has to stay hoverable - hence the tooltip trigger wrapping it
 * rather than being the button.
 */
const meta = {
  title: "Components/TestUserButton",
  component: TestUserButtonUnavailable,
} satisfies Meta<typeof TestUserButtonUnavailable>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Stale: Story = { args: { status: "stale" } };

export const Stopped: Story = { args: { status: "stopped" } };

export const Building: Story = { args: { status: "building" } };
