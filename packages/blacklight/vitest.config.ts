import { defineConfig } from "vitest/config";

// Deliberately does not reuse `vite.config.ts`: that config exists to serve the
// component docs site, and its React/Tailwind plugins are dead weight here.
export default defineConfig({
    test: {
        include: ["src/**/*.test.ts"],
    },
});
