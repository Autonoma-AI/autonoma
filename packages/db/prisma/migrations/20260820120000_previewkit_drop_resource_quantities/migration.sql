-- Removes the resource quantities the tier replaced.
--
-- The four columns per table are the whole history of how a container's size was
-- expressed: a CPU request, a memory request, a separate larger memory limit, and
-- then the single memory number those two collapsed into. `resources_tier` has
-- carried the answer since the tiers landed, and nothing reads these.
--
-- Verified before writing this, while the evidence still existed: every row's tier
-- matched what the quantities said it should be - 259 apps at 250m/1Gi on `medium`,
-- 170 services at 100m/1Gi on `standard`, and each of the odd combinations on the
-- rung that covers it. Dropping the columns destroys the only way to check that, so
-- it was checked first rather than after.
--
-- Safe to apply whenever, in either order with a deploy: the release that stopped
-- reading these is already out, so no running pod selects them.
ALTER TABLE "previewkit_app" DROP COLUMN "resources_cpu";
ALTER TABLE "previewkit_app" DROP COLUMN "resources_memory";
ALTER TABLE "previewkit_app" DROP COLUMN "resources_memory_request";
ALTER TABLE "previewkit_app" DROP COLUMN "resources_memory_limit";

ALTER TABLE "previewkit_config_service" DROP COLUMN "resources_cpu";
ALTER TABLE "previewkit_config_service" DROP COLUMN "resources_memory";
ALTER TABLE "previewkit_config_service" DROP COLUMN "resources_memory_request";
ALTER TABLE "previewkit_config_service" DROP COLUMN "resources_memory_limit";
