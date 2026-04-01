import { defineConfig } from "nitro";

export default defineConfig({
    modules: ["workflow/nitro"],
    plugins: ["plugins/start-pg-world.ts"],
    routes: {
        "/**": "./src/nitro-entry.ts",
    },
});
