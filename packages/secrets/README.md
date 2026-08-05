# @autonoma/secrets

Key management for previewkit secret values stored in Postgres. The cipher itself lives in `@autonoma/utils` (`SecretCipher`) and is deliberately dependency-free; this package owns where key material comes from.

## The model

One encryption key is shared by every secret value - not one per bundle. Keys live in `previewkit_encryption_key`, holding only the material **wrapped by the previewkit secrets CMK**, so the rows are inert without `kms:Decrypt`. The plaintext key exists only in memory, only in a process that needs it, and never in configuration: there is no key environment variable to leak, rotate by hand, or get out of sync between the API and the runner.

Each stored envelope names the key that sealed it, so old values keep resolving to their own key while new writes use the current primary.

## `SecretValues`

Writes secret values into `previewkit_secret`, sealed with the current encryption key. One row is one secret: an env-var name and its envelope, keyed `(applicationId, appName, key)`. A **bundle** is not a row - it is the set of rows sharing a scope, so a bundle exists exactly as long as it holds a key and "registered but empty" is not representable.

```ts
const values = new SecretValues(db, keys);

await values.put({ kind: "app", applicationId, appName }, [{ key: "DATABASE_URL", value }]);
await values.remove({ kind: "app", applicationId, appName }, "DATABASE_URL");
```

`put` merges: keys it was not given are left alone, matching the authoritative store, so writing one key never drops the rest. Values are bound to their own row through the scope derived by `scopeIn(bundle, key)`, so a ciphertext copied into another application, another bundle, or another key fails to decrypt rather than leaking.

### `updatedAt` means "last changed", and callers rely on it

**`put` skips a key already sealed with the same value under the current primary key.** That is not an optimization - it is what makes a row's `updatedAt` the time its value last *changed* rather than the time it was last *written*. Two readers depend on that and neither is local to this package:

- `SecretValues.list` surfaces it per key, in the secrets UI and the previewkit OpenAPI, as when that secret last changed.
- Onboarding's `isManagedDeployStaleVsSecrets` compares it against a preview's `deployedAt` to decide whether the running pod is holding stale secrets, and redeploys the preview when it is.

The second one is unforgiving. `prepareManagedTarget` re-asserts a preview's `AUTONOMA_SHARED_SECRET` immediately before asking that question, so while `put` wrote unconditionally the check answered "yes" to its own write and redeployed the preview on every call - and never converged, since each redeploy moved `deployedAt` forward only for the next write to move past it again.

**If you make `put` write unconditionally again, you reintroduce that.** A re-assert of an unchanged value must not touch the row. Rotation is unaffected and needs no exception: re-keying moves `encryptionKeyId`, which is part of the comparison, so [step 2 of a rotation](#rotating) rewrites every row as it should.

The one case the skip costs something is repair. Fingerprint equality says the same bytes went in, not that the stored envelope still opens, so a row with a right fingerprint and an unusable envelope (sealed under a wrong scope, a truncated ciphertext) is no longer fixed by re-asserting the value. Pass `force` for that - `secret-value.ts --set --force` is the hand-run path, and it tells you when a plain `--set` wrote nothing.

`put` returns `{ created, changed, written }`, all decided by the one read it already does to choose what to write. `changed` is "a value moved", which is not the same as `written` being non-empty: a rotation rewrites without any value changing.

Each row also carries `fingerprint` and `maskedLength`, computed at seal time. That is what lets a bundle be listed without unwrapping a key or decrypting anything: listing needs key names and an "is this the value I already hold?" check, never the values.

The `encryptionKeyId` foreign key is `RESTRICT`, not `CASCADE`. Deleting an encryption key that any value still needs is refused by Postgres, which turns "retired rows are never deleted" from a convention in this README into something the database enforces.

Persistence lives here rather than in the API services because those build their AWS client internally and cannot run without an AWS account; keeping it here makes it coverable against a real Postgres.

### Postgres is the store

The API writes and reads secret values here and nowhere else. There is no mirror, no dual-write, and no AWS fallback on this side: `PreviewkitSecretsService` holds a `SecretValues` and nothing else.

**`awsSecretArn` is gone**, and with it the bundle row it was the last reason to keep - see [One table per scope](#one-table-per-scope).

**What went away with the AWS write, and why it could.** The service used to carry an ownership-tag system and a self-heal path: adopt an existing secret, refuse a foreign one, recreate when AWS had lost it, restore one scheduled for deletion, and sanitize punctuation AWS rejects in tag values. Every one of those was a consequence of Secrets Manager _names_ being a single flat space shared by every tenant, reached through lossy sanitization of user-controlled segments - so two applications could collide on one name and tags were the only proof of who owned it. A bundle is now identified by a foreign key into the Application that owns it, which no transform can alias, so none of those states are reachable and all of that code is gone.

The same reasoning retired the save-time preflight (`assertSecretPathsAvailable`): it existed to catch a name collision before a deploy hit it, and there is no shared name space left to collide in.

**An environment with no CMK refuses rather than answering emptily.** Dev and self-host have no key to unwrap, and returning `[]` there would read as "you have no secrets" when the truth is "cannot tell".

### Serving reads from here

Under `postgres` a listing is served entirely from stored columns - no key is unwrapped and nothing is decrypted, since `fingerprint` and `maskedLength` are what a listing needs. `updatedAt` is the row's own. Reading a single value does decrypt, and resolves whichever key version sealed it.

`PREVIEWKIT_SECRETS_READ` is gone everywhere - nothing has a second store to choose between.

### The same flag covers the deploy runner

Values are read in two places on the runner side: `build_secrets:` build args (`BuildSecretSource`), and the runtime K8s Secret a preview's pods mount (`RuntimeSecrets`).

**Neither falls back.** Both read Postgres and nothing else, so a registered bundle that cannot be served fails the deploy. That is the safe direction: a build that succeeds against no credentials produces an image that boots and then misbehaves, or ships, and an app rolled out against an unpopulated Secret comes up "ready" and 401s every signed call. `awsSecretArn` is now read by nothing.

The runner does not take its CMK from its own config either. Its Job env comes from a shared secret carrying production's values, while `DATABASE_URL` is injected per-Job from the launching API - so a beta deploy runs against beta's database. The encryption key the CMK unwraps lives in *that* database, which makes the CMK meaningless apart from that `DATABASE_URL`: `PreviewkitJobLauncher` injects `PREVIEWKIT_SECRETS_CMK` from the API's own env alongside it.

A build arg that resolves to nothing produces an image that boots and then misbehaves, far from the cause - so `BuildSecretSource` fails the build for any `build_secrets:` key the bundle does not have, and fails outright for a bundle it cannot open at all, rather than handing the build an empty map. `RuntimeSecrets` fails the deploy on the same principle: an app whose Secret was never written would roll out "ready" against missing credentials.

### The runtime K8s Secret

The K8s Secret every preview pod mounts via `envFrom` is the one whose values the running app authenticates with. The runner writes it directly (`PostgresSecretMaterializer`); no ExternalSecret is created for anything.

Writing it directly removes the step that could hang. The ESO path had to force a reconcile and then poll until the controller reported one that postdated the request, because `envFrom` is captured at pod start - a pod that rolls out against an unpopulated Secret comes up "ready" with a missing `AUTONOMA_SHARED_SECRET` and 401s every signed SDK call until someone redeploys by hand. A direct write is its own confirmation, and a target that cannot be written fails the deploy rather than rolling out.

**Ownership is the part that outlived the ESO path.** An ESO-managed Secret is *owned* by its ExternalSecret, and a namespace deployed before the cutover still has one, still reconciling from a Secrets Manager copy nobody writes. So `ExternalSecretRelease` deletes it with `Orphan` propagation before the first write: the default cascade would have the garbage collector delete the Secret it owns and take a live preview's credentials with it. The write then clears `ownerReferences` explicitly rather than waiting for the collector to strip them, so the handoff does not depend on GC timing.

Each namespace releases its own on its next deploy. `deployment/previewkit/cluster/release-external-secrets.sh` sweeps the rest - mainly the long-lived `-pr-0` main-branch environments, which may not redeploy for weeks and would otherwise keep serving frozen values. Dry-run by default, and it needs kubectl on the *preview* cluster; pointed at production it finds nothing and means nothing.

**This direction is one-way.** There used to be a `reclaimTargets` that deleted the Postgres-written Secret so ESO could own a fresh one, because ESO refuses to adopt a target it does not own. With no ESO path left to hand back to, that is gone: returning a preview to External Secrets now means restoring the materializer, not flipping a flag.

### Reading a preview's env by repo

`PreviewSecrets` is what the diffs classifier introspects a preview with (`get_preview_env` lists the names, `run_script` runs against the live backend with the same credentials).

**It resolves rows, it does not rebuild a name.** The two copies it replaces built `previewkit/<repo>/web` and read that AWS secret directly - a guess that missed the bundles predating the three-segment scheme and any Application whose app is not called `web`, both surfacing as `ResourceNotFoundException` at the classifier. When an Application holds several bundles it prefers `web`; a sole bundle wins whatever it is named.

**The caller names the Application, so the tenant is never inferred.** The obvious signature is by repo full name, since that is what the classifiers pass around - but a repo name does not identify a tenant. Two organizations onboarding the same GitHub repo is representable, so resolving through it would have to pick among the environments sharing that name, and picking wrong means handing back another organization's live credentials. `PreviewTarget` carries the `applicationId` the caller already holds.

**Listing names decrypts nothing.** `getEnvVarNames` exists so a classifier can see which keys a preview configures _without_ their values, so it reads the stored key columns and never unwraps a key.

**A read it cannot serve throws, rather than answering emptily.** This was the last AWS fallback anywhere in previewkit, and removing it is a safety fix as much as a cleanup: the AWS copies froze the moment the API stopped writing them, so by the end the fallback's only remaining job was to serve *stale* credentials to a harness that reports its 401s as product bugs.

Both callers turn a plausible-but-wrong answer into a stated finding, so each miss has a deliberate shape:

| situation | `getEnvVarNames` | `getEnvValues` |
| --- | --- | --- |
| bundle holds keys | the names | the values |
| application stores no secrets | `[]` - truthful, and the caller unions in the config's wired connection keys before treating an absence as evidence | throws; a script handed no credentials runs unauthenticated |
| no CMK in this environment | throws | throws |

The `[]` is only safe because Postgres is the only store: there is no un-migrated state left for an empty answer to be confused with. Both workers need `kms:Decrypt` on the CMK (`WorkerDiffsRole`, `InvestigationWorkerSecretsRole`); neither needs `secretsmanager:GetSecretValue` any more.

### One table per scope

There used to be a bundle row (`previewkit_secret`, one per app) plus a value row per key. The bundle existed only to hold `awsSecretArn` and to answer "is this registered"; once the ARN was dropped, all it held was `(applicationId, appName)` - which the value rows carry themselves. The value tables were folded into their parents and took the parents' names:

```prisma
PreviewkitSecret { applicationId, appName, key, envelope, encryptionKeyId, fingerprint, maskedLength }
@@unique([applicationId, appName, key])
```

`PreviewkitSecret` now means one secret, which is what the word means everywhere else - in the API contract (`SecretItem`), in the UI, and in how people talk about them.

Two consequences worth knowing:

**A bundle with no keys does not exist.** Delete an app's last secret and the app leaves `listApps`, so the secrets UI stops offering an empty bundle to open. Previously the registration row lingered and the reads had to special-case it.

**`created` on an upsert is no longer arbitrated by a unique constraint.** It means "the bundle held no keys before this write", read in the same call that computes `changed`, so two writes racing a brand-new bundle can both report it. Onboarding redeploys on `created`, and the duplicate redeploy is superseded by the newer one - cheaper than serializing every secret write to make the flag exact.

Code that wants the bundles rather than the rows asks for `distinct: ["appName"]`. That is the one place the collapse costs something: presence checks that were `findUnique` on a bundle are now scans of an index prefix.

### What the backfill left behind

Dual-write only covered writes made while it was on, so everything untouched since then lived only in AWS. A backfill closed that gap and doubled as the verifier, comparing `fingerprint` per (bundle, key) so that a converged run reported nothing to do. **Production converged on 2026-07-31 at 223 bundles / 2185 values, and the script is gone** - it read `awsSecretArn`, which no longer exists, and copying from a store nothing reads has no meaning.

Four things it got right are worth keeping, because the next migration of this shape will face them again:

**Enumerate from the stored reference, never by rebuilding a name.** Some bundles predated the `previewkit/<org>/<application>/<app>` scheme and sat at two segments, so a name-driven sweep would have silently skipped them. It never had to: writes merged into the ARN already on the row, so the row was authoritative and legacy names never migrated.

**Report dangling references rather than skipping them.** A read that returns `{}` on `ResourceNotFoundException` writes zero values for those and looks successful.

**Refuse a reference shared by two bundles.** Writing it into both makes them diverge the moment the shared source goes - the only case where the backfill could write *wrong* data rather than incomplete data, so it listed them for a human. Five needed resolving by hand, plus two dangling.

**Verify per bundle, not by a global count.** The fleet creates secrets continuously, so a snapshot-then-compare shows drift that is not a fault.

The AWS secrets themselves still exist. Dropping the reference did not delete them, so they remain a manual recovery path until they are deleted outright - along with the 65 orphans that no row ever referenced.

## `SecretKeys`

Resolves the cipher for an operation, unwrapping keys on demand.

```ts
import { KMSClient } from "@aws-sdk/client-kms";
import { KmsKeyProvider, SecretKeys } from "@autonoma/secrets";

const keys = new SecretKeys(db, new KmsKeyProvider(new KMSClient({ region }), env.PREVIEWKIT_SECRETS_CMK));

const sealed = (await keys.primary()).encrypt(value, scope); // writing
const opened = (await keys.forEnvelope(sealed)).decrypt(sealed, scope); // reading
```

Unwrapping happens at the point of use rather than at startup, which buys three things: a deploy with no configured secrets never calls KMS at all, revoking a process's IAM takes effect on its next resolve instead of whenever the pod happens to restart, and each unwrap lands in CloudTrail next to the work that needed it. Material is cached per key id for the life of the instance, so the previewkit runner - a one-shot Job - unwraps once per deploy.

`primary()` re-reads which key is primary on every call instead of caching it. That single indexed query is what lets a rotation take effect without a rollout.

Every wrap and unwrap is bound to its key id as KMS encryption context (`{ purpose: "previewkit-secrets", keyId }`). That is additional authenticated data, so a wrapped key cannot be passed off as another's, and KMS records the context in CloudTrail - an entry names which key was loaded rather than just showing that a `Decrypt` happened.

## `mintSecretKey`

Creates an encryption key and promotes it to primary. An operator action, never on a request path, so a misconfigured process can never silently mint itself a key and start writing values nothing else can read.

```ts
await mintSecretKey({ db, provider, keyId: "1" });
```

Only the wrapped key is stored. Key ids are permanent (every envelope names one) and must match `[A-Za-z0-9_-]+`, since they are a field in the envelope.

### Rotating

1. `mintSecretKey({ db, provider, keyId: "2" })`. New writes immediately use key 2; existing values keep resolving to 1.
2. Re-encrypt at leisure: read each value through `forEnvelope`, write it back through `primary()`.
3. Leave key 1's row in place. That is the whole of step 3.

No coordinated rollout, no ordering hazard, no window where one process can write something another cannot read - every process resolves keys through the same table.

**Retired rows are never deleted.** The row is what reserves its key id, and a key id has to stay unambiguous forever because every envelope names one; keeping the row is what makes `mintSecretKey` reject a reused id. A retired wrapped key is inert without `kms:Decrypt` and nothing is encrypted under it any more, so it costs a row and buys an invariant. If a straggler value does turn up later, it still opens.

Deleting a row anyway (hand surgery, not the runbook) makes any value still sealed under it unreadable, and the error names the missing key id. `SecretKeys` will not serve stale material if that id is then re-minted, but the values sealed under the replaced key are gone.

## Reading or writing one value by hand

`src/scripts/secret-value.ts` decrypts or encrypts a single stored row directly against Postgres - the same `SecretValues` path the API uses, run by hand for an operator who needs to inspect or fix one value without going through the dashboard:

```bash
pnpm --filter @autonoma/secrets secret-value -- --application-id <id> --app-name web --key DATABASE_URL --get
pnpm --filter @autonoma/secrets secret-value -- --application-id <id> --app-name web --key DATABASE_URL --set "postgres://..."
```

`--get` prints the decrypted value to stdout; `--set <value>` seals it under the current primary key and writes it, same as any other write. Needs `PREVIEWKIT_SECRETS_CMK` and `DATABASE_URL` for the environment you mean to touch - it does not import a shared `env.ts`, for the same reason `mint-key.ts` (`apps/previewkit/src/scripts`) doesn't.

`--set` with the value the row already holds writes nothing and says so, since [an unchanged re-assert must not move `updatedAt`](#updatedat-means-last-changed-and-callers-rely-on-it). Add `--force` to re-seal it anyway, which is how you repair a row whose envelope no longer opens - the one failure a matching fingerprint cannot rule out.

## `KeyProvider`

The two operations `SecretKeys` and `mintSecretKey` need from a key-management service. `KmsKeyProvider` is the AWS implementation; the seam exists so tests can supply a fake without an AWS client, and so a non-AWS host has somewhere to plug in.

## Local development and tests

Neither needs an AWS account. There are two layers, because they answer different questions:

- **`SecretKeys` and `mintSecretKey`** run against a real Postgres (Testcontainers) with `FakeKeyProvider`. These cover our own logic - key resolution, caching, promotion, rotation - and stay fast. The database is never faked.
- **`KmsKeyProvider`** runs against [MiniStack](https://github.com/ministackorg/ministack) (MIT-licensed AWS emulator), pinned to a version in `test/kms-harness.ts`. This is the only way to cover the real AWS SDK wiring: alias resolution, `AES_256` yielding the 32 bytes `SecretCipher` requires, and error shapes.

MiniStack was chosen after verifying the property this design actually depends on: it **enforces** encryption context rather than accepting and ignoring it, so unwrapping a key under a different key id fails exactly as real KMS would. An emulator that ignored the context would have made these tests pass while leaving the guarantee unverified, which is worse than not testing it. If MiniStack is ever swapped or upgraded, re-check that case first.

For local development, point a `KMSClient` at MiniStack and mint a key as usual:

```bash
docker run -p 4566:4566 ministackorg/ministack
```

This is deliberately preferred over a dev-only `KeyProvider` that skips wrapping: there is then no code path that could weaken key handling if it ever ran outside development.

## Operational requirements

- **The key.** `alias/previewkit-secrets` in us-east-1 (`e2cf2d81-f315-439e-ac43-a83ec11d31f5`), automatic rotation on. That alias is what `PREVIEWKIT_SECRETS_CMK` is set to. There is no IaC for AWS in this repo, so the key policy is maintained by hand.
- **IAM.** Reading needs `kms:Decrypt`, minting also `kms:GenerateDataKey`; both are in the key policy for `PreviewkitServiceRole` and `user/agent-api`. The runner gets its role through IRSA (see `deployment/apps/previewkit.yaml`). The API does **not** have a role: its `default` ServiceAccount carries no IRSA annotation and no Pod Identity association, and the node role it would fall back to has no Secrets Manager access at all - it authenticates as the `agent-api` IAM **user**, on long-lived access keys. Giving the API a Pod Identity association instead is the outstanding piece of work here, and it should land before Postgres becomes the authoritative store: today the key that protects every previewkit secret is reachable by static credentials sitting in a Kubernetes secret.
- **One CMK, `alias/previewkit-secrets`, shared by every environment.** `KmsKeyProvider` names it only to mint, because a symmetric KMS ciphertext identifies its own key.
- **Environments are isolated by their databases, not by IAM.** Each environment has its own database, so it only ever sees its own encryption keys, and a runner takes its `DATABASE_URL` from the API that launched it. IAM deliberately does _not_ provide this: `PreviewkitServiceRole` is one role shared by production, beta and alpha, and the API authenticates as the single `agent-api` IAM user, so any principal that can unwrap one environment's key can unwrap another's. Per-environment CMKs would look like isolation without adding any, so there is one key until those principals are split - at which point moving to per-environment CMKs is just a rotation per environment, which the key-versioning model already supports.
- **The key policy is scoped to our encryption context.** `PreviewkitServiceRole` and `user/agent-api` get `kms:GenerateDataKey` and `kms:Decrypt` only under `kms:EncryptionContext:purpose = previewkit-secrets`, so leaked credentials cannot use the key for anything else.
- **The CMK is a single point of total data loss.** Disable or delete it and every stored secret becomes permanently unreadable. Enable automatic rotation, never schedule deletion, and alarm on `DisableKey` / `ScheduleKeyDeletion`. Use a multi-region key if the DR plan involves another region - KMS ciphertext is bound to the key that produced it.
- **65 orphaned AWS secrets to delete at decommission.** Secrets whose `previewkit_secret` row was cascade-deleted with its Application, leaving the AWS secret alive with its values intact - the survey above measured 23% of the prefix in that state. They were never migrated - nothing in Postgres referenced them - so they are scheduled for deletion at decommission. Treat it as data retention rather than tidiness: some belong to organizations that were deleted, and their secrets are still readable. The causes are visible in the names: deleted applications, a rename leaving both behind (`some-app-v2` orphaned next to a still-tracked `some-app`), and case-variant duplicates (`SomeApp` and `someapp`). Examples are illustrative - this file syncs to the public mirror, so real application slugs do not belong in it.
- **CMK rotation is not key rotation.** Rotating the CMK only changes the wrapping of existing keys. Rotating the key that actually seals values is `mintSecretKey`.
- **The wrapped keys sit in the same database as the ciphertext.** That is a deliberate trade: it removes the key from configuration entirely and makes rotation rollout-free, at the cost of one layer of defence in depth. An attacker needs the database _and_ KMS, where a configuration-held key would have meant the database _and_ the environment _and_ KMS.
