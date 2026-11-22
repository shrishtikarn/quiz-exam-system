#!/bin/bash
# Switches the deployed website on or off without deleting any service.
# Usage:
#   bash scripts/service.sh status
#   bash scripts/service.sh on     start the database, load balancer and web servers
#   bash scripts/service.sh off    remove the load balancer, run 0 web servers, stop the database
#   bash scripts/service.sh password   show the demo account password
source "$(dirname "$0")/lib.sh"

cd "${REPO_ROOT}"
require_aws_session
stack_exists "${APP_STACK}" || die "Nothing is deployed yet. Run bash scripts/deploy.sh first."

show_status() {
  local mode id db group instances url
  mode=$(stack_parameter "${APP_STACK}" ServiceMode)
  id=$(database_id)
  db=$(database_status "${id}")
  group=$(stack_output "${APP_STACK}" AutoScalingGroupName)
  instances=$(aws autoscaling describe-auto-scaling-groups --auto-scaling-group-names "${group}" \
    --query 'length(AutoScalingGroups[0].Instances)' --output text 2>/dev/null || echo unknown)
  url=$(stack_output "${APP_STACK}" AppUrl)
  echo "Service mode:  ${mode}"
  echo "Web servers:   ${instances}"
  echo "Database:      ${db}"
  echo "Website:       ${url}"
  if [ "${mode}" = on ]; then
    echo "Approximate cost: \$${COST_ON_PER_HOUR} an hour while on"
  else
    echo "Approximate cost: \$${COST_OFF_PER_HOUR} an hour while off"
  fi
  if [ "${mode}" = off ] && [ "${db}" = available ]; then
    echo
    echo "Warning: the database is running while the service is off."
    echo "AWS restarts a stopped database after 7 days. Run bash scripts/service.sh off again to stop it."
  fi
}

case "${1:-status}" in
  status)
    show_status
    ;;
  on)
    log "Turning the service ON"
    start_database
    deploy_app_stack ServiceMode=on
    wait_until_service_is_up
    echo
    echo "The website is ON at: $(stack_output "${APP_STACK}" AppUrl)"
    echo "The address changes each time the service is turned on."
    echo "Turn it off when you finish: bash scripts/service.sh off"
    ;;
  off)
    log "Turning the service OFF"
    deploy_app_stack ServiceMode=off
    stop_database
    echo
    echo "The service is OFF. Every service is still in place."
    echo "Web servers: 0. Load balancer: removed. Database: stopped. Data is kept."
    echo "AWS restarts a stopped database after 7 days, so run this command again within a week,"
    echo "or delete everything with bash scripts/teardown.sh if you no longer need it."
    ;;
  password)
    aws secretsmanager get-secret-value --secret-id "$(stack_output "${APP_STACK}" DemoSecretArn)" \
      --query SecretString --output text | python3 -c 'import json,sys; print(json.load(sys.stdin)["password"])'
    ;;
  *)
    die "Usage: bash scripts/service.sh on | off | status | password"
    ;;
esac
