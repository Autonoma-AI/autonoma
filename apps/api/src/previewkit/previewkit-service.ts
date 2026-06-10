import { db } from "@autonoma/db";
import { triggerPreviewDeploy, triggerPreviewTeardown } from "@autonoma/workflow";
import { env } from "../env";
import { buildGitHubApp } from "../github/github-app";
import { GitHubInstallationService } from "../github/github-installation.service";
import { PreviewkitClient } from "./previewkit-client";
import { PreviewkitTriggerService } from "./previewkit-trigger.service";

/**
 * Shared client for talking to the Previewkit service. Used by the public
 * `/v1/previewkit/*` proxy router, the GitHub webhook forwarder, and the admin
 * redeploy path so all autonoma-API -> Previewkit HTTP traffic goes through one
 * place. Both env vars are optional; when unset the client reports
 * `isConfigured() === false` and callers skip or 503 accordingly.
 */
export const previewkitClient = new PreviewkitClient(env.PREVIEWKIT_URL, env.PREVIEWKIT_SERVICE_SECRET);

/**
 * Native trigger path for the same lifecycle ops: starts the Temporal
 * workflows directly (used when `PREVIEWKIT_USE_TEMPORAL` is on). Mirrors the
 * diffs wiring in `../diffs/diffs-service.ts`.
 */
export const previewkitTriggerService = new PreviewkitTriggerService(
    db,
    new GitHubInstallationService(db, buildGitHubApp(env)),
    triggerPreviewDeploy,
    triggerPreviewTeardown,
);
