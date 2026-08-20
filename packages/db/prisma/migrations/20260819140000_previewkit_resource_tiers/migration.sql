-- Resources become a tier chosen from a menu instead of a quantity someone typed.
--
-- A free string let a config ask for "6Gi because why not", and nothing pushed
-- back. A closed set is something the platform can price, cap per plan, and retune
-- fleet-wide - and because the CPU and memory behind a tier live in code rather
-- than in these rows, retuning one moves every container on it with no migration.
--
-- Apps and services get separate ladders. Measured over a week: an app's peak
-- memory has a median of 117Mi and a 90th percentile of 703Mi, while services run
-- from a 54Mi redis to a 1.7Gi postgres. One ladder was wrong at both ends.
--
-- THE BACKFILL NEVER SHRINKS ANYTHING. Each row snaps to the smallest tier that
-- covers BOTH its current CPU and its current memory, so no running container
-- loses headroom and starts OOM-killing on its next deploy. Both dimensions have
-- to fit, which is why a CPU-heavy row can land higher than its memory alone would
-- suggest. Every distinct pair configured at the time is enumerated below; the
-- final ELSE is the largest tier, so a pair added between writing this and running
-- it still lands somewhere safe rather than failing the migration.
--
-- Apply BEFORE deploying the code. The new columns carry defaults, so a pod still
-- running the old code writes rows that land on the default tier instead of
-- erroring, and the quantity columns it still reads are all still here - made
-- nullable, not dropped. Dropping them has to wait until no pod reads them, which
-- is a separate migration after this release is out.
CREATE TYPE "previewkit_app_resource_tier" AS ENUM ('small', 'standard', 'medium', 'large', 'xlarge');
CREATE TYPE "previewkit_service_resource_tier" AS ENUM ('small', 'standard', 'large');

ALTER TABLE "previewkit_app"
    ADD COLUMN "resources_tier" "previewkit_app_resource_tier" NOT NULL DEFAULT 'medium';
ALTER TABLE "previewkit_config_service"
    ADD COLUMN "resources_tier" "previewkit_service_resource_tier" NOT NULL DEFAULT 'standard';

-- App ladder: small 150m/256Mi, standard 250m/512Mi, medium 250m/1Gi,
-- large 500m/1Gi, xlarge 500m/2Gi.
--
-- `medium` exists for the 259 apps at 250m/1Gi. Without it they would have had to
-- take `large` and doubled their CPU reservation - about 65 cores across the fleet,
-- for CPU that has never been measured above 149m on any preview pod.
--
-- Reads `resources_memory`, NOT `resources_memory_limit`. The previous release
-- collapsed the pair into that one column and stopped writing the old two, so
-- every row saved since it deployed has a NULL limit - and a NULL matches none of
-- these branches, sending a plain 250m/1Gi app to the ELSE and provisioning it at
-- xlarge. `resources_memory` is populated for every row: the older ones by that
-- release's own backfill, the newer ones by its writers.
UPDATE "previewkit_app" SET "resources_tier" =
    CASE
        WHEN "resources_cpu" = '250m' AND "resources_memory" IN ('256Mi', '512Mi') THEN 'standard'
        WHEN "resources_cpu" = '250m' AND "resources_memory" = '1Gi' THEN 'medium'
        WHEN "resources_cpu" = '500m' AND "resources_memory" IN ('512Mi', '1Gi') THEN 'large'
        ELSE 'xlarge'
    END::"previewkit_app_resource_tier";

-- Service ladder: small 100m/256Mi, standard 100m/1Gi, large 500m/2Gi.
UPDATE "previewkit_config_service" SET "resources_tier" =
    CASE
        WHEN "resources_cpu" = '100m' AND "resources_memory" = '256Mi' THEN 'small'
        WHEN "resources_cpu" = '100m' AND "resources_memory" IN ('512Mi', '1Gi') THEN 'standard'
        ELSE 'large'
    END::"previewkit_service_resource_tier";

-- Nullable, not dropped: the code being replaced still selects these, and a column
-- that disappears under a running pod fails its every read. The writers stop
-- filling them in with this release; a later migration removes them.
ALTER TABLE "previewkit_app" ALTER COLUMN "resources_cpu" DROP NOT NULL;
ALTER TABLE "previewkit_app" ALTER COLUMN "resources_memory" DROP NOT NULL;
ALTER TABLE "previewkit_config_service" ALTER COLUMN "resources_cpu" DROP NOT NULL;
ALTER TABLE "previewkit_config_service" ALTER COLUMN "resources_memory" DROP NOT NULL;

-- The default existed so a writer that omitted the column still got a sane value.
-- Nothing writes it now, so it would only ever fill a column nobody reads.
ALTER TABLE "previewkit_app" ALTER COLUMN "resources_memory" DROP DEFAULT;
ALTER TABLE "previewkit_config_service" ALTER COLUMN "resources_memory" DROP DEFAULT;
