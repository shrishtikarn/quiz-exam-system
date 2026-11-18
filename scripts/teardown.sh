#!/bin/bash
# Deletes the application stack, including the database and its data.
# Usage: scripts/teardown.sh [--yes] [--all]
#   --all also empties and deletes the artifact bucket.
source "$(dirname "$0")/lib.sh"

assume_yes=false
delete_storage=false
for argument in "$@"; do
  case "${argument}" in
    --yes) assume_yes=true ;;
    --all) delete_storage=true ;;
    *) die "Unknown option: ${argument}" ;;
  esac
done

require_aws_session

if [ "${assume_yes}" = false ]; then
  printf 'This permanently deletes the exam database and all results. Type DELETE to continue: '
  read -r answer
  [ "${answer}" = "DELETE" ] || die "Nothing was deleted"
fi

if stack_exists "${APP_STACK}"; then
  log "Deleting ${APP_STACK} (this can take 10 minutes)"
  aws cloudformation delete-stack --stack-name "${APP_STACK}"
  aws cloudformation wait stack-delete-complete --stack-name "${APP_STACK}"
fi

if [ "${delete_storage}" = true ] && stack_exists "${STORAGE_STACK}"; then
  bucket=$(artifact_bucket)
  log "Emptying ${bucket}"
  python3 - "${bucket}" <<'PYTHON'
import json
import subprocess
import sys

bucket = sys.argv[1]
while True:
    listing = json.loads(subprocess.check_output([
        "aws", "s3api", "list-object-versions", "--bucket", bucket, "--max-items", "500", "--output", "json",
    ]) or b"{}")
    items = listing.get("Versions", []) + listing.get("DeleteMarkers", [])
    if not items:
        break
    payload = {"Objects": [{"Key": i["Key"], "VersionId": i["VersionId"]} for i in items[:500]], "Quiet": True}
    subprocess.check_call([
        "aws", "s3api", "delete-objects", "--bucket", bucket, "--delete", json.dumps(payload),
    ], stdout=subprocess.DEVNULL)
PYTHON
  log "Deleting ${STORAGE_STACK}"
  aws cloudformation delete-stack --stack-name "${STORAGE_STACK}"
  aws cloudformation wait stack-delete-complete --stack-name "${STORAGE_STACK}"
fi

log "Teardown complete"
