-- One memory number per container instead of a request and a larger limit.
--
-- The pair bought nothing anyone authoring a config was thinking about: the
-- request decided where a pod fit, the limit decided when it died, and the gap
-- between them was memory a preview was allowed to use but the scheduler had not
-- reserved. Collapsing to the LIMIT is what changes no running container's fate -
-- every pod keeps exactly the ceiling it has today, and the node now reserves it.
-- Collapsing to the request would have been cheaper and would have started
-- OOM-killing: 4 of 84 running preview pods were above their 512Mi request when
-- this was measured, the largest at 815Mi.
--
-- Reservations therefore rise (an app from 512Mi to 1Gi, a service from 256Mi to
-- 1Gi), which is the cost of the promise being honest. The tiers that follow this
-- change are what let an app ask for less on purpose.
--
-- Apply BEFORE deploying the code that stops writing the old pair. The DEFAULT is
-- what makes that safe in the other direction too: a pod still running the old
-- code inserts without naming the new column and gets a sensible value rather
-- than an error.
ALTER TABLE "previewkit_app" ADD COLUMN "resources_memory" TEXT NOT NULL DEFAULT '1Gi';
ALTER TABLE "previewkit_config_service" ADD COLUMN "resources_memory" TEXT NOT NULL DEFAULT '1Gi';

UPDATE "previewkit_app" SET "resources_memory" = "resources_memory_limit";
UPDATE "previewkit_config_service" SET "resources_memory" = "resources_memory_limit";

ALTER TABLE "previewkit_app" ALTER COLUMN "resources_memory_request" DROP NOT NULL;
ALTER TABLE "previewkit_app" ALTER COLUMN "resources_memory_limit" DROP NOT NULL;
ALTER TABLE "previewkit_config_service" ALTER COLUMN "resources_memory_request" DROP NOT NULL;
ALTER TABLE "previewkit_config_service" ALTER COLUMN "resources_memory_limit" DROP NOT NULL;
