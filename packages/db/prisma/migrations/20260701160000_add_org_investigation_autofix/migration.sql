-- Org-scoped gate for the investigation agent's ACTING (autofix): editing/activating scenario recipes,
-- applying test-suite edits, and posting client-factory PR comments. Off by default so the observe-only shadow
-- (report + route diagnosis) keeps running for every org via INVESTIGATION_SHADOW_ENABLED, while the mutating
-- steps roll out per trusted org (Centinel first) before enabling broadly.
ALTER TABLE "organization_settings" ADD COLUMN "investigation_autofix_enabled" BOOLEAN NOT NULL DEFAULT false;
