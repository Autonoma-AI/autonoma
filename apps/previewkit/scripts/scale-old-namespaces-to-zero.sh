#!/usr/bin/env bash
# Scale all deployments to zero in preview-* and alpha-* namespaces older than 48 hours.
# Defaults to dry-run; pass --apply to actually scale.
#
# Usage:
#   ./scale-old-namespaces-to-zero.sh [--apply] [--age-hours N]
#
# Options:
#   --apply          Execute the scale commands (default: dry-run)
#   --age-hours N    Age threshold in hours (default: 48)
#
# Examples:
#   ./scale-old-namespaces-to-zero.sh                  # dry-run, preview-* namespaces >48h
#   ./scale-old-namespaces-to-zero.sh --apply          # scale for real
#   ./scale-old-namespaces-to-zero.sh --age-hours 24 --apply

set -euo pipefail

DRY_RUN=true
AGE_HOURS=48

while [[ $# -gt 0 ]]; do
  case "$1" in
    --apply)        DRY_RUN=false; shift ;;
    --age-hours)    AGE_HOURS="$2"; shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

NOW=$(date -u +%s)
THRESHOLD_SECONDS=$(( AGE_HOURS * 3600 ))

if $DRY_RUN; then
  echo "[DRY-RUN] Pass --apply to execute. Namespaces older than ${AGE_HOURS}h that would be scaled to zero:"
else
  echo "[APPLY] Scaling deployments to zero in namespaces older than ${AGE_HOURS}h"
fi

kubectl get namespaces -o json | \
  jq -r '.items[] | "\(.metadata.name) \(.metadata.creationTimestamp)"' | \
  while read -r ns created_at; do
    if [[ "$ns" != preview-* && "$ns" != alpha-* ]]; then
      continue
    fi

    # Parse ISO-8601 timestamp to epoch (portable: works on macOS + Linux)
    if [[ "$(uname)" == "Darwin" ]]; then
      ns_epoch=$(date -u -j -f "%Y-%m-%dT%H:%M:%SZ" "$created_at" +%s 2>/dev/null) || continue
    else
      ns_epoch=$(date -u -d "$created_at" +%s 2>/dev/null) || continue
    fi

    age_seconds=$(( NOW - ns_epoch ))

    if (( age_seconds < THRESHOLD_SECONDS )); then
      continue
    fi

    age_hours=$(( age_seconds / 3600 ))
    deployments=$(kubectl get deployments -n "$ns" -o jsonpath='{.items[*].metadata.name}' 2>/dev/null)

    if [[ -z "$deployments" ]]; then
      continue
    fi

    echo ""
    echo "Namespace: $ns (age: ${age_hours}h)"
    for deploy in $deployments; do
      current_replicas=$(kubectl get deployment "$deploy" -n "$ns" \
        -o jsonpath='{.spec.replicas}' 2>/dev/null || echo "?")
      if $DRY_RUN; then
        echo "  [DRY-RUN] kubectl scale deployment $deploy -n $ns --replicas=0  (current: $current_replicas)"
      else
        if [[ "$current_replicas" == "0" ]]; then
          echo "  SKIP $deploy (already at 0)"
        else
          echo "  SCALE $deploy (current: $current_replicas) -> 0"
          kubectl scale deployment "$deploy" -n "$ns" --replicas=0
        fi
      fi
    done
  done

echo ""
if $DRY_RUN; then
  echo "Dry-run complete. Re-run with --apply to scale."
else
  echo "Done."
fi
