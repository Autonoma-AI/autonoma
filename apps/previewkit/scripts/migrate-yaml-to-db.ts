#!/usr/bin/env tsx
/**
 * One-off migration: import each linked Application's `.preview.yaml` into the
 * DB-backed config model and set it as the active revision. The logic lives in
 * `src/config/migrate-yaml-to-revisions.ts` (typechecked + testable); this is a
 * thin entry that wires up the GitHub provider from env and reports the result.
 *
 *   pnpm --filter @autonoma/previewkit migrate:config            # apply
 *   pnpm --filter @autonoma/previewkit migrate:config --dry-run  # report only
 *   pnpm --filter @autonoma/previewkit migrate:config --force    # re-import even if already active
 *
 * Requires the previewkit env (GITHUB_APP_ID, GITHUB_PRIVATE_KEY, DATABASE_URL, ...).
 */
import { migrateYamlConfigsToDb } from "../src/config/migrate-yaml-to-revisions";
import { env } from "../src/env";
import { GitHubProvider } from "../src/git-provider/github-provider";
import { logger as rootLogger } from "../src/logger";

const logger = rootLogger.child({ name: "migrate-yaml-to-db" });

const dryRun = process.argv.includes("--dry-run");
const force = process.argv.includes("--force");

const provider = new GitHubProvider({ appId: env.GITHUB_APP_ID, privateKey: env.GITHUB_PRIVATE_KEY });

migrateYamlConfigsToDb({ provider, dryRun, force })
    .then((result) => {
        logger.info("Migration complete", { ...result, dryRun });
        // Non-zero when some applications failed so a supervised run / CI notices.
        process.exit(result.failed > 0 ? 1 : 0);
    })
    .catch((err) => {
        logger.fatal("Migration crashed", err);
        process.exit(1);
    });
