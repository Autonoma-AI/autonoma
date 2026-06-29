-- Multirepo dependency configs owned by the primary app's config revision: an
-- array of { repo, document } validated configs for repos declared in the
-- primary document's config.multirepo.repos. Dependency repos are no longer
-- separate Applications; the primary app owns the whole topology and the deploy
-- reads each dependency's config from here (cloning the repo for source only).
ALTER TABLE "previewkit_config_revision" ADD COLUMN "dependency_documents" JSONB;
