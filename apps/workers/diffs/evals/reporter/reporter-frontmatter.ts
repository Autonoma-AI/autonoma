import { baseFrontmatterSchema } from "@autonoma/evals";
import type { z } from "zod";

/**
 * Deterministic-check frontmatter for a Reporter eval case.
 *
 * For now this is just the base fields (`description`, `skip`) - enough for the corpus loader to read a captured
 * case and for the round-trip / corpus tests to validate it. The scored Reporter eval adds the real checks here
 * (the open-vs-carry dedup call, issue kind/severity, flow membership, the `flowCorrections` budget); see the
 * reporter-eval work.
 */
export const reporterFrontmatterSchema = baseFrontmatterSchema;

export type ReporterFrontmatter = z.infer<typeof reporterFrontmatterSchema>;
