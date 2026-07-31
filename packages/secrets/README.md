# @autonoma/secrets

Key management for previewkit secret values stored in Postgres. The cipher itself lives in `@autonoma/utils` (`SecretCipher`) and is deliberately dependency-free; this package owns where key material comes from.

## The model

One encryption key is shared by every secret value - not one per bundle. Keys live in `previewkit_encryption_key`, holding only the material **wrapped by the previewkit secrets CMK**, so the rows are inert without `kms:Decrypt`. The plaintext key exists only in memory, only in a process that needs it, and never in configuration: there is no key environment variable to leak, rotate by hand, or get out of sync between the API and the runner.

Each stored envelope names the key that sealed it, so old values keep resolving to their own key while new writes use the current primary.

## `SecretValues`

Writes secret values into `previewkit_secret_value` / `previewkit_org_secret_value`, sealed with the current encryption key.

```ts
const values = new SecretValues(db, keys);

await values.put({ kind: "app", applicationId, appName }, [{ key: "DATABASE_URL", value }]);
await values.remove({ kind: "app", applicationId, appName }, "DATABASE_URL");
```

`put` merges: keys it was not given are left alone, matching the authoritative store, so writing one key never drops the rest. Values are bound to their own row through the scope derived by `scopeIn(bundle, key)`, so a ciphertext copied into another application, another bundle, or another key fails to decrypt rather than leaking.

Each row also carries `fingerprint` and `maskedLength`, computed at seal time. That is what lets a bundle be listed without unwrapping a key or decrypting anything: listing needs key names and an "is this the value I already hold?" check, never the values.

The `encryptionKeyId` foreign key is `RESTRICT`, not `CASCADE`. Deleting an encryption key that any value still needs is refused by Postgres, which turns "retired rows are never deleted" from a convention in this README into something the database enforces.

Persistence lives here rather than in the API services because those build their AWS client internally and cannot run without an AWS account; keeping it here makes it coverable against a real Postgres.

### Postgres is the store

The API writes and reads secret values here and nowhere else. There is no mirror, no dual-write, and no AWS fallback on this side: `PreviewkitSecretsService` and `OrgSecretsService` hold a `SecretValues` and nothing else.

**A bundle registered from now on has no `awsSecretArn`.** No AWS secret is created for it, so the column is nullable and drops once the previewkit runner stops reading it as a per-bundle fallback. Rows that predate the cutover keep theirs.

**What went away with the AWS write, and why it could.** The service used to carry an ownership-tag system and a self-heal path: adopt an existing secret, refuse a foreign one, recreate when AWS had lost it, restore one scheduled for deletion, and sanitize punctuation AWS rejects in tag values. Every one of those was a consequence of Secrets Manager _names_ being a single flat space shared by every tenant, reached through lossy sanitization of user-controlled segments - so two applications could collide on one name and tags were the only proof of who owned it. A bundle is now identified by a foreign key into the Application that owns it, which no transform can alias, so none of those states are reachable and all of that code is gone.

The same reasoning retired the save-time preflight (`assertSecretPathsAvailable`): it existed to catch a name collision before a deploy hit it, and there is no shared name space left to collide in.

**An environment with no CMK refuses rather than answering emptily.** Dev and self-host have no key to unwrap, and returning `[]` there would read as "you have no secrets" when the truth is "cannot tell".

### Serving reads from here

Under `postgres` a listing is served entirely from stored columns - no key is unwrapped and nothing is decrypted, since `fingerprint` and `maskedLength` are what a listing needs. `updatedAt` is the row's own. Reading a single value does decrypt, and resolves whichever key version sealed it.

`PREVIEWKIT_SECRETS_READ` remains, because the previewkit runner still has AWS fallbacks of its own for bundles that predate the cutover. It no longer affects the API, which has no second store to choose between.

### The same flag covers the deploy runner

Values are read in two places on the runner side: `build_secrets:` build args and addon `auth_secret:` lookups (`BuildSecretSource`), and the runtime K8s Secret a preview's pods mount (`RuntimeSecrets`). Both fall back per bundle to AWS, and both are the remaining reason `awsSecretArn`, `CLUSTER_SECRET_STORE_NAME` and the ESO install still exist.

The runner does not read the flag from its own config. Its Job env comes from a shared secret carrying production's values, while `DATABASE_URL` is injected per-Job from the launching API - so a beta deploy runs against beta's database. The flag asserts that _a specific database_ holds the secrets, which makes it meaningless apart from that `DATABASE_URL`: `PreviewkitJobLauncher` injects `PREVIEWKIT_SECRETS_READ` and `PREVIEWKIT_SECRETS_CMK` from the API's own env alongside it.

A build arg that resolves to nothing produces an image that boots and then misbehaves, far from the cause - so `BuildSecretSource` fails the build for a `build_secrets:` key the answering store does not have, and names which store answered. For a bundle with no AWS secret at all it fails outright rather than handing the build an empty map. `AwsExternalSecretManager` likewise skips a bundle it cannot serve: stamping an `ExternalSecret` with nothing to extract would sit un-Ready and burn the pre-rollout sync wait instead of failing fast.

### The runtime K8s Secret

The K8s Secret every preview pod mounts via `envFrom` is the one whose values the running app authenticates with. Under `postgres` the runner writes it directly (`PostgresSecretMaterializer`) instead of stamping an ExternalSecret and waiting for External Secrets to sync it.

Writing it directly removes the step that could hang. The ESO path has to force a reconcile and then poll until the controller reports one that postdates the request, because `envFrom` is captured at pod start - a pod that rolls out against an unpopulated Secret comes up "ready" with a missing `AUTONOMA_SHARED_SECRET` and 401s every signed SDK call until someone redeploys by hand. A direct write is its own confirmation.

**Two writers on one Secret is the thing to get right.** An ESO-managed Secret is _owned_ by its ExternalSecret, so taking a target over means releasing that ownership first - otherwise ESO reconciles the Secret back from AWS and whichever writer went last wins. `releaseTargets` deletes the ExternalSecret with `Orphan` propagation, because the default cascade would have the garbage collector delete the Secret it owns and take a live preview's credentials with it. The write then clears `ownerReferences` explicitly rather than waiting for the collector to strip them, so the handoff does not depend on GC timing.

**It has to be reversible in both directions.** Flipping back to `aws` runs into the mirror image of the same rule: ESO will not adopt a Secret it does not own, so a Postgres-written one left in place keeps its ExternalSecret out of Ready until the deploy deadline. `reclaimTargets` deletes it first, so ESO creates and owns it fresh. That delete is safe because `envFrom` is read at pod start: running pods keep their env, and the ESO path already waits for the Secret to be repopulated before any rollout. It only ever touches a Secret carrying previewkit's own `app-secret` type label.

The fallback is per app, not per namespace: one un-backfilled app leaves that app on ESO and writes the others.

### Reading a preview's env by repo

`PreviewSecrets` is what the investigation and diffs classifiers introspect a preview with (`get_preview_env` lists the names, `run_script` runs against the live backend with the same credentials).

**It resolves rows, it does not rebuild a name.** The two copies it replaces built `previewkit/<repo>/web` and read that AWS secret directly - a guess that misses the bundles predating the three-segment scheme and any Application whose app is not called `web`, both surfacing as `ResourceNotFoundException` at the classifier. When an Application registers several apps it prefers `web`; a sole registration wins whatever it is named.

**The caller names the Application, so the tenant is never inferred.** The obvious signature is by repo full name, since that is what the classifiers pass around - but a repo name does not identify a tenant. Two organizations onboarding the same GitHub repo is representable, so resolving through it would have to pick among the environments sharing that name, and picking wrong means handing back another organization's live credentials. `PreviewTarget` carries the `applicationId` the caller already holds.

**Listing names decrypts nothing.** `getEnvVarNames` exists so a classifier can see which keys a preview configures _without_ their values, so it reads the stored key columns and never unwraps a key.

Both workers read their own `PREVIEWKIT_SECRETS_READ`. Their IRSA roles (`WorkerDiffsRole`, `InvestigationWorkerSecretsRole`) need `kms:Decrypt` on the CMK before `postgres` does anything there.

### Where the tables are going

The current shape is a bundle row (`previewkit_secret`, one per app) plus a value row per key. That bundle exists only to hold `awsSecretArn` and to answer "is this registered": once the ARN is dropped, all it contains is `(applicationId, appName)`, which the value rows can carry themselves.

So the end state is one table, and it can take the name that fits it:

```prisma
PreviewkitSecret { applicationId, appName, key, envelope, encryptionKeyId, fingerprint, maskedLength }
@@unique([applicationId, appName, key])
```

`PreviewkitSecret` then means one secret, which is what the word means everywhere else - in the API contract (`SecretItem`), in the UI, and in how people talk about them.

The API's ARN lookups are gone, which was most of what blocked this. What remains is the previewkit runner's two fallback readers and the `listApps` / registration checks, which want "does this bundle exist" rather than an ARN. Once the runner stops reading AWS, the collapse is close to free: stop writing the bundle, repoint the foreign key, drop the table. Expand and contract, with no data fan-out, because the value rows already exist.

Until then the value tables keep a suffixed name, and it is not worth renaming something scheduled for deletion.

### The backfill, and what it left

Dual-write only covered writes made while it was on, so everything untouched since then lived only in AWS. `pnpm --filter @autonoma/previewkit backfill-secrets` closed that gap and doubles as the verifier: it compares `fingerprint` per (bundle, key), so a converged run reports nothing to do. Production converged on 2026-07-31 at 223 bundles / 2185 values.

Four things it got right that a simpler sweep would not, and they still apply to any environment yet to run it:

**Enumerate from `awsSecretArn`, never by rebuilding the name.** Some bundles predate the current `previewkit/<org>/<application>/<app>` scheme and sit at two segments, so a name-driven sweep silently skips them. It never has to: `upsert` merged into the existing ARN rather than recomputing, so a row's ARN was authoritative and legacy names never migrated.

**Report dangling ARNs rather than skipping them.** A read that returns `{}` on `ResourceNotFoundException` writes zero values for these and looks successful.

**Refuse an ARN shared by two bundles.** Writing it into both makes them diverge once AWS is dropped - the only case where the backfill could write _wrong_ data rather than incomplete data, so it lists them for a human instead.

**Verify per bundle, not by a global count.** The fleet creates secrets continuously, so a snapshot-then-compare shows drift that is not a fault.

A bundle registered after the cutover has no ARN and nothing to compare; the script counts those separately rather than dropping them silently.

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
- **65 orphaned AWS secrets to delete at decommission.** Secrets whose `previewkit_secret` row was cascade-deleted with its Application, leaving the AWS secret alive with its values intact - the survey above measured 23% of the prefix in that state. They are not migrated (a value row needs a bundle row to attach to), so Phase 4 is where they get scheduled for deletion. Treat it as data retention rather than tidiness: some belong to organizations that were deleted, and their secrets are still readable. The causes are visible in the names: deleted applications, a rename leaving both behind (`some-app-v2` orphaned next to a still-tracked `some-app`), and case-variant duplicates (`SomeApp` and `someapp`). Examples are illustrative - this file syncs to the public mirror, so real application slugs do not belong in it.
- **CMK rotation is not key rotation.** Rotating the CMK only changes the wrapping of existing keys. Rotating the key that actually seals values is `mintSecretKey`.
- **The wrapped keys sit in the same database as the ciphertext.** That is a deliberate trade: it removes the key from configuration entirely and makes rotation rollout-free, at the cost of one layer of defence in depth. An attacker needs the database _and_ KMS, where a configuration-held key would have meant the database _and_ the environment _and_ KMS.
