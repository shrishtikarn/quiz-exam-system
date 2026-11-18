#!/bin/bash
# Shared settings for the deployment scripts.
set -euo pipefail

export AWS_REGION="${AWS_REGION:-us-east-1}"
export AWS_DEFAULT_REGION="${AWS_REGION}"
export AWS_PAGER=""

PROJECT_NAME="${PROJECT_NAME:-quiz-exam}"
STORAGE_STACK="${PROJECT_NAME}-storage"
APP_STACK="${PROJECT_NAME}-app"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

log() { printf '[%s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

stack_output() {
  aws cloudformation describe-stacks --stack-name "$1" \
    --query "Stacks[0].Outputs[?OutputKey=='$2'].OutputValue | [0]" --output text
}

stack_exists() {
  aws cloudformation describe-stacks --stack-name "$1" >/dev/null 2>&1
}

artifact_bucket() {
  stack_output "${STORAGE_STACK}" ArtifactBucketName
}

require_aws_session() {
  command -v aws >/dev/null || die "The AWS CLI is not installed here"
  aws sts get-caller-identity >/dev/null 2>&1 \
    || die "AWS credentials are missing or expired. Start the lab and refresh them."
}

# Waits until every in-service instance is healthy behind the load balancer.
wait_for_healthy_targets() {
  local target_group="$1" wanted="$2" timeout_seconds="${3:-1200}" waited=0 healthy
  while [ "${waited}" -lt "${timeout_seconds}" ]; do
    healthy=$(aws elbv2 describe-target-health --target-group-arn "${target_group}" \
      --query "length(TargetHealthDescriptions[?TargetHealth.State=='healthy'])" --output text)
    log "Healthy targets: ${healthy}/${wanted}"
    [ "${healthy}" -ge "${wanted}" ] && return 0
    sleep 20
    waited=$((waited + 20))
  done
  return 1
}
