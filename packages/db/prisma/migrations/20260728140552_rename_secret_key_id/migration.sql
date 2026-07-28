-- Renames `key_id` to `id`. Prisma scaffolds this as DROP CONSTRAINT + DROP
-- COLUMN + ADD COLUMN, which would destroy every minted key generation and
-- leave the secrets sealed under them permanently unreadable. RENAME COLUMN
-- carries the primary key constraint over to the new name on its own.
ALTER TABLE "previewkit_secret_key" RENAME COLUMN "key_id" TO "id";
