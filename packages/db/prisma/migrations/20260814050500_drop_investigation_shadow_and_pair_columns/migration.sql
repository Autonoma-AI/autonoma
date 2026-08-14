-- Drops the four columns the retired investigation agent needed. Every read of
-- them is gone, and the rows they hid - 8,326 detached twin snapshots, 14
-- `__investigation_shadow__` probes and 42,369 shadow generations - were purged
-- beforehand. Applying this while any of them survive would not make the old
-- filters vacuous, it would make them unwritable: the twins would surface in PR
-- checkpoint history and the probes in 14 customers' test trees.
--
-- `ai_cost_record.investigation_snapshot_id` is a DIFFERENT column and stays:
-- the live analysis pipeline still writes it.
--
-- Data lost: `branch_snapshot.investigation_snapshot_id` was the only link
-- identifying a detached twin, and `organization_settings.investigation_autofix_enabled`
-- gated a feature that no longer exists. Both are unreadable by any live code.

-- DropForeignKey
ALTER TABLE "branch_snapshot" DROP CONSTRAINT "branch_snapshot_investigation_snapshot_id_fkey";

-- DropIndex
DROP INDEX "branch_snapshot_investigation_snapshot_id_key";

-- AlterTable
ALTER TABLE "branch_snapshot" DROP COLUMN "investigation_snapshot_id";

-- AlterTable
ALTER TABLE "organization_settings" DROP COLUMN "investigation_autofix_enabled";

-- AlterTable
ALTER TABLE "test_case" DROP COLUMN "shadow";

-- AlterTable
ALTER TABLE "test_generation" DROP COLUMN "shadow";
