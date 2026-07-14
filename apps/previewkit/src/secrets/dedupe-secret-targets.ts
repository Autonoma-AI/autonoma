/**
 * The subset of a PreviewkitSecret row that determines its K8s ExternalSecret:
 * the row id (→ ExternalSecret name), the app it belongs to (→ target Secret
 * name), and the AWS SM ARN it syncs from.
 */
export interface SecretTargetRecord {
    id: string;
    appName: string;
    awsSecretArn: string;
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
 * `deriveSecretName` (the manager's `toK8sName`) is a lossy, many-to-one
 * derivation of `appName` - lowercase, hyphen-collapse, 55-char truncation -
 * while the DB uniqueness key is the RAW appName. So two distinct rows (e.g.
 * "boss-roast" and "boss--roast", or a legacy duplicate registration) can map
 * to the same target Secret. External Secrets Operator allows only one Owner
 * per target Secret, so emitting an ExternalSecret for each makes all but one
 * error permanently ("target is owned by another ExternalSecret"); the rejected
 * one never goes Ready and times out the pre-rollout sync wait, failing the
 * whole deploy.
 *
 * Keep the oldest row per target (stable cuid order - the original registration)
 * and report the rest as collisions so the caller can prune their ExternalSecret
 * CRs and alert on the data problem.
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
