import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
    plugins: [
        tailwindcss(),
        react(),
        tsconfigPaths({
            root: import.meta.dirname,
        }),
    ],
    envDir: path.resolve(import.meta.dirname, "..", ".."),
    build: {
        outDir: "dist",
        sourcemap: true,
    },
    server: {
        port: 3010,
    },
});
