/**
 * The subset of a PreviewkitSecret row that determines which K8s Secret it writes:
 * the app it belongs to (→ target Secret name), the Application that owns it
 * (→ the bundle its values are read from), and the row id, which only appears in
 * the collision log.
 */
export interface SecretTargetRecord {
    id: string;
    applicationId: string;
    appName: string;
}

export interface SecretTargetCollision {
    secretName: string;
    kept: SecretTargetRecord;
    dropped: SecretTargetRecord[];
}

export interface SecretTargetDedupe {
    chosen: Array<{ record: SecretTargetRecord; secretName: string }>;
    collisions: SecretTargetCollision[];
}

/**
 * Collapse secret rows to one per K8s Secret target.
 *
 * `deriveSecretName` (`previewSecretName`) is a lossy, many-to-one derivation of
 * `appName` - lowercase, hyphen-collapse, 55-char truncation - while the DB
 * uniqueness key is the RAW appName. So two distinct rows (e.g. "boss-roast" and
 * "boss--roast", or a legacy duplicate registration) can map to the same target
 * Secret. Writing both would leave whichever went last in place, with no record of
 * the other having been overwritten.
 *
 * Keep the oldest row per target (stable cuid order - the original registration)
 * and report the rest as collisions so the caller can alert on the data problem.
 */
export function dedupeSecretRecordsByTarget(
    records: SecretTargetRecord[],
    deriveSecretName: (appName: string) => string,
): SecretTargetDedupe {
    const byTarget = new Map<string, SecretTargetRecord[]>();
    for (const record of records) {
        const target = deriveSecretName(record.appName);
        const group = byTarget.get(target);
        if (group == null) byTarget.set(target, [record]);
        else group.push(record);
    }

    const chosen: SecretTargetDedupe["chosen"] = [];
    const collisions: SecretTargetCollision[] = [];
    for (const [secretName, group] of byTarget) {
        const ordered = group.length > 1 ? [...group].sort((a, b) => (a.id < b.id ? -1 : 1)) : group;
        const [winner, ...losers] = ordered;
        if (winner == null) continue; // groups are never empty; satisfies the type checker

        if (losers.length > 0) collisions.push({ secretName, kept: winner, dropped: losers });
        chosen.push({ record: winner, secretName });
    }
    return { chosen, collisions };
}
