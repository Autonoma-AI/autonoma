import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { S3ClientConfig } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { env } from "../env";
import type { StorageProvider } from "../storage-provider";

export interface S3StorageConfig {
    bucket: string;
    region: string;
    accessKeyId: string;
    secretAccessKey: string;
    /** Custom endpoint URL, e.g. for LocalStack or MinIO. Enables path-style addressing. */
    endpoint?: string;
}

export class ObjectNotFoundError extends Error {
    constructor(public readonly key: string) {
        super(`Object not found: ${key}`);
    }
}

function stripProtocolIfPresent(url: string): string {
    return url.replace(/^s3:\/\//, "");
}

function stripBucket(key: string, bucketName: string): string {
    return key.replace(`${bucketName}/`, "");
}

export class S3Storage implements StorageProvider {
    private readonly s3: S3Client;

    constructor(private readonly config: S3StorageConfig) {
        const clientConfig: S3ClientConfig = {
            region: this.config.region,
            credentials: {
                accessKeyId: this.config.accessKeyId,
                secretAccessKey: this.config.secretAccessKey,
            },
        };
        if (this.config.endpoint != null) {
            clientConfig.endpoint = this.config.endpoint;
            clientConfig.forcePathStyle = true;
        }
        this.s3 = new S3Client(clientConfig);
    }

    public static createFromEnv(): S3Storage {
        return new S3Storage({
            bucket: env.S3_BUCKET,
            region: env.S3_REGION,
            accessKeyId: env.S3_ACCESS_KEY_ID,
            secretAccessKey: env.S3_SECRET_ACCESS_KEY,
            endpoint: env.S3_ENDPOINT,
        });
    }

    private urlForKey(key: string): string {
        return `s3://${this.config.bucket}/${key}`;
    }

    private putObjectCommand(urlOrKey: string, data: Buffer) {
        const key = stripProtocolIfPresent(urlOrKey);

        return new PutObjectCommand({
            Bucket: this.config.bucket,
            Key: key,
            Body: data,
            ContentType: "application/octet-stream",
        });
    }

    async upload(urlOrKey: string, data: Buffer): Promise<string> {
        await this.s3.send(this.putObjectCommand(urlOrKey, data));

        return this.urlForKey(stripProtocolIfPresent(urlOrKey));
    }

    async uploadStream(urlOrKey: string, stream: ReadableStream, contentType?: string): Promise<string> {
        const key = stripProtocolIfPresent(urlOrKey);
        const nodeStream = Readable.fromWeb(stream as NodeReadableStream);

        const upload = new Upload({
            client: this.s3,
            params: {
                Bucket: this.config.bucket,
                Key: key,
                Body: nodeStream,
                ContentType: contentType ?? "application/octet-stream",
            },
        });

        await upload.done();

        return this.urlForKey(key);
    }

    private getObjectCommand(urlOrKey: string) {
        const key = stripProtocolIfPresent(urlOrKey);
        const strippedKey = stripBucket(key, this.config.bucket);

        return new GetObjectCommand({
            Bucket: this.config.bucket,
            Key: strippedKey,
        });
    }

    async download(urlOrKey: string): Promise<Buffer> {
        const response = await this.s3.send(this.getObjectCommand(urlOrKey));
        if (response.Body == null) throw new ObjectNotFoundError(urlOrKey);

        return Buffer.from(await response.Body.transformToByteArray());
    }

    private deleteObjectCommand(urlOrKey: string) {
        const key = stripProtocolIfPresent(urlOrKey);

        return new DeleteObjectCommand({
            Bucket: this.config.bucket,
            Key: key,
        });
    }

    async delete(urlOrKey: string): Promise<void> {
        await this.s3.send(this.deleteObjectCommand(urlOrKey));
    }

    async getSignedUrl(urlOrKey: string, expiresInSeconds: number): Promise<string> {
        return await getSignedUrl(this.s3, this.getObjectCommand(urlOrKey), { expiresIn: expiresInSeconds });
    }
}
