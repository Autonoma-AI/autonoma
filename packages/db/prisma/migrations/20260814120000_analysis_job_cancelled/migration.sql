-- The run was cancelled because its application was deleted, unlinked, or its org disconnected GitHub. Like
-- `superseded`, `status` stays `failed`; this flag is the machine-readable discriminator that keeps a
-- cancelled-for-deletion run out of genuine-failure counts. Defaults false, so every existing row reads as a
-- genuine failure or completion exactly as before.
ALTER TABLE "analysis_job" ADD COLUMN     "cancelled" BOOLEAN NOT NULL DEFAULT false;
