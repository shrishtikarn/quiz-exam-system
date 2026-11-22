#!/bin/bash
# Shows the state of the deployed environment and recent problems.
source "$(dirname "$0")/lib.sh"

require_aws_session
stack_exists "${APP_STACK}" || die "${APP_STACK} is not deployed"

mode=$(stack_parameter "${APP_STACK}" ServiceMode)
group=$(stack_output "${APP_STACK}" AutoScalingGroupName)
target_group=$(stack_output "${APP_STACK}" TargetGroupArn)
log_group=$(stack_output "${APP_STACK}" ApplicationLogGroupName)
url=$(stack_output "${APP_STACK}" AppUrl)

echo "Stack status:  $(stack_status "${APP_STACK}")"
echo "Service mode:  ${mode}"
echo "Database:      $(database_status "$(database_id)")"
echo "Application:   ${url}"
echo

if [ "${mode}" = on ]; then
  echo "== Application health =="
  curl -sS --max-time 5 "${url}/health" || echo "not reachable"
  echo
  echo
fi
echo "== Auto Scaling instances =="
aws autoscaling describe-auto-scaling-groups --auto-scaling-group-names "${group}" \
  --query 'AutoScalingGroups[0].Instances[].[InstanceId,AvailabilityZone,InstanceType,LifecycleState,HealthStatus]' --output table
if [ "${mode}" = on ]; then
  echo "== Load balancer targets =="
  aws elbv2 describe-target-health --target-group-arn "${target_group}" \
    --query 'TargetHealthDescriptions[].[Target.Id,TargetHealth.State,TargetHealth.Reason]' --output table
fi
echo "== Recent scaling activity =="
aws autoscaling describe-scaling-activities --auto-scaling-group-name "${group}" --max-items 5 \
  --query 'Activities[].[StartTime,StatusCode,Description]' --output table
echo "== Alarms currently firing =="
aws cloudwatch describe-alarms --state-value ALARM --query 'MetricAlarms[].[AlarmName,StateReason]' --output table
echo "== Errors in the last 30 minutes =="
since=$(($(date +%s) - 1800))000
aws logs filter-log-events --log-group-name "${log_group}" --start-time "${since}" \
  --filter-pattern '?http_error ?database_prepare_failed ?db_health_failed ?"did not become healthy" ?"bootstrap] warning"' \
  --max-items 20 --query 'events[].message' --output text || true
