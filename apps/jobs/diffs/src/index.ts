/**
 * The standalone diffs analysis job entry is no longer wired: analysis now runs
 * as the `analyzeDiffs` Temporal activity in `@autonoma/worker-diffs`. This stub
 * keeps the package's bundler entry valid until the package is removed in #744.
 */
import { logger } from "@autonoma/logger";

logger.error("The standalone diffs job entry has been removed; analysis runs as the analyzeDiffs Temporal activity.");
process.exit(1);
