#!/bin/bash
# Creates or updates the whole environment. Run it in AWS CloudShell or the Learner Lab terminal.
# Usage:
#   bash scripts/deploy.sh                    create everything with the website running
#   bash scripts/deploy.sh ServiceMode=off    create everything, but leave it switched off
#   bash scripts/deploy.sh Name=value ...     change any other template parameter
source "$(dirname "$0")/lib.sh"

cd "${REPO_ROOT}"
require_aws_session

account=$(describe_account)
log "Account: ${account}"
log "Region: ${AWS_REGION}"
if [ "${account}" = "AWS Academy Learner Lab" ]; then
  [ "${AWS_REGION}" = "us-east-1" ] || [ "${AWS_REGION}" = "us-west-2" ] \
    || die "Learner Lab supports us-east-1 and us-west-2 only"
elif [ "${AWS_REGION}" != "us-east-1" ]; then
  log "Note: the cost estimates in the report are for us-east-1 (N. Virginia)."
fi
check_vcpu_quota

mode=$(requested_service_mode "$@")
# A stack left over from a failed or unfinished first attempt counts as new.
stack_already_exists=false
case "$(stack_status "${APP_STACK}")" in
  CREATE_COMPLETE | UPDATE_COMPLETE | UPDATE_ROLLBACK_COMPLETE) stack_already_exists=true ;;
esac

log "Step 1 of 4: storage stack"
prepare_stack_for_deploy "${STORAGE_STACK}"
aws cloudformation deploy --stack-name "${STORAGE_STACK}" --template-file infra/00-storage.yaml \
  --parameter-overrides "ProjectName=${PROJECT_NAME}" --no-fail-on-empty-changeset \
  || { print_stack_failures "${STORAGE_STACK}"; die "The storage stack did not deploy."; }
bucket=$(artifact_bucket)
running_release=$(aws s3 cp "s3://${bucket}/releases/current" - 2>/dev/null | tr -d '[:space:]' || true)

log "Step 2 of 4: application release"
version="$(git rev-parse --short=12 HEAD 2>/dev/null || date -u +%Y%m%d%H%M%S)"
if [ ! -f "dist/${version}.tar.gz" ]; then
  bash scripts/build-release.sh "${version}"
fi
if [ "${stack_already_exists}" = false ] || [ -z "${running_release}" ]; then
  bash scripts/release.sh "${version}" --publish-only
fi

log "Step 3 of 4: application stack, ServiceMode=${mode} (a new database takes about 10 minutes)"
if [ "${mode}" = on ] && [ "${stack_already_exists}" = true ]; then
  start_database
fi
deploy_app_stack "$@"

log "Step 4 of 4: finishing"
url=$(stack_output "${APP_STACK}" AppUrl)
if [ "${mode}" = off ]; then
  stop_database
  cat <<SUMMARY

All services are in place and switched OFF.
  Web servers: 0     Load balancer: removed     Database: stopped
  Estimated cost while off: about \$${COST_OFF_PER_HOUR} an hour.

Turn the website on:   bash scripts/service.sh on
Check the state:       bash scripts/service.sh status
SUMMARY
  exit 0
fi

if [ "${stack_already_exists}" = true ] && [ "${running_release}" != "${version}" ]; then
  bash scripts/release.sh "${version}"
fi
wait_until_service_is_up

cat <<SUMMARY

The exam system is live at: ${url}

Demo accounts: tutor@demo.quiz, parent@demo.quiz, student001@demo.quiz to student100@demo.quiz
Show the demo password with:   bash scripts/service.sh password

Estimated cost while on: about \$${COST_ON_PER_HOUR} an hour.
Switch it off when you finish:   bash scripts/service.sh off
Delete everything:               bash scripts/teardown.sh
SUMMARY
