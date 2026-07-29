-- Renames the encryption-key table and the column that references it.
--
-- "generation" is retired from this vocabulary: in this schema that word means
-- TestGeneration, which seven unrelated models relate to, so `generation_id` on a
-- secret read as an AI test generation rather than a wrapped AES key.
--
-- Prisma scaffolds all of this as DROP + CREATE, which would destroy the key rows
-- and leave every secret sealed under them unreadable. Renames only below.
-- Postgres does not carry index or constraint names across a table rename, so each
-- is renamed explicitly to keep the names Prisma derives from the new table.
ALTER TABLE "previewkit_secret_key" RENAME TO "previewkit_encryption_key";
ALTER INDEX "previewkit_secret_key_pkey" RENAME TO "previewkit_encryption_key_pkey";
ALTER INDEX "previewkit_secret_key_is_primary_idx" RENAME TO "previewkit_encryption_key_is_primary_idx";

ALTER TABLE "previewkit_secret_value" RENAME COLUMN "generation_id" TO "encryption_key_id";
ALTER INDEX "previewkit_secret_value_generation_id_idx" RENAME TO "previewkit_secret_value_encryption_key_id_idx";
ALTER TABLE "previewkit_secret_value" RENAME CONSTRAINT "previewkit_secret_value_generation_id_fkey" TO "previewkit_secret_value_encryption_key_id_fkey";

ALTER TABLE "previewkit_org_secret_value" RENAME COLUMN "generation_id" TO "encryption_key_id";
ALTER INDEX "previewkit_org_secret_value_generation_id_idx" RENAME TO "previewkit_org_secret_value_encryption_key_id_idx";
ALTER TABLE "previewkit_org_secret_value" RENAME CONSTRAINT "previewkit_org_secret_value_generation_id_fkey" TO "previewkit_org_secret_value_encryption_key_id_fkey";
