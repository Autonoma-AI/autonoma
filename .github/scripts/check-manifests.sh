#!/usr/bin/env bash
# Server-side dry-run of Kubernetes manifests against the production cluster.
#
# A manifest can be valid YAML, pass schema validation, and still be impossible
# to apply - a StatefulSet whose volumeClaimTemplates no longer match the live
# object, a field the API server rejects as immutable, a namespace that does not
# exist. Only the API server knows, so the gate here is `apply --dry-run=server`
# rather than anything offline.
#
# The diff is printed for review, not enforced. A PR that changes a manifest is
# supposed to produce one. The reason to surface it is the drift a PR does *not*
# intend: a file that has fallen behind the cluster shows up as unrelated
# removals sitting in the diff next to the real change.
set -euo pipefail

BASE_REF="${BASE_REF:-origin/main}"
# Everything under deployment/ targets the production cluster except this
# subtree, which belongs to the previewkit cluster and would be dry-run against
# the wrong API server.
readonly OTHER_CLUSTER_PREFIX="deployment/previewkit/"
readonly SUMMARY="${GITHUB_STEP_SUMMARY:-/dev/stdout}"

# Namespaced placeholders have to name a namespace that exists or every
# templated manifest fails the dry-run for the wrong reason. Everything else is
# deliberately a dummy: real values are pulled from live Secrets at deploy time
# and must never be fetched into CI logs.
readonly REAL_NAMESPACE="production"
readonly PLACEHOLDER="ci-dry-run-placeholder"

# Derived from the deploy workflows rather than hardcoded, so a manifest that
# starts being templated is picked up here without a second edit. envsubst'd
# files cannot be applied verbatim - their ${VAR} spans would be read as part of
# an image ref or URL.
templated_manifests() {
  grep -rhoE "envsubst[^<]*< *[^ |]*" .github/workflows/ 2>/dev/null |
    grep -oE "deployment/[^ ]*" | sort -u
}

# Substitutes the same spans envsubst would, without needing their real values.
render() {
  sed -E \
    -e "s/\\\$\{(NAMESPACE|TEMPORAL_NAMESPACE)\}/${REAL_NAMESPACE}/g" \
    -e "s/\\\$\{[A-Za-z_][A-Za-z0-9_]*\}/${PLACEHOLDER}/g" \
    "$1"
}

changed_manifests() {
  git diff --name-only --diff-filter=d "${BASE_REF}...HEAD" -- \
    'deployment/**/*.yaml' 'deployment/**/*.yml' | sort -u
}

# Not every YAML under deployment/ is a manifest - Helm values files live there
# too, and kubectl rejects them for having no kind.
skip_reason() {
  case "$1" in
  "$OTHER_CLUSTER_PREFIX"*) echo "previewkit cluster" ;;
  *) grep -qE '^kind:' "$1" || echo "not a manifest" ;;
  esac
}

# Files may be passed explicitly to check a working tree before pushing:
#   .github/scripts/check-manifests.sh deployment/redis/deployment.yaml
main() {
  local -a changed=()
  local line
  if [[ $# -gt 0 ]]; then
    changed=("$@")
  else
    while IFS= read -r line; do
      [[ -n "$line" ]] && changed+=("$line")
    done < <(changed_manifests)
  fi

  if [[ ${#changed[@]} -eq 0 ]]; then
    echo "No manifests changed under deployment/."
    echo "No manifests changed under \`deployment/\`." >>"$SUMMARY"
    return 0
  fi

  local templated
  templated="$(templated_manifests)"

  local -a failed=() skipped=()
  local diffs="" file rendered rc reason

  for file in "${changed[@]}"; do
    reason="$(skip_reason "$file")"
    if [[ -n "$reason" ]]; then
      echo "Skipping $file ($reason)"
      skipped+=("$file ($reason)")
      continue
    fi

    rendered="$(mktemp)"
    render "$file" >"$rendered"

    echo "::group::$file"
    if ! kubectl apply --dry-run=server -f "$rendered"; then
      echo "::error file=$file::Manifest does not apply against the production cluster"
      failed+=("$file")
      echo "::endgroup::"
      rm -f "$rendered"
      continue
    fi

    # Templated manifests are skipped here on purpose: every placeholder reads
    # as a change, so the diff would be noise rather than signal.
    if ! grep -qxF "$file" <<<"$templated"; then
      set +e
      local out
      out="$(kubectl diff -f "$rendered" 2>&1)"
      rc=$?
      set -e
      # 0 = no drift, 1 = drift found, anything higher is a real failure.
      if [[ $rc -gt 1 ]]; then
        echo "$out"
        echo "::error file=$file::kubectl diff failed"
        failed+=("$file")
      elif [[ $rc -eq 1 ]]; then
        echo "$out"
        diffs+=$'\n'"<details><summary><code>${file}</code></summary>"$'\n\n```diff\n'"${out}"$'\n```\n\n</details>\n'
      fi
    fi

    echo "::endgroup::"
    rm -f "$rendered"
  done

  {
    echo "## Manifest dry-run"
    echo
    echo "Checked ${#changed[@]} changed manifest(s) against \`${REAL_NAMESPACE}\`."
    if [[ ${#skipped[@]} -gt 0 ]]; then
      echo
      echo "Skipped:"
      printf -- '- `%s`\n' "${skipped[@]}"
    fi
    if [[ -n "$diffs" ]]; then
      echo
      echo "### Changes this PR would make"
      echo
      echo "Review these for drift the PR did not intend."
      echo "$diffs"
    fi
  } >>"$SUMMARY"

  if [[ ${#failed[@]} -gt 0 ]]; then
    echo
    echo "Manifests that do not apply: ${failed[*]}"
    return 1
  fi

  echo
  echo "All changed manifests apply cleanly."
}

main "$@"
