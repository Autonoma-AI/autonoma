-- Make Application.activeConfigRevisionId a real foreign key to
-- PreviewkitConfigRevision. It was a plain string, which let it dangle
-- (point at an id that no revision has - the bug this migration prevents).

-- Defensive: null out any dangling active pointers BEFORE enforcing the FK so
-- the ADD CONSTRAINT below cannot fail on pre-existing bad data in any
-- environment. The pointer is optional; a null degrades to the .preview.yaml
-- fallback, which is the intended "no active revision" behavior.
UPDATE "application" a
SET "active_config_revision_id" = NULL
WHERE "active_config_revision_id" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "previewkit_config_revision" r WHERE r.id = a."active_config_revision_id"
  );

-- CreateIndex
CREATE UNIQUE INDEX "application_active_config_revision_id_key" ON "application"("active_config_revision_id");

-- AddForeignKey
ALTER TABLE "application" ADD CONSTRAINT "application_active_config_revision_id_fkey" FOREIGN KEY ("active_config_revision_id") REFERENCES "previewkit_config_revision"("id") ON DELETE SET NULL ON UPDATE CASCADE;
