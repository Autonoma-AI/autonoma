import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
    plugins: [
        tanstackRouter(),
        tailwindcss(),
        react({
            babel: {
                plugins: ["babel-plugin-react-compiler"],
            },
        }),
        tsconfigPaths({
            root: import.meta.dirname,
        }),
        VitePWA({
            registerType: "autoUpdate",
            workbox: {
                globPatterns: ["**/*.{js,css,html,woff,woff2}"],
                maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
                navigateFallback: "/index.html",
                navigateFallbackDenylist: [/^\/v1\//],
                runtimeCaching: [
                    {
                        urlPattern: /^https:\/\/fonts\.(googleapis|gstatic)\.com\/.*/i,
                        handler: "CacheFirst",
                        options: {
                            cacheName: "google-fonts",
                            expiration: { maxEntries: 30, maxAgeSeconds: 60 * 60 * 24 * 365 },
                        },
                    },
                    {
                        urlPattern: /\/v1\//,
                        handler: "NetworkFirst",
                        options: {
                            cacheName: "api-cache",
                            expiration: { maxEntries: 100, maxAgeSeconds: 60 * 5 },
                            networkTimeoutSeconds: 10,
                        },
                    },
                ],
            },
            devOptions: {
                enabled: false,
            },
        }),
    ],
    envDir: path.resolve(import.meta.dirname, "..", ".."),
    build: {
        outDir: "dist",
        sourcemap: true,
    },
    server: {
        port: 3000,
        proxy: {
            "/v1": {
                target: "http://localhost:4000",
                changeOrigin: true,
            },
        },
    },
});
