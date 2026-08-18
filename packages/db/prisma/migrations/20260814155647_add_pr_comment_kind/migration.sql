-- The single unified Autonoma PR comment (preview status + analysis), owned by the analysis run workflow and
-- replacing the separate `preview` and `analysis` comments.
ALTER TYPE "github_pr_comment_kind" ADD VALUE IF NOT EXISTS 'pr';
