import { db, type PrismaClient } from "@autonoma/db";
import { type Logger, logger as rootLogger } from "../logger";
import { dedupeSecretRecordsByTarget } from "./dedupe-secret-targets";
import { previewSecretName } from "./preview-secret-name";
import type { AppSecretInfo, RuntimeSecretMaterializer, SecretTarget } from "./runtime-secret-materializer";

/**
 * Resolves which K8s Secret each app mounts, and gets it populated before the
 * deployer rolls out.
 *
 * Owns the parts that hold whichever store answers: loading the Application's
 * secret rows, collapsing rows that fold to one Secret target, and picking the
 * store per app. Postgres is preferred once an environment has flipped, with
 * External Secrets as the per-app fallback - a bundle Postgres holds nothing for
 * means not backfilled, not "no secrets", so a whole-namespace switch would boot
 * pods with no credentials on the first un-backfilled app.
 */
export class RuntimeSecrets {
    private readonly logger: Logger;

    constructor(
        private readonly eso: RuntimeSecretMaterializer,
        /** Absent unless this environment reads Postgres and has a CMK to open it with. */
        private readonly postgres?: RuntimeSecretMaterializer,
        private readonly prisma: PrismaClient = db,
    ) {
        this.logger = rootLogger.child({ name: this.constructor.name });
    }

    /**
     * Returns appName -> {secretName, secretVersion} for the apps that have a
     * registered secret, so the deployer can wire `envFrom` per Deployment and
     * stamp the secret version on the pod template. Apps without a registered
     * secret are simply absent from the map.
     */
    async applyForNamespace(
        organizationId: string,
        githubRepositoryId: number,
        namespace: string,
        appNames: string[],
    ): Promise<Map<string, AppSecretInfo>> {
        this.logger.info("Resolving runtime secrets for namespace", {
            organizationId,
            githubRepositoryId,
            namespace,
            appNames,
        });

        const targets = await this.loadTargets(organizationId, githubRepositoryId, namespace, appNames);
        if (targets.length === 0) {
            this.logger.info("No secrets registered for any of the listed apps", { namespace, appNames });
            return new Map();
        }

        // Postgres first, then whatever it could not supply. Sequential because the
        // fallback set is only known once the first pass has run, and because both
        // would otherwise contend for ownership of the same Secret.
        const fromPostgres = (await this.postgres?.materialize(namespace, organizationId, targets)) ?? new Map();
        const remaining = targets.filter((target) => !fromPostgres.has(target.record.appName));
        const fromAws = await this.eso.materialize(namespace, organizationId, remaining);

        const result = new Map([...fromAws, ...fromPostgres]);
        this.logger.info("Runtime secrets resolved", {
            namespace,
            extra: {
                requested: appNames.length,
                registered: targets.length,
                fromPostgres: fromPostgres.size,
                fromAws: fromAws.size,
            },
        });
        return result;
    }

    /** One row per K8s Secret this namespace's apps mount. */
    private async loadTargets(
        organizationId: string,
        githubRepositoryId: number,
        namespace: string,
        appNames: string[],
    ): Promise<SecretTarget[]> {
        // Scope to THIS deploy's Application, identified by (organizationId,
        // githubRepositoryId) - not the whole org. App names are unique within an
        // application's topology but NOT across an org: a bare `appName IN (...)`
        // match collides when two applications each own an app of the same name
        // (e.g. "web"), which would apply a foreign application's secret into this
        // namespace and its ExternalSecret would never go Ready. Dependency-repo
        // apps ride the primary app's config, so their secrets live under this same
        // Application.
        const records = await this.prisma.previewkitSecret.findMany({
            where: {
                application: { organizationId, githubRepositoryId },
                appName: { in: appNames },
            },
            select: { id: true, applicationId: true, appName: true, awsSecretArn: true },
        });
        if (records.length === 0) return [];

        const targets = records.map((record) => ({
            id: record.id,
            applicationId: record.applicationId,
            appName: record.appName,
            awsSecretArn: record.awsSecretArn ?? undefined,
        }));

        // Collapse rows that fold to one K8s Secret target (a same-app duplicate).
        // Only one writer per target is possible either way: ESO allows a single
        // Owner, and two Postgres bundles writing one Secret would just overwrite
        // each other. Keep one and log the rest.
        const { chosen, collisions } = dedupeSecretRecordsByTarget(targets, previewSecretName);
        for (const collision of collisions) {
            this.logger.fatal(
                "Multiple PreviewkitSecret rows resolve to one K8s Secret target; keeping one to avoid an ownership collision",
                {
                    namespace,
                    extra: {
                        target: collision.secretName,
                        keptSecretId: collision.kept.id,
                        droppedSecretIds: collision.dropped.map((record) => record.id),
                        awsSecretArns: [
                            ...new Set([collision.kept, ...collision.dropped].map((record) => record.awsSecretArn)),
                        ],
                    },
                },
            );
        }
        return chosen;
    }
}
