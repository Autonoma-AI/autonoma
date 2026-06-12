#!/usr/bin/env bash
# Patch running preview environments to the current STANDARD_RESOURCES tiers
# (canonical values: src/config/index.ts). Existing Deployments/StatefulSets
# keep the resources they were deployed with until their next redeploy; this
# script retrofits them in place:
#
#   app containers:     requests 250m CPU / 512Mi memory, limits 1Gi memory
#   service containers: requests 100m CPU / 256Mi memory, limits 1Gi memory
#   replicas:           clamped to 3
#
# Only previewkit-managed workloads (label previewkit.dev/managed-by) are
# considered, and within them only containers still on the old standard
# (exactly 1 CPU requested) are patched. Fixed-budget containers - the nginx
# proxy (50m), the upstash redis sidecar (50m), temporal (500m) - are left
# alone. Workloads with a previewkit.dev/service label get the service tier;
# everything else gets the app tier.
#
# Patching a pod template rolls the workload, so each patched preview briefly
# restarts (recipe data persists on PVCs). Scaled-to-zero workloads only get
# their template updated and stay at zero.
#
# Defaults to dry-run; pass --apply to patch.
#
# Usage:
#   ./apply-standard-resources.sh [--apply] [--namespace NS]
#
# Options:
#   --apply          Execute the patches (default: dry-run)
#   --namespace NS   Only patch this namespace (default: all preview-*/alpha-*)

set -euo pipefail

APP_CPU="250m";     APP_MEM_REQ="512Mi";     APP_MEM_LIM="1Gi"
SERVICE_CPU="100m"; SERVICE_MEM_REQ="256Mi"; SERVICE_MEM_LIM="1Gi"
MAX_REPLICAS=3

DRY_RUN=true
ONLY_NAMESPACE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --apply)        DRY_RUN=false; shift ;;
    --namespace)    ONLY_NAMESPACE="$2"; shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

echo "Context: $(kubectl config current-context)"
if $DRY_RUN; then
  echo "[DRY-RUN] Pass --apply to execute. Workloads that would be patched:"
else
  echo "[APPLY] Patching workloads to the standard resource tiers"
fi

# {spec:{template:{spec:{containers:[{name, resources}, ...]}}}} for a
# strategic merge patch - containers merge by name, so only the listed ones
# are touched.
build_patch() { # $1 cpu, $2 memory request, $3 memory limit, $4 comma-separated container names
  jq -nc --arg cpu "$1" --arg mreq "$2" --arg mlim "$3" --arg names "$4" \
    '{spec: {template: {spec: {containers: ($names | split(",") | map({
        name: .,
        resources: {requests: {cpu: $cpu, memory: $mreq}, limits: {memory: $mlim}}
      }))}}}}'
}

if [[ -n "$ONLY_NAMESPACE" ]]; then
  namespaces="$ONLY_NAMESPACE"
else
  namespaces=$(kubectl get namespaces -o jsonpath='{.items[*].metadata.name}' | tr ' ' '\n' \
    | grep -E '^(preview|alpha)-' || true)
fi

for ns in $namespaces; do
  # name <TAB> tier <TAB> replicas <TAB> comma-separated names of containers
  # still requesting the old standard (1 CPU; the apiserver canonicalizes
  # "1000m" to "1", check both).
  # `|| true`: a namespace torn down between listing and this get must not
  # abort the sweep (previews churn constantly).
  workloads=$(kubectl get deployments,statefulsets -n "$ns" \
      -l previewkit.dev/managed-by=previewkit -o json 2>/dev/null \
    | jq -r '.items[] | [
        "\(.kind | ascii_downcase)/\(.metadata.name)",
        (if (.metadata.labels["previewkit.dev/service"] // "") != "" then "service" else "app" end),
        (.spec.replicas // 1),
        ([.spec.template.spec.containers[]
          | select(.resources.requests.cpu? // "" | . == "1" or . == "1000m")
          | .name] | join(","))
      ] | @tsv' || true)

  if [[ -z "$workloads" ]]; then
    continue
  fi

  printed_ns=false
  while IFS=$'\t' read -r workload tier replicas containers; do
    if [[ -z "$containers" && "$replicas" -le "$MAX_REPLICAS" ]]; then
      continue
    fi
    if ! $printed_ns; then
      echo ""
      echo "Namespace: $ns"
      printed_ns=true
    fi

    if [[ -n "$containers" ]]; then
      if [[ "$tier" == "service" ]]; then
        patch=$(build_patch "$SERVICE_CPU" "$SERVICE_MEM_REQ" "$SERVICE_MEM_LIM" "$containers")
      else
        patch=$(build_patch "$APP_CPU" "$APP_MEM_REQ" "$APP_MEM_LIM" "$containers")
      fi
      if $DRY_RUN; then
        echo "  [DRY-RUN] PATCH $workload [$containers] -> $tier tier"
      else
        echo "  PATCH $workload [$containers] -> $tier tier"
        kubectl patch "$workload" -n "$ns" --type strategic -p "$patch" \
          || echo "  WARN: patch failed for $ns/$workload, continuing"
      fi
    fi

    if [[ "$replicas" -gt "$MAX_REPLICAS" ]]; then
      if $DRY_RUN; then
        echo "  [DRY-RUN] SCALE $workload (current: $replicas) -> $MAX_REPLICAS"
      else
        echo "  SCALE $workload (current: $replicas) -> $MAX_REPLICAS"
        kubectl scale "$workload" -n "$ns" --replicas="$MAX_REPLICAS" \
          || echo "  WARN: scale failed for $ns/$workload, continuing"
      fi
    fi
  done <<< "$workloads"
done

echo ""
if $DRY_RUN; then
  echo "Dry-run complete. Re-run with --apply to patch."
else
  echo "Done."
fi
