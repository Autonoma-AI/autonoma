import type { Meta, StoryObj } from "@storybook/react-vite";
import { userEvent, within } from "storybook/test";
import { PreviewRouterQuiz } from "../routes/_blacklight/onboarding/-components/preview-router-quiz";

const APP_ID = "app_fixture_01";

/**
 * The routing questionnaire is pure local state - it persists nothing until an
 * outcome button fires `onChoose` - so these stories need no network fixtures.
 * Each one plays the clicks that reach the screen it documents.
 */
const meta = {
  title: "Onboarding/PreviewRouterQuiz",
  component: PreviewRouterQuiz,
  parameters: { layout: "padded" },
  args: { appId: APP_ID, onChoose: () => undefined, onBack: () => undefined },
} satisfies Meta<typeof PreviewRouterQuiz>;

export default meta;

type Story = StoryObj<typeof meta>;

/** The opening gate: does the user have per-branch previews at all. */
export const PreviewsGate: Story = {};

/**
 * The tenant question, now asked directly after the backend one. This is the
 * screen most users answer "yes" to, which ends the quiz two questions in.
 */
export const TenantQuestion: Story = {
  args: { startProvider: "vercel" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: /All on Vercel/ }));
    await canvas.findByText(/owned by a tenant you could delete/);
  },
};

/**
 * The database-branching fallback, reached only after tenant scoping is ruled
 * out. The copy has to make clear this is a *database* branch, not a git one.
 */
export const DatabaseBranchFallback: Story = {
  args: { startProvider: "vercel" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: /All on Vercel/ }));
    await userEvent.click(await canvas.findByRole("button", { name: /No, some data is shared/ }));
    await userEvent.click(await canvas.findByRole("button", { name: /^Neon$/ }));
    await canvas.findByText(/its own database branch/);
  },
};

/** Tenant-scoped with no global tables - the two-question happy path. */
export const TenantIsolationOutcome: Story = {
  args: { startProvider: "vercel" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: /All on Vercel/ }));
    await userEvent.click(await canvas.findByRole("button", { name: /Yes, scoped to a tenant/ }));
    await userEvent.click(await canvas.findByRole("button", { name: /No, everything's tenant-scoped/ }));
    await canvas.findByText(/tenant isolation/i);
  },
};

/**
 * Failing both routes. The PreviewKit reason must name the ORIGINAL disqualifier
 * (no tenant scoping) rather than the database question answered last.
 */
export const BothRoutesRuledOut: Story = {
  args: { startProvider: "vercel" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: /All on Vercel/ }));
    await userEvent.click(await canvas.findByRole("button", { name: /No, some data is shared/ }));
    await userEvent.click(await canvas.findByRole("button", { name: /Plain Postgres, RDS, MongoDB/ }));
    await canvas.findByText(/Data isn't cleanly tenant-scoped/);
  },
};
