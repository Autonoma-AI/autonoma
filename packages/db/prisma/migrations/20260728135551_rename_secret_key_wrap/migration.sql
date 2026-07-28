-- Renames `wrapped_key` to `wrap`. Prisma scaffolds a rename as DROP + ADD,
-- which would destroy any minted key generation and leave every secret sealed
-- under it permanently unreadable. No environment has this table yet, but a
-- rename should still be a rename.
ALTER TABLE "previewkit_secret_key" RENAME COLUMN "wrapped_key" TO "wrap";
