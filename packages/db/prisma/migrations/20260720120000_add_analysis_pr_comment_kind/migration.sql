-- The merged analysis pipeline posts its own PR comment, kept separate from the diffs "runs" comment and the
-- legacy investigation comment so the three never stomp each other during the shadow->authoritative transition.
ALTER TYPE "github_pr_comment_kind" ADD VALUE IF NOT EXISTS 'analysis';
