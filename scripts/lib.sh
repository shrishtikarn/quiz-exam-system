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

# Estimates for us-east-1. See scripts/cost_model.py.
COST_ON_PER_HOUR="0.113"
COST_OFF_PER_HOUR="0.005"

log() { printf '[%s] %s\n' "$(date -u +%H:%M:%S)" "$*" >&2; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

stack_output() {
  aws cloudformation describe-stacks --stack-name "$1" \
    --query "Stacks[0].Outputs[?OutputKey=='$2'].OutputValue | [0]" --output text
}

stack_parameter() {
  aws cloudformation describe-stacks --stack-name "$1" \
    --query "Stacks[0].Parameters[?ParameterKey=='$2'].ParameterValue | [0]" --output text 2>/dev/null || true
}

stack_status() {
  aws cloudformation describe-stacks --stack-name "$1" \
    --query 'Stacks[0].StackStatus' --output text 2>/dev/null || echo NONE
}

stack_exists() {
  local status
  status=$(stack_status "$1")
  [ "${status}" != NONE ] && [ "${status}" != DELETE_COMPLETE ]
}

artifact_bucket() {
  stack_output "${STORAGE_STACK}" ArtifactBucketName
}

require_aws_session() {
  command -v aws >/dev/null || die "The AWS CLI is not installed here. Use AWS CloudShell or the Learner Lab terminal."
  aws sts get-caller-identity >/dev/null 2>&1 \
    || die "AWS credentials are missing or expired. Sign in again (or start the lab) and retry."
}

# Learner Lab cannot create IAM roles, but it provides LabInstanceProfile.
# A personal AWS account has no LabInstanceProfile, so the stack creates its own role.
instance_profile_for_account() {
  if [ -n "${INSTANCE_PROFILE:-}" ]; then
    echo "${INSTANCE_PROFILE}"
    return
  fi
  local arn
  arn=$(aws sts get-caller-identity --query Arn --output text 2>/dev/null || true)
  if [[ "${arn}" == *"assumed-role/voclabs"* ]] \
    || aws iam get-instance-profile --instance-profile-name LabInstanceProfile >/dev/null 2>&1; then
    echo LabInstanceProfile
  else
    echo none
  fi
}

describe_account() {
  if [ "$(instance_profile_for_account)" = LabInstanceProfile ]; then
    echo "AWS Academy Learner Lab"
  else
    echo "Personal AWS account"
  fi
}

print_stack_failures() {
  log "Recent CloudFormation failures for $1:"
  aws cloudformation describe-stack-events --stack-name "$1" --max-items 80 \
    --query "StackEvents[?ends_with(ResourceStatus, '_FAILED') && ResourceStatusReason != 'Resource creation cancelled'].[LogicalResourceId,ResourceStatusReason]" \
    --output table >&2 || true
}

wait_for_stack_to_settle() {
  local stack="$1" status
  while :; do
    status=$(stack_status "${stack}")
    case "${status}" in
      *_IN_PROGRESS)
        log "${stack} is ${status}. Waiting for it to finish."
        sleep 20
        ;;
      *)
        echo "${status}"
        return
        ;;
    esac
  done
}

# Leaves the stack in a state that can be created or updated.
prepare_stack_for_deploy() {
  local stack="$1" status
  status=$(wait_for_stack_to_settle "${stack}")
  case "${status}" in
    NONE | DELETE_COMPLETE | CREATE_COMPLETE | UPDATE_COMPLETE | UPDATE_ROLLBACK_COMPLETE | IMPORT_COMPLETE | IMPORT_ROLLBACK_COMPLETE) ;;
    ROLLBACK_COMPLETE | ROLLBACK_FAILED | CREATE_FAILED | DELETE_FAILED)
      print_stack_failures "${stack}"
      log "${stack} could not be created earlier. Deleting the failed attempt so it can be created again."
      aws cloudformation delete-stack --stack-name "${stack}"
      aws cloudformation wait stack-delete-complete --stack-name "${stack}" \
        || die "Could not delete ${stack}. Delete it in the CloudFormation console, then run this again."
      ;;
    UPDATE_ROLLBACK_FAILED)
      die "${stack} is stuck. In the CloudFormation console choose Stack actions > Continue update rollback, then run this again."
      ;;
    *) die "${stack} is in an unexpected state: ${status}" ;;
  esac
}

# Creates or updates the application stack. Extra arguments are Name=value parameter overrides.
deploy_app_stack() {
  local bucket profile
  bucket=$(artifact_bucket)
  [ -n "${bucket}" ] && [ "${bucket}" != "None" ] || die "The storage stack is missing. Run bash scripts/deploy.sh first."
  profile=$(instance_profile_for_account)
  prepare_stack_for_deploy "${APP_STACK}"
  if ! aws cloudformation deploy --stack-name "${APP_STACK}" --template-file "${REPO_ROOT}/infra/10-app.yaml" \
    --capabilities CAPABILITY_IAM \
    --parameter-overrides "ProjectName=${PROJECT_NAME}" "ArtifactBucket=${bucket}" "ExistingInstanceProfile=${profile}" "$@" \
    --no-fail-on-empty-changeset; then
    print_stack_failures "${APP_STACK}"
    die "The application stack did not deploy. The reasons are listed above."
  fi
}

# Returns on or off, reading Name=value arguments first and then the deployed stack.
requested_service_mode() {
  local argument mode=""
  for argument in "$@"; do
    case "${argument}" in
      ServiceMode=*) mode="${argument#ServiceMode=}" ;;
    esac
  done
  if [ -z "${mode}" ] && stack_exists "${APP_STACK}"; then
    mode=$(stack_parameter "${APP_STACK}" ServiceMode)
  fi
  case "${mode}" in
    on | off) echo "${mode}" ;;
    "" | None) echo on ;;
    *) die "ServiceMode must be on or off, not ${mode}" ;;
  esac
}

database_id() {
  stack_output "${APP_STACK}" DatabaseIdentifier
}

database_status() {
  aws rds describe-db-instances --db-instance-identifier "$1" \
    --query 'DBInstances[0].DBInstanceStatus' --output text 2>/dev/null || echo missing
}

start_database() {
  local id status waited=0
  id=$(database_id)
  [ -n "${id}" ] && [ "${id}" != "None" ] || return 0
  while [ "${waited}" -lt 1800 ]; do
    status=$(database_status "${id}")
    case "${status}" in
      available) return 0 ;;
      stopped)
        log "Starting the database (about 5 to 10 minutes)"
        aws rds start-db-instance --db-instance-identifier "${id}" >/dev/null
        ;;
      missing) return 0 ;;
      *) log "Database is ${status}. Waiting." ;;
    esac
    sleep 30
    waited=$((waited + 30))
  done
  die "The database did not become available in 30 minutes"
}

stop_database() {
  local id status waited=0
  id=$(database_id)
  [ -n "${id}" ] && [ "${id}" != "None" ] || return 0
  while [ "${waited}" -lt 1800 ]; do
    status=$(database_status "${id}")
    case "${status}" in
      stopped | stopping | missing) return 0 ;;
      available)
        if aws rds stop-db-instance --db-instance-identifier "${id}" >/dev/null 2>&1; then
          log "The database is stopping. It is not charged per hour while stopped."
          return 0
        fi
        log "The database cannot be stopped yet. Retrying."
        ;;
      *) log "Database is ${status}. Waiting before stopping it." ;;
    esac
    sleep 30
    waited=$((waited + 30))
  done
  die "Could not stop the database. Stop it in the RDS console instead."
}

# Warns when the account may not allow enough t3.micro instances.
check_vcpu_quota() {
  local quota
  quota=$(aws service-quotas get-service-quota --service-code ec2 --quota-code L-1216C47A \
    --query 'Quota.Value' --output text 2>/dev/null || true)
  [ -n "${quota}" ] && [ "${quota}" != "None" ] || return 0
  if [ "${quota%.*}" -lt 8 ]; then
    log "Warning: this account allows ${quota%.*} vCPUs for EC2. Scaling and rolling updates need 8."
    log "Request an increase in Service Quotas for 'Running On-Demand Standard instances', or keep MaxInstances=2."
  fi
}

# Waits until every in-service instance is healthy behind the load balancer.
wait_for_healthy_targets() {
  local target_group="$1" wanted="$2" timeout_seconds="${3:-1200}" waited=0 healthy
  while [ "${waited}" -lt "${timeout_seconds}" ]; do
    healthy=$(aws elbv2 describe-target-health --target-group-arn "${target_group}" \
      --query "length(TargetHealthDescriptions[?TargetHealth.State=='healthy'])" --output text)
    log "Healthy web servers: ${healthy}/${wanted}"
    [ "${healthy}" -ge "${wanted}" ] && return 0
    sleep 20
    waited=$((waited + 20))
  done
  return 1
}

wait_until_service_is_up() {
  local target_group group wanted
  target_group=$(stack_output "${APP_STACK}" TargetGroupArn)
  group=$(stack_output "${APP_STACK}" AutoScalingGroupName)
  wanted=$(aws autoscaling describe-auto-scaling-groups --auto-scaling-group-names "${group}" \
    --query 'AutoScalingGroups[0].DesiredCapacity' --output text)
  log "Waiting for ${wanted} web servers to start (about 5 minutes)"
  wait_for_healthy_targets "${target_group}" "${wanted}" 900 \
    || die "The web servers did not become healthy. Run bash scripts/status.sh to see why."
}
