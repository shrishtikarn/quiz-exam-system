#!/bin/bash
# Creates or updates the whole environment. Run it from the Learner Lab terminal.
# Usage: scripts/deploy.sh [ParameterName=value ...]
source "$(dirname "$0")/lib.sh"

cd "${REPO_ROOT}"
require_aws_session

[ "${AWS_REGION}" = "us-east-1" ] || [ "${AWS_REGION}" = "us-west-2" ] \
  || die "Learner Lab supports us-east-1 and us-west-2 only"

if ! aws iam get-instance-profile --instance-profile-name LabInstanceProfile >/dev/null 2>&1; then
  log "Warning: could not confirm LabInstanceProfile. Continuing, because the lab may hide this check."
fi

stack_already_exists=false
stack_exists "${APP_STACK}" && stack_already_exists=true

log "Step 1 of 4: storage stack"
aws cloudformation deploy --stack-name "${STORAGE_STACK}" --template-file infra/00-storage.yaml \
  --parameter-overrides "ProjectName=${PROJECT_NAME}" --no-fail-on-empty-changeset
bucket=$(artifact_bucket)
running_release=$(aws s3 cp "s3://${bucket}/releases/current" - 2>/dev/null | tr -d '[:space:]' || true)

log "Step 2 of 4: application release"
version="$(git rev-parse --short=12 HEAD 2>/dev/null || date -u +%Y%m%d%H%M%S)"
if [ ! -f "dist/${version}.tar.gz" ]; then
  bash scripts/build-release.sh "${version}"
fi
if [ "${stack_already_exists}" = false ]; then
  bash scripts/release.sh "${version}" --publish-only
fi

log "Step 3 of 4: application stack (a new database takes about 10 minutes)"
aws cloudformation deploy --stack-name "${APP_STACK}" --template-file infra/10-app.yaml \
  --parameter-overrides "ProjectName=${PROJECT_NAME}" "ArtifactBucket=${bucket}" "$@" \
  --no-fail-on-empty-changeset

log "Step 4 of 4: bringing instances up to date"
if [ "${stack_already_exists}" = true ] && [ "${running_release}" != "${version}" ]; then
  bash scripts/release.sh "${version}"
fi
target_group=$(stack_output "${APP_STACK}" TargetGroupArn)
group=$(stack_output "${APP_STACK}" AutoScalingGroupName)
wanted=$(aws autoscaling describe-auto-scaling-groups --auto-scaling-group-names "${group}" \
  --query 'AutoScalingGroups[0].DesiredCapacity' --output text)
wait_for_healthy_targets "${target_group}" "${wanted}" 900 \
  || die "Instances did not become healthy. Run bash scripts/status.sh to see why."

url=$(stack_output "${APP_STACK}" AppUrl)
secret=$(stack_output "${APP_STACK}" DemoSecretArn)
cat <<SUMMARY

The exam system is live at: ${url}

Demo accounts: tutor@demo.quiz, parent@demo.quiz, student001@demo.quiz to student100@demo.quiz
Show the demo password with:
  aws secretsmanager get-secret-value --secret-id ${secret} --query SecretString --output text

Delete the stack when you finish a session, to protect the budget:
  bash scripts/teardown.sh
SUMMARY
