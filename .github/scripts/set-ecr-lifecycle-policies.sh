#!/usr/bin/env bash
set -euo pipefail

AWS_REGION="${AWS_REGION:-us-east-1}"
DRY_RUN="${DRY_RUN:-true}"

if [[ "$DRY_RUN" != "true" && "$DRY_RUN" != "false" ]]; then
  echo "::error::DRY_RUN must be true or false"
  exit 1
fi

TMP_DIR="$(mktemp -d)"
cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

write_policy() {
  local days="$1"
  local policy_file="$2"

  jq -n --argjson days "$days" '
    {
      rules: [
        {
          rulePriority: 1,
          description: ("Archive images not pulled in " + ($days | tostring) + " days"),
          selection: {
            tagStatus: "any",
            countType: "sinceImagePulled",
            countUnit: "days",
            countNumber: $days
          },
          action: {
            type: "transition",
            targetStorageClass: "archive"
          }
        }
      ]
    }
  ' > "$policy_file"
}

# Repository name prefix -> days since last pull before Amazon ECR archives the image
# (lifecycle policy action.type=transition, targetStorageClass=archive).
days_for_repository() {
  local repository="$1"

  case "$repository" in
    beta/*) echo 14 ;;
    production/*) echo 14 ;;
    alpha/*) echo 7 ;;
    docker-hub/*) echo 14 ;;
    previewkit/*) echo 3 ;;
  esac
}

echo "Scanning ECR repositories in ${AWS_REGION}"
echo "Dry run: ${DRY_RUN}"

REPOSITORIES_TEXT="$(aws ecr describe-repositories \
  --region "$AWS_REGION" \
  --query 'repositories[].repositoryName' \
  --output text)"

if [[ -z "$REPOSITORIES_TEXT" ]]; then
  echo "No ECR repositories found"
  exit 0
fi

REPOSITORIES=()
while IFS= read -r repository_name; do
  REPOSITORIES+=("$repository_name")
done < <(printf '%s\n' "$REPOSITORIES_TEXT" | tr '\t' '\n' | sed '/^$/d' | sort)

matched_repositories=0
updated_repositories=0

for repository in "${REPOSITORIES[@]}"; do
  days="$(days_for_repository "$repository")"

  if [[ -z "$days" ]]; then
    continue
  fi

  matched_repositories=$((matched_repositories + 1))
  policy_file="${TMP_DIR}/${repository//\//__}-policy.json"
  write_policy "$days" "$policy_file"

  echo ""
  echo "Repository: ${repository} -> archive images not pulled in ${days} day(s)"

  if [[ "$DRY_RUN" == "true" ]]; then
    cat "$policy_file"
    continue
  fi

  aws ecr put-lifecycle-policy \
    --region "$AWS_REGION" \
    --repository-name "$repository" \
    --lifecycle-policy-text "file://${policy_file}" \
    --output json

  updated_repositories=$((updated_repositories + 1))
done

echo ""
echo "Matched repositories: ${matched_repositories}"
echo "Updated repositories: ${updated_repositories}"
