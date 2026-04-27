-- Switch scenario recipe / schema snapshot JSON columns from jsonb to json.
--
-- Postgres jsonb normalises key order (by length, then lexicographically), so
-- recipes written with keys in topologically-valid order (parents before
-- children) come back scrambled. When the SDK walks the scrambled `create`
-- object in insertion order, child models are processed before their parents
-- and `_ref` references drop to `deferredUpdates` (applied AFTER factories),
-- so factories receive `undefined` for parent FKs.
--
-- `json` preserves textual key order, so recipes round-trip unchanged.
--
-- Note: existing rows retain their already-scrambled order (the jsonb -> json
-- cast freezes whatever jsonb returned). Affected scenarios must be
-- re-ingested via the plugin's discovery command to benefit from this fix.

ALTER TABLE "scenario_recipe_version"
    ALTER COLUMN "fixture_json" TYPE JSON USING "fixture_json"::json;

ALTER TABLE "scenario_schema_snapshot"
    ALTER COLUMN "structure_json" TYPE JSON USING "structure_json"::json;
