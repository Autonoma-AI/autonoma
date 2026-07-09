import {
    AUTONOMA_MANAGED_ENV_VARS,
    PREVIEWKIT_BUILTIN_ENV_VARS,
    SecretKeySchema,
    connectionTargets,
    connectionTokens,
    isReservedPreviewkitEnvKey,
} from "@autonoma/types";
import {
    envRow,
    serviceRecipeSupportsUrlToken,
    sortEnvRows,
    type AppDraft,
    type EnvRowDraft,
    type ServiceDraft,
} from "../../../../onboarding/-components/previewkit/topology-draft";

/**
 * View + edit model for the app's unified variable list. Every variable is one
 * of two kinds:
 *   - a secret: a user-typed value stored in AWS Secrets Manager (write-only).
 *   - a connection: a template value that wires to the topology via
 *     `{{name.property}}` tokens (e.g. `mongodb://{{db.host}}:{{db.port}}/x`),
 *     resolved at deploy time. Never sensitive, never in AWS.
 * A variable can additionally be flagged build-time (mirrored into
 * `build_secrets` for a secret, `connections[].build_time` for a connection).
 */

/** Something a connection can reference: a managed service or another app, and the tokens it exposes. */
export interface BindTarget {
    name: string;
    /** Chip / meta label: the service recipe (`postgres`, `redis`, ...) or `app`. */
    kind: string;
    properties: string[];
}

export interface VariableView {
    row: EnvRowDraft;
    key: string;
    /** True for a connection (non-sensitive templated value). */
    isConnection: boolean;
    /**
     * For a connection: the app/service names its value references, parsed
     * straight from the `{{name.property}}` tokens (self-reference included).
     */
    references: string[];
    /** Referenced names that don't match any declared app/service - a typo or a deleted service. */
    unknownReferences: string[];
    /** Also exposed during the image build (build secret for secrets, build_time for connections). */
    buildTime: boolean;
    /** Persisted secret whose value AWS never returns - shown as `(set)`, replaceable only. */
    isStoredSecret: boolean;
}

export interface VariableForm {
    key: string;
    /** `secret` = user-typed value (AWS); `connection` = template wired to the topology. */
    source: "secret" | "connection";
    value: string;
    buildTime: boolean;
}

export interface InjectedVar {
    key: string;
    description: string;
    example: string;
    source: string;
}

/**
 * Everything a connection may reference: managed services, then every app's URL
 * (including the app being edited - an app referencing its own public URL, e.g.
 * `APP_URL={{web-app.url}}`, is valid).
 */
export function bindTargets(services: ServiceDraft[], apps: AppDraft[]): BindTarget[] {
    const serviceTargets = services
        .filter((service) => service.name.trim() !== "")
        .map((service) => ({
            name: service.name.trim(),
            kind: service.recipe,
            properties: serviceRecipeSupportsUrlToken(service.recipe) ? ["url", "host", "port"] : ["host", "port"],
        }));
    const appTargets = apps
        .filter((app) => app.name.trim() !== "")
        .map((app) => ({ name: app.name.trim(), kind: "app", properties: ["url"] }));
    return [...serviceTargets, ...appTargets];
}

export function variableViews(app: AppDraft, targets: BindTarget[]): VariableView[] {
    const known = new Set(targets.map((target) => target.name));
    return app.env.map((row) => {
        const references = row.sensitive ? [] : connectionTargets(row.value);
        return {
            row,
            key: row.key.trim(),
            isConnection: !row.sensitive,
            references,
            unknownReferences: references.filter((name) => !known.has(name)),
            buildTime: row.buildTime,
            isStoredSecret: row.origin === "secret" && row.value === "",
        };
    });
}

/** The read-only variables PreviewKit injects into every deployment of this app. */
export function injectedVars(primaryApp: boolean): InjectedVar[] {
    const builtin = PREVIEWKIT_BUILTIN_ENV_VARS.map((variable) => ({ ...variable, source: "Built-in" }));
    if (!primaryApp) return builtin;
    return [...builtin, ...AUTONOMA_MANAGED_ENV_VARS.map((variable) => ({ ...variable, source: "Autonoma" }))];
}

export function formFromView(view: VariableView | undefined): VariableForm {
    if (view == null) {
        return { key: "", source: "secret", value: "", buildTime: false };
    }
    return {
        key: view.key,
        source: view.isConnection ? "connection" : "secret",
        value: view.row.value,
        buildTime: view.buildTime,
    };
}

/**
 * First blocking problem with the drawer form, or undefined when it can be
 * applied. Mirrors the constraints the save path enforces (reserved keys, the
 * secret key charset, write-only secret values, per-app secret store) so the
 * drawer never green-lights an edit the config save would reject or lose.
 */
export function validateForm(
    form: VariableForm,
    app: AppDraft,
    view: VariableView | undefined,
    targets: BindTarget[],
    secretsSupported: boolean,
): string | undefined {
    const key = form.key.trim();
    if (key === "") return "Key is required.";
    if (!SecretKeySchema.safeParse(key).success) {
        return "Keys are letters, digits and underscores, and can't start with a digit.";
    }
    if (isReservedPreviewkitEnvKey(key)) return `${key} is injected by PreviewKit and reserved.`;
    const duplicate = app.env.some((row) => row.id !== view?.row.id && row.key.trim() === key);
    if (duplicate) return "A variable with this key already exists.";

    if (form.source === "connection") {
        if (form.value.trim() === "") return "Enter a value, e.g. {{db.url}} or mongodb://{{db.host}}:{{db.port}}/db.";
        const tokens = connectionTokens(form.value);
        if (tokens.length === 0) {
            return "A connection must reference a service or app with a {{name.property}} token.";
        }
        for (const token of tokens) {
            const target = targets.find((candidate) => candidate.name === token.target);
            if (target == null) return `"${token.target}" is not a service or app in this preview.`;
            if (!target.properties.includes(token.property)) {
                return `"${token.target}" has no "${token.property}" - it exposes: ${target.properties.join(", ")}.`;
            }
        }
        return undefined;
    }

    // Every typed value is a secret, and secrets live per primary-repo app.
    if (!secretsSupported) {
        return "Dependency-repo apps can't store secrets - use a connection to a service instead.";
    }
    // A stored secret stays masked (its value is write-only, so there is no
    // unmask path) - but renaming one needs the value typed again.
    if (view != null && view.isStoredSecret && key !== view.key && form.value.trim() === "") {
        return "Re-enter the value to rename this secret - the stored value can't be copied.";
    }
    return undefined;
}

export interface ApplyResult {
    patch: { env: EnvRowDraft[] };
    rowId: number;
}

/**
 * Applies the drawer form to the app draft: upserts the variable row. A secret
 * is a sensitive (AWS-stored) row; a connection is a non-sensitive templated
 * row. `buildTime` rides on the row and compiles to `build_secrets` (secret) or
 * `connections[].build_time` (connection).
 */
export function applyVariable(app: AppDraft, rowId: number | undefined, form: VariableForm): ApplyResult {
    const key = form.key.trim();
    const sensitive = form.source === "secret";
    const value = form.value;
    const existing = rowId != null ? app.env.find((row) => row.id === rowId) : undefined;

    if (existing == null) {
        const created = envRow(key, value, sensitive, "new", form.buildTime);
        return { patch: { env: sortEnvRows([...app.env, created]) }, rowId: created.id };
    }

    // A stored secret keeps its "secret" origin while it stays sensitive (a blank
    // value means "unchanged in AWS"); switching it to a connection makes it a
    // plaintext templated row, so its AWS secret is dropped on the next save.
    const origin = existing.origin === "secret" && !sensitive ? "config" : existing.origin;
    const env = app.env.map((row) =>
        row.id === existing.id ? { ...row, key, value, sensitive, buildTime: form.buildTime, origin } : row,
    );
    return { patch: { env }, rowId: existing.id };
}

/** Drops a variable. */
export function removeVariable(app: AppDraft, rowId: number): { env: EnvRowDraft[] } {
    return { env: app.env.filter((candidate) => candidate.id !== rowId) };
}
