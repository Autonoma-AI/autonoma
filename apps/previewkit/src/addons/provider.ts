/**
 * Plugin contract for third-party addons. Each provider lives behind this
 * interface — Neon for Postgres branches today, with PlanetScale / Upstash /
 * webhook escape hatches as natural follow-ups.
 *
 * Lifecycle:
 *   - On PR open / push, `AddonManager.provisionAll` calls `provision` once
 *     per addon declared in `.preview.yaml`. The returned `outputs` are
 *     surfaced into the template engine so apps can reference
 *     `{{addonName.<key>}}` in env and build_args; `state` is persisted
 *     opaquely on the `PreviewkitAddon` row and replayed verbatim to
 *     `deprovision` at teardown.
 *   - On PR close, `deprovision` cleans up the external resource. Providers
 *     should be idempotent on this path — the manager will not retry by
 *     itself, but operators may re-run teardown manually.
 *
 * Providers must never read `process.env`; everything they need (options,
 * authSecret, identity) arrives via the input object. Construction is plain
 * `new NeonProvider()` registered into `AddonProviderRegistry` at boot.
 */
export interface ProvisionInput {
    /** Provider-specific options forwarded verbatim from `.preview.yaml`. The
     *  provider validates them with its own zod schema. */
    options: Record<string, unknown>;

    /** JSON map fetched from the referenced PreviewkitOrgSecret. Each
     *  provider's options schema picks the keys it needs (NeonProvider
     *  expects `token`). Stored centrally per-organization so it can be
     *  rotated without touching individual repos. */
    authSecret: Record<string, string>;

    prNumber: number;
    /** The K8s namespace this PR's environment lives in. Useful for
     *  deriving deterministic resource names on the provider side. */
    namespace: string;
    organizationId: string;
}

export interface ProvisionResult {
    /** Public outputs surfaced as `{{addonName.<key>}}` in templates. Keys
     *  are provider-defined — document them in the provider's source. */
    outputs: Record<string, string>;

    /** Opaque blob persisted alongside the addon row; passed back to
     *  `deprovision` exactly as returned. The provider owns its shape. */
    state: Record<string, unknown>;
}

export interface DeprovisionInput {
    options: Record<string, unknown>;
    authSecret: Record<string, string>;
    state: Record<string, unknown>;
}

export interface AddonProvider {
    /** Identifier used in `.preview.yaml`'s `provider:` field. Must be
     *  unique within an `AddonProviderRegistry`. */
    readonly name: string;

    provision(input: ProvisionInput): Promise<ProvisionResult>;
    deprovision(input: DeprovisionInput): Promise<void>;
}
