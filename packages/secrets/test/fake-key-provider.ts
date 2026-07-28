import { randomBytes } from "node:crypto";
import type { KeyProvider } from "../src/key-provider";

/** Separates the serialized encryption context from the material in a fake wrapped key. */
const CONTEXT_TERMINATOR = 0;

/**
 * Stands in for KMS. Wrapping prefixes the material with its serialized
 * encryption context, so unwrapping under a different context fails the way a
 * real provider would - which is what makes the context assertions meaningful
 * without an AWS client. The database is never faked; these tests run against a
 * real Postgres.
 */
export class FakeKeyProvider implements KeyProvider {
    readonly unwrapped: Record<string, string>[] = [];
    readonly generated: Record<string, string>[] = [];

    constructor(private readonly failWith?: Error) {}

    async generate(encryptionContext: Record<string, string>) {
        this.generated.push(encryptionContext);
        if (this.failWith != null) throw this.failWith;

        const material = randomBytes(32);
        return {
            material,
            wrapped: Buffer.concat([
                Buffer.from(JSON.stringify(encryptionContext), "utf8"),
                Buffer.from([CONTEXT_TERMINATOR]),
                material,
            ]),
        };
    }

    async unwrap(wrapped: Uint8Array, encryptionContext: Record<string, string>): Promise<Uint8Array> {
        this.unwrapped.push(encryptionContext);
        if (this.failWith != null) throw this.failWith;

        const raw = Buffer.from(wrapped);
        const separator = raw.indexOf(CONTEXT_TERMINATOR);
        const sealedUnder = raw.subarray(0, separator).toString("utf8");

        if (sealedUnder !== JSON.stringify(encryptionContext)) {
            throw new Error(`Encryption context mismatch: the key was wrapped under ${sealedUnder}`);
        }
        return raw.subarray(separator + 1);
    }
}
