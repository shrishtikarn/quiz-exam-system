#!/bin/bash
# Publishes a built release and rolls it out without downtime.
# Usage:
#   scripts/release.sh <version>                 publish, roll out, verify, roll back on failure
#   scripts/release.sh <version> --publish-only  publish without touching running instances
#   scripts/release.sh --rollback                return to the previous release
source "$(dirname "$0")/lib.sh"

REFRESH_TIMEOUT_SECONDS=1500
cd "${REPO_ROOT}"
require_aws_session
bucket=$(artifact_bucket)
[ -n "${bucket}" ] && [ "${bucket}" != "None" ] || die "Deploy the storage stack first"

read_pointer() {
  aws s3 cp "s3://${bucket}/releases/$1" - 2>/dev/null | tr -d '[:space:]' || true
}

write_pointer() {
  printf '%s\n' "$2" | aws s3 cp --only-show-errors - "s3://${bucket}/releases/$1"
}

publish() {
  local version="$1" archive="dist/$1.tar.gz" current
  [ -f "${archive}" ] || die "Missing ${archive}. Run bash scripts/build-release.sh first."
  log "Uploading release ${version}"
  aws s3 cp --only-show-errors "${archive}" "s3://${bucket}/releases/${version}.tar.gz"
  aws s3 cp --only-show-errors infra/bootstrap.sh "s3://${bucket}/bootstrap/bootstrap.sh"
  current=$(read_pointer current)
  if [ -n "${current}" ] && [ "${current}" != "${version}" ]; then
    write_pointer previous "${current}"
  fi
  write_pointer current "${version}"
}

# Used when the lab does not permit instance refresh.
rolling_replace() {
  local group="$1" target_group="$2" wanted instance
  wanted=$(aws autoscaling describe-auto-scaling-groups --auto-scaling-group-names "${group}" \
    --query 'AutoScalingGroups[0].DesiredCapacity' --output text)
  for instance in $(aws autoscaling describe-auto-scaling-groups --auto-scaling-group-names "${group}" \
    --query 'AutoScalingGroups[0].Instances[].InstanceId' --output text); do
    log "Replacing ${instance}"
    aws autoscaling terminate-instance-in-auto-scaling-group --instance-id "${instance}" \
      --no-should-decrement-desired-capacity >/dev/null
    sleep 60
    wait_for_healthy_targets "${target_group}" "${wanted}" 600 || return 1
  done
}

roll_out() {
  local group target_group refresh_id status waited=0
  group=$(stack_output "${APP_STACK}" AutoScalingGroupName)
  target_group=$(stack_output "${APP_STACK}" TargetGroupArn)
  log "Starting a rolling replacement of ${group}"
  if ! refresh_id=$(aws autoscaling start-instance-refresh --auto-scaling-group-name "${group}" \
    --preferences '{"MinHealthyPercentage":100,"MaxHealthyPercentage":200,"InstanceWarmup":180}' \
    --query InstanceRefreshId --output text 2>/dev/null); then
    log "Instance refresh is unavailable, replacing instances one at a time"
    rolling_replace "${group}" "${target_group}"
    return
  fi

  while [ "${waited}" -lt "${REFRESH_TIMEOUT_SECONDS}" ]; do
    status=$(aws autoscaling describe-instance-refreshes --auto-scaling-group-name "${group}" \
      --instance-refresh-ids "${refresh_id}" --query 'InstanceRefreshes[0].Status' --output text)
    log "Instance refresh: ${status}"
    case "${status}" in
      Successful) return 0 ;;
      Failed | Cancelled | RollbackFailed | RollbackSuccessful) return 1 ;;
    esac
    sleep 30
    waited=$((waited + 30))
  done
  aws autoscaling cancel-instance-refresh --auto-scaling-group-name "${group}" >/dev/null 2>&1 || true
  return 1
}

verify() {
  local version="$1" url seen
  url=$(stack_output "${APP_STACK}" LoadBalancerUrl)
  log "Checking that ${url} serves ${version}"
  for _ in $(seq 1 12); do
    seen=$(curl -fsS --max-time 5 "${url}/health" | python3 -c 'import json,sys; print(json.load(sys.stdin)["version"])') || return 1
    [ "${seen}" = "${version}" ] || { log "Found version ${seen}"; return 1; }
    sleep 1
  done
  curl -fsS --max-time 5 "${url}/health/db" >/dev/null
}

rollback() {
  local target
  target=$(read_pointer previous)
  [ -n "${target}" ] || die "There is no previous release"
  log "Rolling back to ${target}"
  write_pointer current "${target}"
  roll_out && verify "${target}"
}

case "${1:-}" in
  "") die "Usage: scripts/release.sh <version> [--publish-only] | --rollback" ;;
  --rollback)
    rollback
    log "Rollback complete"
    ;;
  *)
    version="$1"
    publish "${version}"
    if [ "${2:-}" = "--publish-only" ]; then
      log "Published ${version}"
      exit 0
    fi
    if roll_out && verify "${version}"; then
      log "Release ${version} is live"
    else
      log "Release ${version} failed verification"
      rollback || die "Automatic rollback also failed"
      die "Release ${version} was rolled back"
    fi
    ;;
esac
