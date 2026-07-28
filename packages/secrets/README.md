# @autonoma/secrets

Key management for previewkit secret values stored in Postgres. The cipher itself lives in `@autonoma/utils` (`SecretCipher`) and is deliberately dependency-free; this package owns where key material comes from.

## The model

One key generation is shared by every secret value - not one per bundle. Generations live in `previewkit_secret_key`, holding only the material **wrapped by this environment's KMS CMK**, so the rows are inert without `kms:Decrypt`. The plaintext key exists only in memory, only in a process that needs it, and never in configuration: there is no key environment variable to leak, rotate by hand, or get out of sync between the API and the runner.

Each stored envelope names the generation that sealed it, so old values keep resolving to their own key while new writes use the current primary.

## `SecretKeys`

Resolves the cipher for an operation, unwrapping generations on demand.

```ts
import { KMSClient } from "@aws-sdk/client-kms";
import { KmsKeyProvider, SecretKeys } from "@autonoma/secrets";

const keys = new SecretKeys(db, new KmsKeyProvider(new KMSClient({ region }), env.PREVIEWKIT_SECRETS_CMK));

const sealed = (await keys.primary()).encrypt(value, scope); // writing
const opened = (await keys.forEnvelope(sealed)).decrypt(sealed, scope); // reading
```

Unwrapping happens at the point of use rather than at startup, which buys three things: a deploy with no configured secrets never calls KMS at all, revoking a process's IAM takes effect on its next resolve instead of whenever the pod happens to restart, and each unwrap lands in CloudTrail next to the work that needed it. Material is cached per key id for the life of the instance, so the previewkit runner - a one-shot Job - unwraps once per deploy.

`primary()` re-reads which generation is primary on every call instead of caching it. That single indexed query is what lets a rotation take effect without a rollout.

Every wrap and unwrap is bound to its key id as KMS encryption context (`{ purpose: "previewkit-secrets", keyId }`). That is additional authenticated data, so a wrapped key cannot be moved between generations, and KMS records the context in CloudTrail - an entry names which generation was loaded rather than just showing that a `Decrypt` happened.

## `mintSecretKey`

Creates a generation and promotes it to primary. An operator action, never on a request path, so a misconfigured process can never silently mint itself a key and start writing values nothing else can read.

```ts
await mintSecretKey({ db, provider, keyId: "1" });
```

Only the wrapped key is stored. Key ids are permanent (every envelope names one) and must match `[A-Za-z0-9_-]+`, since they are a field in the envelope.

### Rotating

1. `mintSecretKey({ db, provider, keyId: "2" })`. New writes immediately use generation 2; existing values keep resolving to 1.
2. Re-encrypt at leisure: read each value through `forEnvelope`, write it back through `primary()`.
3. Leave generation 1's row in place. That is the whole of step 3.

No coordinated rollout, no ordering hazard, no window where one process can write something another cannot read - every process resolves keys through the same table.

**Retired rows are never deleted.** The row is what reserves its key id, and a key id has to stay unambiguous forever because every envelope names one; keeping the row is what makes `mintSecretKey` reject a reused id. A retired wrapped key is inert without `kms:Decrypt` and nothing is encrypted under it any more, so it costs a row and buys an invariant. If a straggler value does turn up later, it still opens.

Deleting a row anyway (hand surgery, not the runbook) makes any value still sealed under it unreadable, and the error names the missing key id. `SecretKeys` will not serve stale material if that id is then re-minted, but the values sealed under the replaced generation are gone.

## `KeyProvider`

The two operations `SecretKeys` and `mintSecretKey` need from a key-management service. `KmsKeyProvider` is the AWS implementation; the seam exists so tests can supply a fake without an AWS client, and so a non-AWS host has somewhere to plug in.

## Local development and tests

Neither needs an AWS account. There are two layers, because they answer different questions:

- **`SecretKeys` and `mintSecretKey`** run against a real Postgres (Testcontainers) with `FakeKeyProvider`. These cover our own logic - generation resolution, caching, promotion, rotation - and stay fast. The database is never faked.
- **`KmsKeyProvider`** runs against [MiniStack](https://github.com/ministackorg/ministack) (MIT-licensed AWS emulator), pinned to a version in `test/kms-harness.ts`. This is the only way to cover the real AWS SDK wiring: alias resolution, `AES_256` yielding the 32 bytes `SecretCipher` requires, and error shapes.

MiniStack was chosen after verifying the property this design actually depends on: it **enforces** encryption context rather than accepting and ignoring it, so unwrapping a key under a different key id fails exactly as real KMS would. An emulator that ignored the context would have made these tests pass while leaving the guarantee unverified, which is worse than not testing it. If MiniStack is ever swapped or upgraded, re-check that case first.

For local development, point a `KMSClient` at MiniStack and mint a generation as usual:

```bash
docker run -p 4566:4566 ministackorg/ministack
```

This is deliberately preferred over a dev-only `KeyProvider` that skips wrapping: there is then no code path that could weaken key handling if it ever ran outside development.

## Operational requirements

- **IAM.** Reading secrets needs `kms:Decrypt` on the environment's CMK; minting also needs `kms:GenerateDataKey`. The previewkit runner has `PreviewkitServiceRole` (IRSA, see `deployment/apps/previewkit.yaml`); the API currently runs under its namespace's `default` ServiceAccount and needs a properly scoped role of its own.
- **One CMK per environment.** Cross-environment isolation comes from IAM, not from code: a beta pod handed a production key row should fail with `AccessDenied`. `KmsKeyProvider` names a CMK only to mint, because a symmetric KMS ciphertext identifies its own key.
- **The CMK is a single point of total data loss.** Disable or delete it and every stored secret becomes permanently unreadable. Enable automatic rotation, never schedule deletion, and alarm on `DisableKey` / `ScheduleKeyDeletion`. Use a multi-region key if the DR plan involves another region - KMS ciphertext is bound to the key that produced it.
- **CMK rotation is not key rotation.** Rotating the CMK only changes the wrapping of existing generations. Rotating the key that actually seals values is `mintSecretKey`.
- **The wrapped keys sit in the same database as the ciphertext.** That is a deliberate trade: it removes the key from configuration entirely and makes rotation rollout-free, at the cost of one layer of defence in depth. An attacker needs the database _and_ KMS, where a configuration-held key would have meant the database _and_ the environment _and_ KMS.
