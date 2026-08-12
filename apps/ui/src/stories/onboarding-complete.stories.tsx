import type { Meta, StoryObj } from "@storybook/react-vite";
import { baseApplication, baseSuiteHealth } from "lib/storybook/base-fixtures";
import { trpcHandler } from "lib/storybook/trpc-handler";
import type { RouterOutputs } from "lib/trpc";
import { userEvent, within } from "storybook/test";
import { CompletePage, HandoffActions } from "../routes/_blacklight/onboarding/complete";

const artifactStatus: RouterOutputs["applicationSetups"]["artifactStatus"] = {
  complete: true,
  stepComplete: true,
  artifacts: [
    { key: "recipe", received: true, meta: "3 scenarios" },
    { key: "tests", received: true, meta: "14 files" },
    { key: "kb", received: true },
    { key: "scenarios", received: true },
  ],
};

const repository: RouterOutputs["github"]["getApplicationRepository"] = {
  id: 123456,
  name: "web",
  fullName: "acme/web",
  defaultBranch: "main",
  private: true,
};

/**
 * The end of onboarding. Every step is behind the user, and the screen's job is to
 * point attention out of the dashboard and onto their next pull request - so the
 * one action it offers is the CLAUDE.md line that makes the loop automatic.
 */
const meta = {
  title: "Onboarding/Complete",
  component: CompletePage,
  parameters: {
    layout: "padded",
    msw: {
      handlers: [
        trpcHandler({
          applications: { list: [baseApplication], suiteHealth: baseSuiteHealth },
          applicationSetups: { artifactStatus },
          github: { getApplicationRepository: repository },
        }),
      ],
    },
  },
} satisfies Meta<typeof CompletePage>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Finished: Story = {
  args: { appId: baseApplication.id },
};

/**
 * The clipboard refused, which is what happens outside a secure context. The line
 * is printed instead so the one action this screen asks for is never a dead button.
 * A headless browser grants no clipboard, so clicking Copy here reaches exactly
 * this path.
 */
export const CopyUnavailable: Story = {
  args: { appId: baseApplication.id },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const copy = await canvas.findByRole("button", { name: /Copy the CLAUDE.md line/ }, { timeout: 10_000 });
    await userEvent.click(copy);
    await canvas.findByText(/tell me which of them autonoma caught/, undefined, { timeout: 10_000 });
  },
};

/**
 * The two arrangements of the exit, side by side. Before the copy the CLAUDE.md
 * line is the only primary; after it, that button has nothing left to do and
 * "Go to dashboard" is promoted.
 */
export const ActionsBeforeAndAfterCopy: StoryObj<typeof HandoffActions> = {
  render: () => (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-2">
        <span className="font-mono text-3xs uppercase tracking-widest text-text-secondary">Before copying</span>
        <HandoffActions copied={false} appSlug={baseApplication.slug} onCopy={() => undefined} />
      </div>
      <div className="flex flex-col gap-2">
        <span className="font-mono text-3xs uppercase tracking-widest text-text-secondary">After copying</span>
        <HandoffActions copied appSlug={baseApplication.slug} onCopy={() => undefined} />
      </div>
    </div>
  ),
};
