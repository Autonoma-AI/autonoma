-- Rename the `previewkit_app_build_status` enum value `ok` -> `success`.
--
-- Prisma's generated migration for an enum value change recreates the type and
-- casts existing values through text, which fails on any row still holding the
-- old value. `ALTER TYPE ... RENAME VALUE` renames in place and preserves all
-- existing rows, so it is used here instead.
ALTER TYPE "previewkit_app_build_status" RENAME VALUE 'ok' TO 'success';
