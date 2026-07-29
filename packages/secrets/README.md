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
- **CMK rotation is not key rotation.** Rotating the CMK only changes the wrapping of existing keys. Rotating the key that actually seals values is `mintSecretKey`.
- **The wrapped keys sit in the same database as the ciphertext.** That is a deliberate trade: it removes the key from configuration entirely and makes rotation rollout-free, at the cost of one layer of defence in depth. An attacker needs the database _and_ KMS, where a configuration-held key would have meant the database _and_ the environment _and_ KMS.
