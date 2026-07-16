-- Retire the `runs` PR-comment kind: the investigation comment is now the single results comment.
-- Delete any rows still tracking a `runs` comment, then recreate the enum without the value - Postgres
-- cannot drop an in-use enum value in place. Destructive by design; removing the already-posted `runs`
-- comments from live GitHub PRs is a separate backfill/ops task, out of scope here.
DELETE FROM "github_pr_comment" WHERE "kind" = 'runs';

DROP TYPE IF EXISTS "github_pr_comment_kind_new";
CREATE TYPE "github_pr_comment_kind_new" AS ENUM (
  'preview',
  'investigation'
);

ALTER TABLE "github_pr_comment"
  ALTER COLUMN "kind" TYPE "github_pr_comment_kind_new" USING "kind"::text::"github_pr_comment_kind_new";

DROP TYPE "github_pr_comment_kind";
ALTER TYPE "github_pr_comment_kind_new" RENAME TO "github_pr_comment_kind";
