import "@autonoma/blacklight/styles.css";
import type { Preview } from "@storybook/react-vite";
import { initialize, mswLoader } from "msw-storybook-addon";
import { StoryShell } from "../src/lib/storybook/story-shell";

initialize({
  // Vite dev-server asset requests must pass through untouched; only API
  // calls that reached the network without a fixture deserve a warning.
  onUnhandledRequest: (request, print) => {
    if (new URL(request.url).pathname.startsWith("/v1/")) print.warning();
  },
});

const preview: Preview = {
  loaders: [mswLoader],
  parameters: {
    layout: "fullscreen",
  },
  decorators: [
    (Story, context) => {
      // Page stories bring their own full router/providers - the shell
      // wrapper would fight the real route tree's layouts.
      if (context.parameters["pageStory"] === true) return <Story />;
      return (
        <StoryShell>
          <Story />
        </StoryShell>
      );
    },
  ],
};

export default preview;
