import { NotFoundError } from "@autonoma/errors";
import { type Logger, logger as rootLogger } from "@autonoma/logger";
import { type PreviewConfig, type PreviewRedeployAppMode, SecretItemSchema, SecretKeySchema } from "@autonoma/types";
import type { PreviewkitConfigService } from "../routes/onboarding/previewkit-config-service";
import type { PreviewkitSecretsService } from "./previewkit-secrets.service";
import type { PreviewkitTriggerService } from "./previewkit-trigger.service";
import { secretFingerprint } from "./secret-fingerprint";

/** The config read/write capability this service needs; narrowed so tests can inject a fake. */
type ConfigStore = Pick<PreviewkitConfigService, "getConfig" | "save">;
/** The secret write capability this service needs; narrowed so tests can inject a fake. */
type SecretWriter = Pick<PreviewkitSecretsService, "upsert" | "delete">;
/** The redeploy capability this service needs; narrowed so tests can inject a fake. */
type Redeployer = Pick<PreviewkitTriggerService, "redeployApp" | "redeploy">;

/** A structural change to one app of a preview config. Only provided fields are applied. */
export interface AppConfigPatch {
    path?: string;
    dockerfile?: string;
    port?: number;
    healthCheck?: string;
    /** Env-var keys injected at build time (Docker build args). Replaces the app's `build_secrets` list. */
    buildSecrets?: string[];
    /** Topology-wired env (non-secret template values). Replaces the app's `connections` list. */
    connections?: Array<{ key: string; value: string; buildTime?: boolean }>;
}

export interface SetSecretResult {
    appName: string;
    key: string;
    /** True when the key was removed (no `value` given); false when it was set. */
    removed: boolean;
    /**
     * Non-reversible fingerprint (first 12 hex of SHA-256) of the value just set, so
     * the caller can confirm it matches what they intended. Absent when removing.
     */
    fingerprint?: string;
    /** What was triggered to apply the change: "rebuild" (declared build secret) or "restart" (runtime). */
    action: PreviewRedeployAppMode;
}

export interface EditConfigResult {
    saved: true;
    /** False when apply:false - the config was saved but not deployed. */
    applied: boolean;
    /** The rebuild that was (or would be) triggered to apply the edit. */
    action: PreviewRedeployAppMode;
    /** The app's resulting config (no secret values - `connections` hold templates, `build_secrets` hold keys). */
    app: PreviewConfig["apps"][number];
    note?: string;
}

export interface ReadConfigResult {
    /** The full active preview config document (no secret values). */
    document: PreviewConfig;
    /** False when the app has no saved config yet - `document` is then a starter. */
    configExists: boolean;
}

export interface ApplyConfigResult {
    saved: true;
    /** False when apply:false - saved but not redeployed. */
    applied: boolean;
    /** App names in the saved document, to confirm the resulting shape. */
    apps: string[];
    /** Service names (databases, caches, side-containers) in the saved document. */
    services: string[];
    note?: string;
}

/**
 * The MCP write path for a client's coding agent: setting a secret VALUE and
 * editing the STRUCTURAL preview config, each auto-applying the minimal action
 * needed. The two are deliberately separate concerns so the agent never has to
 * reason about overlap - a secret value (API key / token / password) goes through
 * {@link setSecret} (stored in AWS, never returned); how the app is built or wired
 * (path, Dockerfile, port, health check, which keys are injected at build,
 * topology connections) goes through {@link editConfig} (saves the app's config).
 *
 * setSecret picks rebuild-vs-restart by whether the key is a declared build secret;
 * editConfig rebuilds the edited app after saving the config. A redeploy always
 * resolves the app's current saved config, so saving then rebuilding is all that
 * is needed for the edit to take effect.
 */
export class PreviewkitWriteService {
    private readonly logger: Logger;

    constructor(
        private readonly config: ConfigStore,
        private readonly secrets: SecretWriter,
        private readonly trigger: Redeployer,
    ) {
        this.logger = rootLogger.child({ name: this.constructor.name });
    }

    /**
     * Sets (or, when `value` is undefined, removes) one secret env var for one app
     * and applies it: a rebuild when the key is a declared build secret (the value
     * is baked in as a build arg), otherwise a restart (the runtime secret bridge
     * re-syncs and the pods re-roll). Never returns or logs the value.
     */
    async setSecret(params: {
        applicationId: string;
        repoFullName: string;
        prNumber: number;
        appName: string;
        key: string;
        value?: string;
        organizationId: string;
    }): Promise<SetSecretResult> {
        const { applicationId, repoFullName, prNumber, appName, key, value, organizationId } = params;
        const removing = value == null;
        this.logger.info("Setting preview secret", { applicationId, extra: { appName, key, removing } });

        let fingerprint: string | undefined;
        if (removing) {
            SecretKeySchema.parse(key);
            const existed = await this.secrets.delete(applicationId, appName, key, organizationId);
            if (!existed) throw new NotFoundError(`Secret "${key}" is not set for app "${appName}"`);
        } else {
            const item = SecretItemSchema.parse({ key, value });
            await this.secrets.upsert(applicationId, appName, [item], organizationId);
            fingerprint = secretFingerprint(item.value);
        }

        const action: PreviewRedeployAppMode = (await this.isDeclaredBuildSecret(
            applicationId,
            organizationId,
            appName,
            key,
        ))
            ? "rebuild"
            : "restart";
        await this.trigger.redeployApp(repoFullName, prNumber, appName, action, organizationId);

        this.logger.info("Preview secret applied", { applicationId, extra: { appName, key, removing, action } });
        return { appName, key, removed: removing, fingerprint, action };
    }

    /**
     * Applies a structural patch to one app of the active preview config, saves a
     * new revision, and (unless `apply` is false) rebuilds that app against it.
     * `apply: false` lets an agent stage several edits and roll them out with a
     * final applying call. Never touches secret values.
     */
    async editConfig(params: {
        applicationId: string;
        repoFullName: string;
        prNumber: number;
        appName: string;
        patch: AppConfigPatch;
        apply: boolean;
        organizationId: string;
    }): Promise<EditConfigResult> {
        const { applicationId, repoFullName, prNumber, appName, patch, apply, organizationId } = params;
        this.logger.info("Editing preview config", { applicationId, extra: { appName, apply } });

        const current = await this.config.getConfig(applicationId, organizationId);
        const currentApp = current.document.apps.find((app) => app.name === appName);
        if (currentApp == null) throw new NotFoundError(`App "${appName}" is not in the preview config`);

        const patchedApp = applyAppPatch(currentApp, patch);
        const nextDocument: PreviewConfig = {
            ...current.document,
            apps: current.document.apps.map((app) => (app.name === appName ? patchedApp : app)),
        };
        const dependencyDocuments = current.dependencyConfigs
            .filter((dependency) => dependency.document != null)
            .map((dependency) => ({ repo: dependency.repo, document: dependency.document }));

        await this.config.save(applicationId, organizationId, nextDocument, dependencyDocuments);

        if (!apply) {
            this.logger.info("Preview config saved without applying", { applicationId, extra: { appName } });
            return {
                saved: true,
                applied: false,
                action: "rebuild",
                app: patchedApp,
                note: "Saved but NOT deployed. Call edit_previewkit_config again with apply:true (or make your last edit apply) to roll the changes out.",
            };
        }

        await this.trigger.redeployApp(repoFullName, prNumber, appName, "rebuild", organizationId);
        this.logger.info("Preview config edit applied", { applicationId, extra: { appName } });
        return { saved: true, applied: true, action: "rebuild", app: patchedApp };
    }

    /** Reads the full active preview config document (no secret values) for read-edit-write of the whole shape. */
    async getConfig(applicationId: string, organizationId: string): Promise<ReadConfigResult> {
        this.logger.info("Reading preview config", { applicationId });
        const current = await this.config.getConfig(applicationId, organizationId);
        return { document: current.document, configExists: current.saved };
    }

    /**
     * Saves a FULL preview config document - the path for structural changes a
     * single-app patch can't express: adding or removing an app, a service (a
     * database, cache, or side-container), or an addon. Dependency (multirepo)
     * documents are preserved. Unless `apply` is false, redeploys the whole
     * environment against the new document, since a topology change touches more
     * than one service (so it rebuilds the environment, not a single app).
     */
    async applyConfig(params: {
        applicationId: string;
        repoFullName: string;
        prNumber: number;
        document: PreviewConfig;
        apply: boolean;
        organizationId: string;
    }): Promise<ApplyConfigResult> {
        const { applicationId, repoFullName, prNumber, document, apply, organizationId } = params;
        this.logger.info("Applying preview config document", {
            applicationId,
            extra: { apps: document.apps.length, services: document.services.length, apply },
        });

        const current = await this.config.getConfig(applicationId, organizationId);
        const dependencyDocuments = current.dependencyConfigs
            .filter((dependency) => dependency.document != null)
            .map((dependency) => ({ repo: dependency.repo, document: dependency.document }));

        await this.config.save(applicationId, organizationId, document, dependencyDocuments);

        const apps = document.apps.map((app) => app.name);
        const services = document.services.map((service) => service.name);

        if (!apply) {
            this.logger.info("Preview config document saved without applying", { applicationId });
            return {
                saved: true,
                applied: false,
                apps,
                services,
                note: "Saved but NOT deployed. Call apply_config again with apply:true to roll it out.",
            };
        }

        await this.trigger.redeploy(repoFullName, prNumber, organizationId);
        this.logger.info("Preview config document applied", { applicationId });
        return { saved: true, applied: true, apps, services };
    }

    /** Whether `key` is declared in the app's `build_secrets` of the active config (decides rebuild vs restart). */
    private async isDeclaredBuildSecret(
        applicationId: string,
        organizationId: string,
        appName: string,
        key: string,
    ): Promise<boolean> {
        const current = await this.config.getConfig(applicationId, organizationId);
        const app = current.document.apps.find((candidate) => candidate.name === appName);
        return app?.build_secrets.includes(key) ?? false;
    }
}

/** Applies only the provided fields of a patch onto a copy of an app's config. */
function applyAppPatch(app: PreviewConfig["apps"][number], patch: AppConfigPatch): PreviewConfig["apps"][number] {
    const next = { ...app };
    if (patch.path !== undefined) next.path = patch.path;
    if (patch.dockerfile !== undefined) next.dockerfile = patch.dockerfile;
    if (patch.port !== undefined) next.port = patch.port;
    if (patch.healthCheck !== undefined) next.health_check = patch.healthCheck;
    if (patch.buildSecrets !== undefined) next.build_secrets = patch.buildSecrets;
    if (patch.connections !== undefined) {
        next.connections = patch.connections.map((connection) => ({
            key: connection.key,
            value: connection.value,
            build_time: connection.buildTime ?? false,
        }));
    }
    return next;
}
