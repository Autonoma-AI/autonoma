import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { logger as rootLogger } from "../logger";

const packageJsonNameSchema = z.object({ name: z.string().min(1).optional() });

/**
 * Returns a `--filter=<spec>` argument for turbo. Prefers the package's `name`
 * field from package.json (turbo's canonical identifier), which the config
 * `app.name` (a Kubernetes name) may not match; falls back to a path-based
 * filter when package.json is missing, unreadable, or has no name field.
 * Path-based filters always work in turbo and survive packages with scoped
 * names that don't match the directory basename.
 *
 * `appDir` is the app's on-disk directory on the runner (where the repo is
 * cloned); `relAppDir` is that directory relative to the monorepo root, used
 * for the path-based fallback.
 */
export function resolveTurboFilter(appDir: string, relAppDir: string): string {
    const logger = rootLogger.child({ name: "resolveTurboFilter" });
    const pkgPath = join(appDir, "package.json");
    if (existsSync(pkgPath)) {
        try {
            const parsed = packageJsonNameSchema.safeParse(JSON.parse(readFileSync(pkgPath, "utf8")));
            if (parsed.success && parsed.data.name != null) {
                return `--filter=${parsed.data.name}`;
            }
        } catch (err) {
            logger.debug("Failed to read/parse package.json for turbo filter, falling back to path-based", {
                extra: { pkgPath, err },
            });
        }
    }
    return `--filter=./${relAppDir}`;
}
