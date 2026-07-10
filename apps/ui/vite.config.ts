import { readFileSync } from "node:fs";
import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";
import tsconfigPaths from "vite-tsconfig-paths";

function readApiPort(): string {
    try {
        return readFileSync(path.resolve(import.meta.dirname, "..", "..", ".api-port"), "utf-8").trim();
    } catch {
        return process.env.API_PORT ?? "4000";
    }
}

// Framework core that loads on every route. Isolating it into stable, long-cached
// vendor chunks means an app-code deploy doesn't force browsers to re-download it.
// Route-specific libs (recharts, react-markdown, ...) are intentionally left out so
// TanStack Router's autoCodeSplitting can keep them in their per-route chunks.
//
// The substring checks assume the resolved module path contains "node_modules/<pkg>/".
// pnpm's real-path layout (.pnpm/<pkg>@<ver>/node_modules/<pkg>/...) satisfies this; a
// future change to the resolver or hoisting would silently route a package to the
// default chunk rather than break the build.
function vendorChunk(id: string): string | undefined {
    if (!id.includes("node_modules")) return undefined;

    const isReactCore =
        id.includes("node_modules/react/") ||
        id.includes("node_modules/react-dom/") ||
        id.includes("node_modules/scheduler/");
    if (isReactCore) return "react-vendor";

    // Radix/base-ui primitives underpin every @autonoma/blacklight component.
    if (id.includes("node_modules/@base-ui/") || id.includes("node_modules/@radix-ui/")) {
        return "ui-vendor";
    }

    // Router and Query load on every page. @tanstack/react-table and react-virtual are
    // only pulled in by the blacklight Table, so they deliberately fall through to
    // per-route splitting instead of riding along on the eager vendor chunk.
    const isRouterOrQuery =
        id.includes("node_modules/@tanstack/react-router/") ||
        id.includes("node_modules/@tanstack/router-core/") ||
        id.includes("node_modules/@tanstack/history/") ||
        id.includes("node_modules/@tanstack/react-query/") ||
        id.includes("node_modules/@tanstack/query-core/") ||
        id.includes("node_modules/@tanstack/store/") ||
        id.includes("node_modules/@tanstack/react-store/");
    if (isRouterOrQuery) return "tanstack-vendor";

    if (id.includes("node_modules/@sentry/") || id.includes("node_modules/@sentry-internal/")) {
        return "sentry-vendor";
    }
    if (id.includes("node_modules/posthog-js/")) return "posthog-vendor";

    return undefined;
}

export default defineConfig({
    plugins: [
        tanstackRouter({ autoCodeSplitting: true }),
        tailwindcss(),
        react({
            babel: {
                plugins: ["babel-plugin-react-compiler"],
            },
        }),
        tsconfigPaths(),
        // The PWA is being retired. We previously shipped an autoUpdate service
        // worker, so users who already loaded the app have one registered. Simply
        // dropping the plugin would leave that stale worker in place, pinning them
        // to an old cached build. `selfDestroying` ships a service worker (at the
        // same /sw.js path the browser already polls) that unregisters itself and
        // clears its caches on the next visit. Once this has propagated to clients,
        // the plugin and this block should be removed entirely in a follow-up.
        VitePWA({
            selfDestroying: true,
        }),
    ],
    envDir: path.resolve(import.meta.dirname, "..", ".."),
    build: {
        outDir: "dist",
        sourcemap: true,
        rollupOptions: {
            output: {
                manualChunks: vendorChunk,
            },
        },
    },
    server: {
        port: 3000,
        proxy: {
            "/v1": {
                target: `http://localhost:${readApiPort()}`,
                changeOrigin: true,
            },
            "/ingest": {
                target: `http://localhost:${readApiPort()}`,
                changeOrigin: true,
            },
            // MCP OAuth discovery: Better Auth advertises these at the app origin,
            // but the API serves them (mirrors the nginx.conf.template rule).
            "/.well-known/oauth-": {
                target: `http://localhost:${readApiPort()}`,
                changeOrigin: true,
            },
        },
    },
});
