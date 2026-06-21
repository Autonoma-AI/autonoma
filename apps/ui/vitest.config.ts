import { join } from "node:path";
import { config } from "dotenv";
import tsconfigPaths from "vite-tsconfig-paths";
import { defineConfig } from "vitest/config";

export default defineConfig({
    plugins: [tsconfigPaths()],
    test: {
        env: { ...config({ path: join(__dirname, "../../.env") }).parsed },
    },
});
