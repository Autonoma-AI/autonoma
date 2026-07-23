import { VideoPlayer } from "@autonoma/blacklight";
import type { Meta, StoryObj } from "@storybook/react-vite";

/**
 * The centralized run-recording player: native controls, a playback-speed selector, and - when a dead-time-
 * stripped recording exists - an Optimized/Original toggle.
 */
const meta = {
  title: "Components/VideoPlayer",
  component: VideoPlayer,
  decorators: [
    (Story) => (
      <div className="mx-auto max-w-3xl p-8">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof VideoPlayer>;
export default meta;

type Story = StoryObj<typeof meta>;

/** With an optimized recording available: the Optimized/Original toggle is shown, Optimized selected, 2x. */
export const WithOptimizedToggle: Story = {
  args: {
    src: "https://assets.autonoma.app/recording-original.webm",
    optimizedSrc: "https://assets.autonoma.app/recording-optimized.mp4",
    label: "Run recording",
  },
};

/** No optimized recording: only the original plays, no toggle, defaults to 8x. */
export const OriginalOnly: Story = {
  args: {
    src: "https://assets.autonoma.app/recording-original.webm",
    label: "Run recording",
  },
};
