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

// From environment variables (S3_BUCKET, S3_REGION, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, optional S3_ENDPOINT)
const storage = S3Storage.createFromEnv();

// Or with explicit config
const storage = new S3Storage({
    bucket: "my-bucket",
    region: "us-east-1",
    accessKeyId: "...",
    secretAccessKey: "...",
    endpoint: "http://localhost:4566", // optional - for LocalStack/MinIO
});

const url = await storage.upload("artifacts/video.mp4", videoBuffer);
const data = await storage.download(url);
const signed = await storage.getSignedUrl(url, 3600);
await storage.delete(url);
```

Key details:
- Keys can be plain paths (`artifacts/video.mp4`) or S3 URIs (`s3://bucket/key`) - the `s3://` prefix is stripped automatically.
- `upload` returns an `s3://bucket/key` URI.
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

When using `S3Storage.createFromEnv()`, the following variables are validated at import time via `@t3-oss/env-core`:

| Variable | Description |
|---|---|
| `S3_BUCKET` | S3 bucket name |
| `S3_REGION` | AWS region |
| `S3_ACCESS_KEY_ID` | AWS access key ID |
| `S3_SECRET_ACCESS_KEY` | AWS secret access key |
| `S3_ENDPOINT` | Optional custom endpoint URL for S3-compatible providers such as MinIO |

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
