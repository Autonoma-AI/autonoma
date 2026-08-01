import { db, type PrismaClient } from "@autonoma/db";
import { PreviewPlatformError } from "../errors";
import { type Logger, logger as rootLogger } from "../logger";
import { dedupeSecretRecordsByTarget } from "./dedupe-secret-targets";
import type { PostgresSecretMaterializer } from "./postgres-secret-materializer";
import { previewSecretName } from "./preview-secret-name";
import type { AppSecretInfo, SecretTarget } from "./runtime-secret-types";

/**
 * Resolves which K8s Secret each app mounts, and gets it populated before the
 * deployer rolls out.
 *
 * Loads the Application's secret bundles, collapses the ones that fold to a single
 * Secret target, and hands them to the materializer. There is one store: a target
 * it cannot serve fails the deploy rather than falling through to External Secrets,
 * which no longer has values to serve from.
 */
export class RuntimeSecrets {
    private readonly logger: Logger;

    constructor(
        /** Absent when this environment has no CMK to unwrap an encryption key with. */
        private readonly materializer?: PostgresSecretMaterializer,
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

        if (this.materializer == null) {
            throw new PreviewPlatformError(
                `${targets.length} app(s) in this deploy have registered secrets, but this environment has no ` +
                    `PREVIEWKIT_SECRETS_CMK configured, so no encryption key can be unwrapped.`,
            );
        }

        const written = await this.materializer.materialize(namespace, organizationId, targets);

        // Every registered target has to end up populated before the deployer rolls
        // out. `envFrom` is captured at pod start, so an app whose Secret was not
        // written would come up "ready" against missing credentials and 401 every
        // signed call - a failure that looks like the application's, far from here.
        const unserved = targets
            .filter((target) => !written.has(target.record.appName))
            .map(({ record }) => record.appName);
        if (unserved.length > 0) {
            throw new PreviewPlatformError(
                `No secret values could be written for ${unserved.join(", ")}; aborting before app rollout.`,
            );
        }

        this.logger.info("Runtime secrets resolved", {
            namespace,
            extra: { requested: appNames.length, registered: targets.length, written: written.size },
        });
        return written;
    }

    /** One entry per K8s Secret this namespace's apps mount. */
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
        // (e.g. "web"), which would mount a foreign application's secret into this
        // namespace. Dependency-repo apps ride the primary app's config, so their
        // secrets live under this same Application.
        const records = await this.prisma.previewkitSecret.findMany({
            where: {
                application: { organizationId, githubRepositoryId },
                appName: { in: appNames },
            },
            select: { applicationId: true, appName: true },
            // One row per key, so the bundles are what this wants, not the rows.
            distinct: ["applicationId", "appName"],
        });
        if (records.length === 0) return [];

        // Collapse bundles that fold to one K8s Secret target: two of them writing
        // one Secret would just overwrite each other. Keep one and log the rest.
        const { chosen, collisions } = dedupeSecretRecordsByTarget(records, previewSecretName);
        for (const collision of collisions) {
            this.logger.fatal(
                "Multiple secret bundles resolve to one K8s Secret target; keeping one to avoid an ownership collision",
                {
                    namespace,
                    extra: {
                        target: collision.secretName,
                        keptAppName: collision.kept.appName,
                        droppedAppNames: collision.dropped.map((record) => record.appName),
                    },
                },
            );
        }
        return chosen;
    }
}
