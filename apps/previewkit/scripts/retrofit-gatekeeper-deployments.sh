#!/usr/bin/env bash
# Retrofit already-running gatekeeper Deployments to the current spec, in place,
# without rebuilding any app images. Two changes rolled together in one patch:
#   1. Schedule onto the dedicated `gatekeeper` Karpenter NodePool (nodeSelector
#      pool=gatekeeper + toleration for the pool=gatekeeper:NoSchedule taint), and
#      drop the stale kubernetes.io/arch=amd64 pin that would otherwise make the pod
#      unschedulable on the arm64 pool.
#   2. Set IDLE_TIMEOUT=30m (enables scale-to-zero after 30m idle).
#
# The resource-factory change only affects gatekeeper Deployments generated on the
# NEXT deploy of an environment; pods already running keep their old spec until
# redeployed - this brings them up to date now.
#
# PREREQUISITE: the gatekeeper image must be arm64-capable (multi-arch). The pool is
# arm64; an amd64-only image will schedule then crashloop (exec format error),
# taking previews down. Verify before --apply:
#   docker manifest inspect public.ecr.aws/autonoma/gatekeeper:<tag> | grep architecture
#
# Defaults to dry-run; pass --apply to execute.
#
# Usage:
#   ./retrofit-gatekeeper-deployments.sh [--apply] [--namespace NS]
#
# Options:
#   --apply          Execute the patches (default: dry-run)
#   --namespace NS   Only retrofit this one namespace (default: all preview-*/alpha-*)
#
# Examples:
#   ./retrofit-gatekeeper-deployments.sh                          # dry-run, all preview-*/alpha-*
#   ./retrofit-gatekeeper-deployments.sh --apply                  # retrofit all for real
#   ./retrofit-gatekeeper-deployments.sh --namespace preview-acme-web-pr-42 --apply

set -euo pipefail

DRY_RUN=true
ONLY_NS=""
ROLLOUT_TIMEOUT=120s

while [[ $# -gt 0 ]]; do
  case "$1" in
    --apply)      DRY_RUN=false; shift ;;
    --namespace)
      if [[ -z "${2:-}" ]]; then echo "--namespace requires a value" >&2; exit 1; fi
      ONLY_NS="$2"; shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

# Strategic merge patch (NOT a JSON merge patch): the env list is merged by `name`,
# so IDLE_TIMEOUT is updated in place and the other env vars are preserved; a null
# value deletes the stale nodeSelector arch key. Keep these values in sync with
# buildGatekeeperDeployment in src/deployer/resource-factory.ts.
PATCH='{"spec":{"template":{"spec":{"nodeSelector":{"kubernetes.io/arch":null,"pool":"gatekeeper"},"tolerations":[{"key":"pool","operator":"Equal","value":"gatekeeper","effect":"NoSchedule"}],"containers":[{"name":"gatekeeper","env":[{"name":"IDLE_TIMEOUT","value":"30m"}]}]}}}}'

if $DRY_RUN; then
  echo "[DRY-RUN] Pass --apply to execute. gatekeeper Deployments that would be retrofitted:"
else
  echo "[APPLY] Retrofitting gatekeeper Deployments (pool=gatekeeper + toleration, IDLE_TIMEOUT=30m)"
fi

if [[ -n "$ONLY_NS" ]]; then
  namespaces="$ONLY_NS"
else
  namespaces=$(kubectl get namespaces -o jsonpath='{.items[*].metadata.name}')
fi

for ns in $namespaces; do
  if [[ "$ns" != preview-* && "$ns" != alpha-* ]]; then
    continue
  fi

  # Skip namespaces with no gatekeeper Deployment (e.g. torn down / mid-deploy).
  if ! kubectl -n "$ns" get deployment gatekeeper >/dev/null 2>&1; then
    continue
  fi

  current_pool=$(kubectl -n "$ns" get deployment gatekeeper \
    -o jsonpath='{.spec.template.spec.nodeSelector.pool}' 2>/dev/null || echo "")
  current_idle=$(kubectl -n "$ns" get deployment gatekeeper \
    -o jsonpath='{.spec.template.spec.containers[0].env[?(@.name=="IDLE_TIMEOUT")].value}' 2>/dev/null || echo "")

  echo ""
  echo "Namespace: $ns"
  if [[ "$current_pool" == "gatekeeper" && "$current_idle" == "30m" ]]; then
    echo "  SKIP (already on gatekeeper pool with IDLE_TIMEOUT=30m)"
    continue
  fi

  if $DRY_RUN; then
    echo "  [DRY-RUN] kubectl -n $ns patch deployment gatekeeper --type=strategic (pool=${current_pool:-<none>}->gatekeeper, IDLE_TIMEOUT=${current_idle:-<none>}->30m)"
    continue
  fi

  echo "  PATCH gatekeeper (pool=gatekeeper, IDLE_TIMEOUT=30m)"
  kubectl -n "$ns" patch deployment gatekeeper --type=strategic -p "$PATCH"

  # Surface a bad rollout (most likely an amd64-only image on the arm64 pool)
  # immediately instead of silently leaving the preview unreachable.
  if ! kubectl -n "$ns" rollout status deployment gatekeeper --timeout="$ROLLOUT_TIMEOUT"; then
    echo "  WARN: rollout did not complete in $ns within $ROLLOUT_TIMEOUT." >&2
    echo "        Check the pod (likely arm64 image mismatch): kubectl -n $ns get pods -l app=gatekeeper" >&2
    echo "        Roll back with: kubectl -n $ns rollout undo deployment gatekeeper" >&2
  fi
done

echo ""
if $DRY_RUN; then
  echo "Dry-run complete. Re-run with --apply to retrofit."
else
  echo "Done."
fi
