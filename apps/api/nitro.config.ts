import { defineConfig } from "nitro";

export default defineConfig({
    routes: {
        "/**": "./src/nitro-entry.ts",
    },
});
