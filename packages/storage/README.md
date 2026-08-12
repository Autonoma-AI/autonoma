# @autonoma/storage

A lightweight object storage abstraction with pluggable providers. Defines a `StorageProvider` interface and ships two implementations - S3 (for production) and local filesystem (for development/testing).

## Exports

The package has two entry points:

| Entry point | Import path | What it provides |
|---|---|---|
| Main | `@autonoma/storage` | `StorageProvider` interface, `S3Storage`, `LocalStorageProvider`, `ObjectNotFoundError` |
| Env | `@autonoma/storage/env` | Validated `env` object with S3 credentials |

## StorageProvider Interface

```ts
interface StorageProvider {
    upload(key: string, data: Buffer): Promise<string>;
    download(key: string): Promise<Buffer>;
    delete(key: string): Promise<void>;
    getSignedUrl(key: string, expiresInSeconds: number): Promise<string>;
}
```

All providers implement this interface, so consumers depend on the abstraction rather than a concrete storage backend.

## Providers

### S3Storage

Production provider backed by AWS S3. Accepts an explicit config or reads from environment variables.

```ts
import { S3Storage } from "@autonoma/storage";

// From environment variables (S3_BUCKET, S3_REGION, and optionally static credentials)
const storage = S3Storage.createFromEnv();

// Reuse the region and credential chain for a distinct private bucket.
const evalArtifacts = S3Storage.createFromEnv("autonoma-dev");

// Or with explicit config
const storage = new S3Storage({
    bucket: "my-bucket",
    region: "us-east-1",
    accessKeyId: "...", // optional - omit both to use the SDK's default credential chain
    secretAccessKey: "...",
    endpoint: "http://localhost:4566", // optional - for LocalStack/MinIO
});

const url = await storage.upload("artifacts/video.mp4", videoBuffer, "video/mp4");
const data = await storage.download(url);
const signed = await storage.getSignedUrl(url, 3600);
await storage.delete(url);
```

Key details:
- Keys can be plain paths (`artifacts/video.mp4`) or S3 URIs (`s3://bucket/key`) - the `s3://` prefix is stripped automatically.
- `upload` returns an `s3://bucket/key` URI. Pass an optional `contentType` (third arg) to set the stored MIME type; it defaults to `application/octet-stream`. Set it for media (e.g. `video/webm`) so browsers can play and seek the object.
- Setting `endpoint` enables path-style addressing (required for LocalStack/MinIO).
- Throws `ObjectNotFoundError` when downloading a key that does not exist.

### LocalStorageProvider

Filesystem-backed provider for local development and testing.

```ts
import { LocalStorageProvider } from "@autonoma/storage";

const storage = new LocalStorageProvider("/tmp/autonoma-storage");

const url = await storage.upload("screenshots/step-1.png", pngBuffer);
// Returns file:///tmp/autonoma-storage/screenshots/step-1.png
```

Creates directories recursively on upload. `getSignedUrl` simply returns a `file://` URI (no expiry).

## Environment Variables

When using `S3Storage.createFromEnv()`, the following variables are required and validated at import time via `@t3-oss/env-core`:

| Variable | Required | Description |
|---|---|---|
| `S3_BUCKET` | yes | S3 bucket name |
| `S3_REGION` | yes | AWS region |
| `S3_ACCESS_KEY_ID` | no | Static access key ID |
| `S3_SECRET_ACCESS_KEY` | no | Static secret access key |

## Credentials

If both `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY` are set, the client uses them. Otherwise it sets no `credentials` at all and the SDK's default chain resolves them - which in EKS means assuming the pod ServiceAccount's role from its projected OIDC token (IRSA), and locally means `~/.aws/credentials` or an instance role.

A host that means to use IRSA must have no static keys in its environment: `fromEnv` sits ahead of `fromTokenFile` in the default chain, so keys silently keep the old identity in use. See [deployment/apps/README.md](../../deployment/apps/README.md) for the API's role and the cutover order.

One consequence of temporary credentials: a presigned URL stops working when the session that signed it expires, whatever TTL the caller asked for. `AssumeRoleWithWebIdentity` sessions are 1h, and the SDK refreshes ~5 minutes ahead of expiry, so a URL signed just before a refresh can outlive its credentials. Keep presign TTLs comfortably short, or re-sign on demand, rather than assuming a long TTL holds.

Import the validated env object directly if needed:

```ts
import { env } from "@autonoma/storage/env";
```

## Usage with Dependency Injection

Consumers should depend on the `StorageProvider` interface so the backend can be swapped without code changes:

```ts
import type { StorageProvider } from "@autonoma/storage";

class ArtifactLoader {
    constructor(private readonly storage: StorageProvider) {}

    async loadVideo(key: string): Promise<Buffer> {
        return this.storage.download(key);
    }
}
```
