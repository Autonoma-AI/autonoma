import { type PrismaClient, writePreviewkitConfigTopology } from "@autonoma/db";
import { BadRequestError, NotFoundError } from "@autonoma/errors";
import { type Logger, logger as rootLogger } from "@autonoma/logger";
import { type SecretKeys, sealedSecretRow } from "@autonoma/secrets";
import {
    type ConfigIssue,
    type PreviewConfig,
    type PreviewkitOperation,
    previewkitConfigRowValues,
    validatePreviewConfigSemantics,
} from "@autonoma/types";
import { parseAuthoredConfigShapeOrThrow } from "../routes/onboarding/previewkit-config-helpers";

/** Renaming through this prefix cannot collide with a real app name, which must be a DNS label. */
const RENAME_STAGING_PREFIX = "__renaming__";

export interface ApplyOperationsResult {
    /** Apps the write removed. Empty unless a `replaceConfig` stopped naming one. */
    deletedApps: string[];
    /**
     * Issues the config still has after the write. Reported, not thrown: a config
     * can be saved mid-edit, and refusing everything invalid would lock an already
     * invalid config out of the edit that fixes it.
     */
    issues: ConfigIssue[];
}

interface AppRow {
    id: string;
    name: string;
}

/**
 * Applies an ordered list of preview-config edits in one transaction.
 *
 * Ordering is the contract: operations take effect in the order given, so a
 * `renameApp` followed by a `replaceConfig` renames the row first and the document
 * then matches it by its new name. Reverse them and the document sees an app it
 * does not recognize and deletes it.
 */
export class PreviewkitOperationsService {
    private readonly logger: Logger;

    constructor(
        private readonly db: PrismaClient,
        private readonly keys: SecretKeys | undefined,
    ) {
        this.logger = rootLogger.child({ name: this.constructor.name });
    }

    async apply(
        applicationId: string,
        organizationId: string,
        operations: readonly PreviewkitOperation[],
    ): Promise<ApplyOperationsResult> {
        this.logger.info("Applying preview config operations", {
            applicationId,
            extra: { count: operations.length, ops: operations.map((operation) => operation.op) },
        });

        const application = await this.db.application.findFirst({
            where: { id: applicationId, organizationId, disabled: false },
            select: { id: true },
        });
        if (application == null) throw new NotFoundError();

        const document = this.parseDocuments(operations);

        // Unwrapped HERE, before the transaction: unwrapping calls KMS, and a
        // network round trip inside a transaction holds row locks for as long as
        // the other end feels like taking. Sealing itself is AES over bytes we
        // already hold, so it can happen inside, against app ids that do not exist
        // until the write creates them.
        const cipher = await this.sealingCipher(operations);

        const result = await this.db.$transaction(async (tx) => {
            const config = await tx.previewkitConfig.upsert({
                where: { applicationId },
                create: { applicationId },
                update: {},
                select: { id: true },
            });

            const deletedApps: string[] = [];
            for (const operation of operations) {
                if (operation.op === "renameApp") {
                    await this.renameApp(tx, config.id, operation.appId, operation.name);
                    continue;
                }
                if (operation.op === "replaceConfig") {
                    const removed = await this.replaceConfig(tx, config.id, document);
                    deletedApps.push(...removed);
                    continue;
                }
                if (operation.op === "setSecret") {
                    if (cipher == null) throw new Error("Unreachable: a secret write without an unwrapped key.");
                    await this.setSecret(tx, config.id, operation, cipher);
                    continue;
                }
                await this.deleteSecret(tx, config.id, operation.app, operation.key);
            }
            return { deletedApps };
        });

        const issues = document == null ? [] : validatePreviewConfigSemantics(document);
        this.logger.info("Preview config operations applied", {
            applicationId,
            extra: { deletedApps: result.deletedApps.length, issues: issues.length },
        });
        return { deletedApps: result.deletedApps, issues };
    }

    /**
     * The app row behind a name, for callers that hold a name and need the id a
     * `renameApp` takes. Scoped to the application, so it cannot answer with another
     * tenant's app.
     */
    async findApp(applicationId: string, organizationId: string, name: string): Promise<{ id: string }> {
        const app = await this.db.previewkitApp.findFirst({
            where: { name, config: { application: { id: applicationId, organizationId, disabled: false } } },
            select: { id: true },
        });
        if (app == null) {
            throw new NotFoundError(`No app named "${name}" in this application's preview topology.`);
        }
        return app;
    }

    /**
     * Parses every `replaceConfig` up front so a malformed document fails before
     * anything is written, and refuses more than one: two documents in a list means
     * the second silently discards whatever the first said.
     */
    private parseDocuments(operations: readonly PreviewkitOperation[]): PreviewConfig | undefined {
        const documents = operations.filter((operation) => operation.op === "replaceConfig");
        if (documents.length > 1) {
            throw new BadRequestError(
                "An operation list may carry at most one replaceConfig: a second one would overwrite the first.",
            );
        }
        const only = documents[0];
        return only == null ? undefined : parseAuthoredConfigShapeOrThrow(only.document);
    }

    private async sealingCipher(operations: readonly PreviewkitOperation[]) {
        if (!operations.some((operation) => operation.op === "setSecret")) return undefined;
        if (this.keys == null) {
            throw new BadRequestError(
                "This environment has no previewkit secrets CMK, so a secret cannot be sealed. " +
                    "The rest of the config can still be edited.",
            );
        }
        return await this.keys.primary();
    }

    /**
     * Renames an app row in place, which is the whole reason this API exists: the
     * id does not move, so the secrets and build history hanging off it survive.
     *
     * Two apps swapping names is the case that needs care. The unique
     * `(configId, name)` is checked per statement, so renaming `a` to `b` while `b`
     * still holds the name fails - even though the end state is legal. Parking the
     * name being vacated makes any permutation work in three statements.
     */
    private async renameApp(
        tx: Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0],
        configId: string,
        appId: string,
        name: string,
    ): Promise<void> {
        const [app, occupant] = await Promise.all([
            tx.previewkitApp.findFirst({ where: { id: appId, configId }, select: { id: true } }),
            tx.previewkitApp.findFirst({ where: { configId, name, id: { not: appId } }, select: { id: true } }),
        ]);
        if (app == null) {
            throw new NotFoundError(
                `Cannot rename app ${appId}: it is not in this application's preview topology. ` +
                    "A deleted app is not recreated by renaming it - its secrets and history are already gone.",
            );
        }
        if (name === RENAME_STAGING_PREFIX) throw new BadRequestError(`"${name}" is not a usable app name.`);

        if (occupant != null) {
            await tx.previewkitApp.update({
                where: { id: occupant.id },
                data: { name: `${RENAME_STAGING_PREFIX}${occupant.id}` },
            });
        }
        await tx.previewkitApp.update({ where: { id: appId }, data: { name } });
    }

    /** Writes the document over the stored topology, reporting the apps it removed. */
    private async replaceConfig(
        tx: Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0],
        configId: string,
        document: PreviewConfig | undefined,
    ): Promise<string[]> {
        if (document == null) throw new Error("Unreachable: a replaceConfig operation with no parsed document.");

        const before = await tx.previewkitApp.findMany({ where: { configId }, select: { id: true, name: true } });
        await writePreviewkitConfigTopology(tx, configId, previewkitConfigRowValues(document));

        const kept = new Set(document.apps.map((app) => app.name));
        return before.filter((app: AppRow) => !kept.has(app.name)).map((app: AppRow) => app.name);
    }

    private async setSecret(
        tx: Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0],
        configId: string,
        operation: { app: string; key: string; value: string },
        cipher: Awaited<ReturnType<SecretKeys["primary"]>>,
    ): Promise<void> {
        const appId = await this.requireApp(tx, configId, operation.app);
        const row = sealedSecretRow(cipher, appId, operation.key, operation.value);
        await tx.previewkitSecret.upsert({
            where: { appId_key: { appId, key: operation.key } },
            create: { appId, key: operation.key, ...row },
            update: row,
        });
    }

    private async deleteSecret(
        tx: Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0],
        configId: string,
        app: string,
        key: string,
    ): Promise<void> {
        const appId = await this.requireApp(tx, configId, app);
        await tx.previewkitSecret.deleteMany({ where: { appId, key } });
    }

    /** Resolved inside the transaction, so it sees the names the earlier operations left. */
    private async requireApp(
        tx: Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0],
        configId: string,
        name: string,
    ): Promise<string> {
        const app = await tx.previewkitApp.findFirst({ where: { configId, name }, select: { id: true } });
        if (app == null) {
            throw new BadRequestError(
                `Cannot write a secret for app "${name}": it is not in the application's preview topology. ` +
                    "Order the operations so the app exists before its secrets.",
            );
        }
        return app.id;
    }
}
