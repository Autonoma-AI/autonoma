import { logger as rootLogger } from "@autonoma/logger";
import {
    type AnalysisIssueKind,
    type AnalysisIssueSeverity,
    analysisIssueKindSchema,
    analysisIssueSeveritySchema,
} from "@autonoma/types";

/** Where an unparseable severity sorts and counts: listed, never dropped. */
const UNPARSED_SEVERITY: AnalysisIssueSeverity = analysisIssueSeveritySchema.enum.low;

export interface IssueEnums {
    kind: AnalysisIssueKind;
    severity: AnalysisIssueSeverity;
}

/**
 * How a stored issue row's enums are read.
 *
 * A malformed `severity` degrades to `low` rather than dropping the row: a dropped bug would still drive the
 * verdict (counted by raw string) while being invisible to its resolver - unresolvable forever. A malformed
 * `kind` returns undefined (and logs): it is the ownership signal itself, and by the same raw-string counting an
 * unparseable one can never drive a verdict.
 */
export function parseIssueEnums(row: { id: string; kind: string; severity: string }): IssueEnums | undefined {
    const logger = rootLogger.child({ name: "parseIssueEnums" });
    const kind = analysisIssueKindSchema.safeParse(row.kind);
    if (!kind.success) {
        logger.warn("Skipping an issue with a malformed kind", {
            extra: { issueId: row.id, kind: row.kind },
        });
        return undefined;
    }
    const severity = analysisIssueSeveritySchema.safeParse(row.severity);
    if (!severity.success) {
        logger.warn("Degrading an issue's malformed severity to low", {
            extra: { issueId: row.id, severity: row.severity },
        });
    }
    return {
        kind: kind.data,
        severity: severity.success ? severity.data : UNPARSED_SEVERITY,
    };
}
