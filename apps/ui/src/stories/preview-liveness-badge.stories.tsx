import type { Meta, StoryObj } from "@storybook/react-vite";
import { PreviewLivenessBadge } from "components/preview-liveness-badge";

// The four honest runtime states a preview can be in, worded so a deployed-but-
// scaled-to-zero preview reads "Idle" rather than "Ready". "unknown" renders
// nothing, so it is not shown here.
function LivenessBadgeStates() {
  return (
    <div className="flex items-center gap-3 bg-surface-base p-6">
      <PreviewLivenessBadge state="asleep" />
      <PreviewLivenessBadge state="waking" />
      <PreviewLivenessBadge state="healthy" />
      <PreviewLivenessBadge state="error" />
    </div>
  );
}

const meta = {
  title: "Components/PreviewLivenessBadge",
  component: LivenessBadgeStates,
} satisfies Meta<typeof LivenessBadgeStates>;
export default meta;

type Story = StoryObj<typeof meta>;

export const States: Story = {};
