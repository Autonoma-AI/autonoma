import type { StorybookConfig } from "@storybook/react-vite";

const config: StorybookConfig = {
    framework: "@storybook/react-vite",
    stories: ["../src/**/*.stories.tsx"],
    // "./public" holds the MSW service worker; "../public" exposes the app's
    // static assets (logos, button SVGs) that components reference by path.
    staticDirs: ["./public", "../public"],
};

export default config;
