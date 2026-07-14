#!/usr/bin/env bash
# Block until the latest OpenCode run for a PR has settled, then print its result.
#
# "Settled" means: the newest OpenCode run on the PR's branch is `completed`, and
# no superseding run has appeared for a newer head SHA. opencode-review.yml uses
# cancel-in-progress concurrency, so a push mid-review cancels the old run and
# starts a new one - this script follows that chain instead of returning on the
# first (cancelled) run.
#
# Designed to be launched in the background: it wakes the caller exactly once, on
# exit, printing a single machine-readable result line the caller can parse.
#
# Usage: watch-opencode.sh <pr-number>
# Final line: OPENCODE_RESULT {"runId":..,"status":..,"conclusion":..,"headSha":..,"url":..,"workflow":..}
#   conclusion "none"  -> no OpenCode run exists for this PR (draft / fork / bot PR, or not triggered)
#   conclusion "timeout" -> hit the safety backstop before settling
set -euo pipefail

PR="${1:?usage: watch-opencode.sh <pr-number>}"

REVIEW_WF="opencode-review.yml"          # automatic PR reviewer (posts a findings comment)
COMMENT_WF="opencode-comment.yml"        # /oc or /opencode build agent
APPEAR_WINDOW_SECS=90                    # how long to wait for a run to first show up
APPEAR_POLL_SECS=10                      # poll cadence while waiting for a run / supersede
SETTLE_GRACE_SECS=25                     # after a run completes, wait this long for a superseding run
MAX_WAIT_SECS=$((75 * 60))              # backstop: opencode caps at 15 min/run, but pushes can chain

start_ts=$(date +%s)
elapsed() { echo $(( $(date +%s) - start_ts )); }

pr_head_sha() { gh pr view "$PR" --json headRefOid -q .headRefOid; }
pr_branch()   { gh pr view "$PR" --json headRefName -q .headRefName; }

# Most-recent OpenCode run (review OR comment) on the branch, or empty string.
latest_run() {
  local branch="$1"
  {
    gh run list --branch "$branch" --workflow "$REVIEW_WF" -L 5 \
      --json databaseId,status,conclusion,headSha,createdAt,url,name 2>/dev/null || echo '[]'
    gh run list --branch "$branch" --workflow "$COMMENT_WF" -L 5 \
      --json databaseId,status,conclusion,headSha,createdAt,url,name 2>/dev/null || echo '[]'
  } | jq -sc 'add | sort_by(.createdAt) | reverse | .[0] // empty'
}

emit() { echo "OPENCODE_RESULT $1"; exit 0; }

branch=$(pr_branch)

while :; do
  if [ "$(elapsed)" -ge "$MAX_WAIT_SECS" ]; then
    emit '{"conclusion":"timeout"}'
  fi

  run=$(latest_run "$branch")

  # No run yet: give a freshly-pushed run a chance to appear, else nothing to watch.
  if [ -z "$run" ]; then
    if [ "$(elapsed)" -lt "$APPEAR_WINDOW_SECS" ]; then
      sleep "$APPEAR_POLL_SECS"; continue
    fi
    emit '{"conclusion":"none"}'
  fi

  status=$(echo "$run" | jq -r .status)
  run_id=$(echo "$run" | jq -r .databaseId)
  run_sha=$(echo "$run" | jq -r .headSha)

  # Still running: block on it, then re-resolve (a newer push may have superseded).
  if [ "$status" != "completed" ]; then
    gh run watch "$run_id" >/dev/null 2>&1 || true
    continue
  fi

  # Completed, but the PR tip has moved past this run's SHA -> a superseding run is
  # (or will be) queued. Wait for it to appear.
  if [ "$(pr_head_sha)" != "$run_sha" ]; then
    sleep "$APPEAR_POLL_SECS"; continue
  fi

  # Tip matches and run is done. Grace-wait once for a late-appearing superseding run.
  sleep "$SETTLE_GRACE_SECS"
  run2=$(latest_run "$branch")
  if [ -n "$run2" ]; then
    id2=$(echo "$run2" | jq -r .databaseId)
    st2=$(echo "$run2" | jq -r .status)
    if [ "$id2" != "$run_id" ] && [ "$st2" != "completed" ]; then
      continue
    fi
  fi

  emit "$run"
done
