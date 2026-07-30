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

### Migration status: writes are mirrored, reads are not

AWS Secrets Manager is still the authoritative store. The API's secret services write there first and then mirror the same values here through `SecretValueMirror`, which swallows its own failures on purpose: the authoritative write has already succeeded by then, so failing the request would break a working operation to protect a copy nothing reads yet. A `NoPrimaryEncryptionKeyError` means the environment has not run `mintSecretKey` and is skipped quietly.

Both of those allowances stop being correct the moment reads move to Postgres. At that point the mirror should lose its guard and be allowed to fail the request.

### Serving reads from here

`PREVIEWKIT_SECRETS_READ` selects the source: `aws` (the default) or `postgres`. Defaulting to AWS means deploying the Postgres read path changes nothing until an environment opts in, and reverting is a config change rather than a deploy.

Under `postgres`, a listing is served entirely from stored columns - no key is unwrapped and nothing is decrypted, since `fingerprint` and `maskedLength` are what a listing needs. `updatedAt` becomes the row's own rather than the current time the AWS path has to substitute. Reading a single value does decrypt, and resolves whichever key version sealed it.

**It falls back to AWS per bundle rather than answering wrongly.** Postgres holding nothing for a bundle means not backfilled, not "no secrets" - a bundle row implies at least one value, since a write requires one. Serving an empty listing there would show a user that their secrets had vanished. A missing single value matters even more: `resolveManagedSigningSecret` reads back an existing `AUTONOMA_SIGNING_SECRET` so every app in an application shares one, and a false miss makes it mint a fresh one, breaking signed SDK calls from previews already deployed.

Every fall back is logged at error level. They should be rare once the backfill has run and its refused and dangling sets are resolved; a steady stream means the flip was premature. That is the signal to watch, and it is why the fallback exists rather than a hard cutover.

### The same flag covers the deploy runner

Values are read in two places: the API (listing and revealing them) and the previewkit runner (`build_secrets:` build args, addon `auth_secret:` lookups). Both are behind `PREVIEWKIT_SECRETS_READ`, and both fall back per bundle, but the runner does not get the flag from its own config. The runner Job's env comes from a shared secret carrying production's values, while `DATABASE_URL` is injected per-Job from the launching API - so a beta deploy runs against beta's database. The flag asserts that _a specific database_ holds the secrets, which makes it meaningless apart from that `DATABASE_URL`: `PreviewkitJobLauncher` therefore injects `PREVIEWKIT_SECRETS_READ` and `PREVIEWKIT_SECRETS_CMK` from the API's own env alongside it. One flag per API environment moves that environment's API reads and its runners together, and nothing has to be edited in the shared secret.

The runner's fallback matters more than the API's, because it is not a display bug. A build arg that resolves to nothing produces an image that boots and then misbehaves, far from the cause - so `BuildSecretSource` fails the build for a `build_secrets:` key the answering store does not have, and names which store answered. What it will not do is treat an empty Postgres bundle as "no secrets".

Runtime secrets are a separate path: the K8s Secret every preview pod mounts is still populated by External Secrets from AWS (`AwsExternalSecretManager`), and moving that is its own step.

### Earning the read flip

Before any read is served from here, both `list()` methods shadow-read: they return the authoritative AWS response as before and additionally call `SecretValueMirror.audit`, which compares `SecretValues.fingerprints` against what AWS just gave them and warns on any difference. Serving a read from an incomplete mirror would show a user no secrets at all, and an un-backfilled bundle is indistinguishable from an empty one at the API surface - so the mirror has to prove itself first.

It costs one two-column query and no decryption, because the fingerprints are already computed for the response. Every bundle anyone looks at reports whether the mirror agrees, which is continuous verification rather than the single point-in-time check a backfill gives.

Differences are warnings, not errors: while AWS is authoritative, anything the backfill has not reached is expected to differ. What matters is the trend going quiet. When it does - and the backfill's refused and dangling sets are resolved - reads can move, at which point the guard on `SecretValueMirror` comes off and mirror failures should fail the request.

### Where the tables are going

The current shape is a bundle row (`previewkit_secret`, one per app, holding the AWS ARN) plus a value row per key. That bundle exists only to hold `awsSecretArn`: once reads move to Postgres and the ARN is dropped, all it contains is `(applicationId, appName)`, which the value rows can carry themselves.

So the end state is one table, and it can take the name that fits it:

```prisma
PreviewkitSecret { applicationId, appName, key, envelope, encryptionKeyId, fingerprint, maskedLength }
@@unique([applicationId, appName, key])
```

`PreviewkitSecret` then means one secret, which is what the word means everywhere else - in the API contract (`SecretItem`), in the UI, and in how people talk about them. It is deliberately _not_ done yet, because today `previewkit_secret` is one row per bundle and roughly a dozen call sites do `findUnique` on `(applicationId, appName)` to fetch the ARN. Changing the grain now would need a transitional table holding both shapes, told apart by `key IS NULL`.

Those call sites exist to find the ARN, so they disappear on their own when reads move. That makes the collapse close to free at that point: stop writing the bundle, repoint the foreign key, drop the table. Expand and contract, with no data fan-out, because the value rows already exist from dual-write.

Until then the value tables keep a suffixed name, and it is not worth renaming something scheduled for deletion.

### Migrating what is already in Secrets Manager

Dual-write only covers new writes, so everything already in AWS needs a backfill. A survey of the `previewkit/` prefix (2026-07-30) found 281 secrets against 219 distinct ARNs referenced by a row, which sets the shape of that job:

|                                             |                                   |
| ------------------------------------------- | --------------------------------- |
| Referenced by a row and present in AWS      | 216 - the backfill's actual scope |
| Referenced by a row but **absent** from AWS | 3                                 |
| Present in AWS with **no row**              | 65                                |
| One ARN shared by **two** rows              | 5                                 |

Four things follow, and the first is the one most likely to be got wrong:

**Enumerate from `awsSecretArn`, never by rebuilding the name.** Seven bundles predate the current `previewkit/<org>/<application>/<app>` scheme and sit at two segments; `buildSecretName` cannot produce those, so a name-driven sweep silently skips them. It never has to: `upsert` merges into `existing.awsSecretArn` rather than recomputing, so a row's ARN is authoritative and legacy names never migrate. Reads already work this way.

**Report the 3 dangling ARNs rather than skipping them.** `fetchSecretValue` returns `{}` on `ResourceNotFoundException`, so a naive backfill writes zero values for these and looks successful. They are bundles whose AWS secret is gone and which have not been edited since (the self-healing `upsert` would have recreated it).

**The 5 shared ARNs need a human decision before running.** Two bundles on one AWS secret means the backfill writes identical values into both, and they diverge silently once AWS is dropped. This is the only case where the backfill can write _wrong_ data rather than incomplete data, so it should refuse them and list them.

**Verification is per-bundle, not a global count.** The fleet creates secrets continuously - the survey saw 280 become 281 within minutes - so any snapshot-then-compare shows drift that is not a fault. Compare `fingerprint` per (bundle, key) over a fixed input set, which is what that column exists for, and ignore rows that appeared after the snapshot.

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
