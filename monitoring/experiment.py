#!/usr/bin/env python3
"""Runs monitored experiments on the deployed stack and records what changed.

Commands
  preview  --name N --set Key=Value ...   show the CloudFormation change set only
  run      --name N [--set Key=Value ...] apply a change, run a load test, export metrics
  reset                                   return changed settings to their defaults
  fail     --name N                       terminate one instance and measure recovery
  observe  --name N -- COMMAND ...        run a command, such as a release, while measuring
  export   --name N --minutes M           export recent CloudWatch metrics only

Results are written to monitoring/runs/<name>/. Needs the AWS CLI and Python 3.9 or newer.
"""
import argparse
import csv
import json
import os
import shutil
import subprocess
import sys
import tarfile
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RUNS = ROOT / "monitoring" / "runs"
PROJECT = os.environ.get("PROJECT_NAME", "quiz-exam")
STACK = f"{PROJECT}-app"
REGION = os.environ.get("AWS_REGION", "us-east-1")
DEFAULT_STAGES = "10:60,30:120,60:180,90:180,0:60"
# Storage is left out because an RDS volume cannot be made smaller.
DEFAULT_SETTINGS = {
    "InstanceType": "t3.micro",
    "MinInstances": "2",
    "TargetCpuPercent": "50",
    "HealthCheckIntervalSeconds": "15",
    "DBInstanceClass": "db.t3.micro",
}


def aws(*args, parse=True):
    command = ["aws", "--region", REGION, *args]
    if parse:
        command += ["--output", "json"]
    output = subprocess.run(command, check=True, capture_output=True, text=True).stdout
    if not parse:
        return output
    return json.loads(output) if output.strip() else {}


def utc_now():
    return datetime.now(timezone.utc)


def iso(moment):
    return moment.strftime("%Y-%m-%dT%H:%M:%SZ")


def write_json(path, value):
    path.write_text(json.dumps(value, indent=2, default=str) + "\n", encoding="utf-8")


def write_csv(path, rows, fields):
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)


def describe_stack():
    return aws("cloudformation", "describe-stacks", "--stack-name", STACK)["Stacks"][0]


def outputs(stack=None):
    stack = stack or describe_stack()
    return {item["OutputKey"]: item["OutputValue"] for item in stack.get("Outputs", [])}


def running_outputs(stack=None):
    """Outputs of a stack whose service is on. Experiments need the load balancer."""
    info = outputs(stack)
    if "LoadBalancerUrl" not in info:
        raise SystemExit("The service is off. Run bash scripts/service.sh on first.")
    return info


def snapshot(info):
    """Records the deployed state so a change can be described from evidence."""
    group = aws("autoscaling", "describe-auto-scaling-groups", "--auto-scaling-group-names", info["AutoScalingGroupName"])["AutoScalingGroups"][0]
    database = aws("rds", "describe-db-instances", "--db-instance-identifier", info["DatabaseIdentifier"])["DBInstances"][0]
    targets = aws("elbv2", "describe-target-health", "--target-group-arn", info["TargetGroupArn"])["TargetHealthDescriptions"]
    target_group = aws("elbv2", "describe-target-groups", "--target-group-arns", info["TargetGroupArn"])["TargetGroups"][0]
    return {
        "capturedAt": iso(utc_now()),
        "desiredCapacity": group["DesiredCapacity"],
        "minSize": group["MinSize"],
        "maxSize": group["MaxSize"],
        "launchTemplateVersion": (group.get("LaunchTemplate") or {}).get("Version"),
        "instances": sorted(
            ({"id": item["InstanceId"], "type": item.get("InstanceType"), "zone": item["AvailabilityZone"], "state": item["LifecycleState"]}
             for item in group["Instances"]),
            key=lambda item: item["id"],
        ),
        "healthyTargets": sum(1 for item in targets if item["TargetHealth"]["State"] == "healthy"),
        "healthCheckIntervalSeconds": target_group["HealthCheckIntervalSeconds"],
        "database": {
            "identifier": database["DBInstanceIdentifier"],
            "class": database["DBInstanceClass"],
            "storageGb": database["AllocatedStorage"],
            "status": database["DBInstanceStatus"],
            "endpoint": database["Endpoint"]["Address"],
            "createdAt": database["InstanceCreateTime"],
        },
    }


def compare(before, after):
    old_ids = {item["id"] for item in before["instances"]}
    new_ids = {item["id"] for item in after["instances"]}
    changes = {
        "instancesKept": len(old_ids & new_ids),
        "instancesAdded": len(new_ids - old_ids),
        "instancesRemoved": len(old_ids - new_ids),
        "instanceTypesBefore": sorted({item["type"] for item in before["instances"]}),
        "instanceTypesAfter": sorted({item["type"] for item in after["instances"]}),
        "databaseReplaced": before["database"]["createdAt"] != after["database"]["createdAt"],
    }
    for label, field in (("desiredCapacity", "desiredCapacity"), ("launchTemplateVersion", "launchTemplateVersion"),
                         ("healthCheckIntervalSeconds", "healthCheckIntervalSeconds")):
        changes[f"{label}Before"] = before[field]
        changes[f"{label}After"] = after[field]
    changes["databaseClassBefore"] = before["database"]["class"]
    changes["databaseClassAfter"] = after["database"]["class"]
    changes["databaseStorageBefore"] = before["database"]["storageGb"]
    changes["databaseStorageAfter"] = after["database"]["storageGb"]
    return changes


class Probe(threading.Thread):
    """Requests the health endpoints once a second to measure user-visible interruption."""

    def __init__(self, base_url):
        super().__init__(daemon=True)
        self.base_url = base_url.rstrip("/")
        self.samples = []
        self.stop_event = threading.Event()

    def check(self, path):
        started = time.monotonic()
        try:
            with urllib.request.urlopen(self.base_url + path, timeout=3) as response:
                body = json.loads(response.read().decode())
                return response.status == 200, round((time.monotonic() - started) * 1000, 1), body
        except (urllib.error.URLError, TimeoutError, ValueError, OSError):
            return False, round((time.monotonic() - started) * 1000, 1), {}

    def run(self):
        while not self.stop_event.is_set():
            cycle_started = time.monotonic()
            app_ok, app_ms, body = self.check("/health")
            database_ok, database_ms, _ = self.check("/health/db")
            self.samples.append({
                "time": iso(utc_now()), "appOk": int(app_ok), "appMs": app_ms,
                "databaseOk": int(database_ok), "databaseMs": database_ms,
                "instance": body.get("instance", ""), "version": body.get("version", ""),
            })
            self.stop_event.wait(max(0.0, 1.0 - (time.monotonic() - cycle_started)))

    def finish(self):
        self.stop_event.set()
        self.join(timeout=10)
        return self.samples


def longest_failure(samples, field):
    longest = current = 0
    for sample in samples:
        current = current + 1 if not sample[field] else 0
        longest = max(longest, current)
    return longest


def probe_summary(samples):
    count = len(samples) or 1
    return {
        "probeSamples": len(samples),
        "appFailedChecks": sum(1 for item in samples if not item["appOk"]),
        "appAvailabilityPercent": round(100 * sum(item["appOk"] for item in samples) / count, 3),
        "appLongestOutageChecks": longest_failure(samples, "appOk"),
        "databaseFailedChecks": sum(1 for item in samples if not item["databaseOk"]),
        "databaseAvailabilityPercent": round(100 * sum(item["databaseOk"] for item in samples) / count, 3),
        "databaseLongestOutageChecks": longest_failure(samples, "databaseOk"),
    }


PROBE_FIELDS = ["time", "appOk", "appMs", "databaseOk", "databaseMs", "instance", "version"]


def parse_settings(pairs):
    settings = {}
    for pair in pairs or []:
        if "=" not in pair:
            raise SystemExit(f"Expected Key=Value, got {pair}")
        key, value = pair.split("=", 1)
        settings[key] = value
    return settings


def create_change_set(name, settings, run_dir):
    stack = describe_stack()
    known = {item["ParameterKey"] for item in stack["Parameters"]}
    unknown = set(settings) - known
    if unknown:
        raise SystemExit(f"Unknown template parameters: {', '.join(sorted(unknown))}")

    parameters = [
        f"ParameterKey={key},ParameterValue={settings[key]}" if key in settings else f"ParameterKey={key},UsePreviousValue=true"
        for key in sorted(known)
    ]
    change_set = f"{name}-{int(time.time())}".replace("_", "-")
    aws("cloudformation", "create-change-set", "--stack-name", STACK, "--change-set-name", change_set,
        "--use-previous-template", "--capabilities", "CAPABILITY_IAM", "--parameters", *parameters)
    while True:
        details = aws("cloudformation", "describe-change-set", "--stack-name", STACK, "--change-set-name", change_set)
        if details["Status"] in ("CREATE_COMPLETE", "FAILED"):
            break
        time.sleep(3)
    write_json(run_dir / "changeset.json", details)

    rows = []
    for change in details.get("Changes", []):
        resource = change["ResourceChange"]
        rows.append({
            "resource": resource["LogicalResourceId"],
            "type": resource["ResourceType"],
            "action": resource["Action"],
            "replacement": resource.get("Replacement", ""),
            "scope": "|".join(resource.get("Scope", [])),
            "changedProperties": "|".join(sorted({
                detail["Target"].get("Name", "") for detail in resource.get("Details", []) if detail["Target"].get("Name")
            })),
        })
    write_csv(run_dir / "changes.csv", rows, ["resource", "type", "action", "replacement", "scope", "changedProperties"])
    for row in rows:
        print(f"  {row['action']:<7} replacement={row['replacement'] or '-':<12} {row['resource']} ({row['type']}) {row['changedProperties']}")
    if not rows:
        print(f"  No resource changes: {details.get('StatusReason', '')}")
    return change_set, details, rows


def wait_for_stack(timeout_seconds=3600):
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        status = describe_stack()["StackStatus"]
        if not status.endswith("_IN_PROGRESS"):
            return status
        time.sleep(15)
    raise TimeoutError("The stack update did not finish in time")


def wait_for_capacity(info, timeout_seconds=1200):
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        state = snapshot(info)
        if state["healthyTargets"] >= state["desiredCapacity"] and state["database"]["status"] == "available":
            return state
        time.sleep(15)
    return snapshot(info)


def save_events(run_dir, since):
    events = aws("cloudformation", "describe-stack-events", "--stack-name", STACK)["StackEvents"]
    rows = []
    for event in events:
        moment = datetime.fromisoformat(event["Timestamp"].replace("Z", "+00:00"))
        if moment >= since:
            rows.append({
                "time": iso(moment), "resource": event["LogicalResourceId"], "type": event["ResourceType"],
                "status": event["ResourceStatus"], "reason": event.get("ResourceStatusReason", ""),
            })
    write_csv(run_dir / "events.csv", list(reversed(rows)), ["time", "resource", "type", "status", "reason"])


def find_node():
    node = shutil.which("node")
    if node:
        return node
    cached = ROOT / ".cache" / "node" / "runtime" / "bin" / "node"
    if cached.exists():
        return str(cached)
    releases = sorted((ROOT / "dist").glob("*.tar.gz"), key=lambda item: item.stat().st_mtime, reverse=True)
    if not releases:
        raise SystemExit("Node.js was not found. Install it, or run scripts/build-release.sh first.")
    cached.parent.parent.parent.mkdir(parents=True, exist_ok=True)
    with tarfile.open(releases[0]) as archive:
        archive.extract("./runtime/bin/node", cached.parent.parent.parent)
    return str(cached)


def demo_password(info):
    secret = aws("secretsmanager", "get-secret-value", "--secret-id", info["DemoSecretArn"])["SecretString"]
    return json.loads(secret)["password"]


def run_load_test(info, run_dir, stages):
    environment = dict(os.environ, DEMO_PASSWORD=demo_password(info))
    subprocess.run([
        find_node(), str(ROOT / "monitoring" / "loadtest.js"),
        "--url", info["LoadBalancerUrl"], "--stages", stages, "--out", str(run_dir / "loadtest.json"),
    ], check=True, env=environment)
    return json.loads((run_dir / "loadtest.json").read_text(encoding="utf-8"))


def metric_definitions(info):
    alb = [{"Name": "LoadBalancer", "Value": info["LoadBalancerFullName"]}]
    target = alb + [{"Name": "TargetGroup", "Value": info["TargetGroupFullName"]}]
    group = [{"Name": "AutoScalingGroupName", "Value": info["AutoScalingGroupName"]}]
    database = [{"Name": "DBInstanceIdentifier", "Value": info["DatabaseIdentifier"]}]
    return [
        ("requests", "AWS/ApplicationELB", "RequestCount", alb, "Sum"),
        ("response_avg_seconds", "AWS/ApplicationELB", "TargetResponseTime", alb, "Average"),
        ("response_p95_seconds", "AWS/ApplicationELB", "TargetResponseTime", alb, "p95"),
        ("target_5xx", "AWS/ApplicationELB", "HTTPCode_Target_5XX_Count", alb, "Sum"),
        ("elb_5xx", "AWS/ApplicationELB", "HTTPCode_ELB_5XX_Count", alb, "Sum"),
        ("healthy_targets", "AWS/ApplicationELB", "HealthyHostCount", target, "Minimum"),
        ("unhealthy_targets", "AWS/ApplicationELB", "UnHealthyHostCount", target, "Maximum"),
        ("web_cpu_percent", "AWS/EC2", "CPUUtilization", group, "Average"),
        ("web_cpu_max_percent", "AWS/EC2", "CPUUtilization", group, "Maximum"),
        ("web_network_in_bytes", "AWS/EC2", "NetworkIn", group, "Sum"),
        ("web_network_out_bytes", "AWS/EC2", "NetworkOut", group, "Sum"),
        ("instances_in_service", "AWS/AutoScaling", "GroupInServiceInstances", group, "Maximum"),
        ("web_memory_percent", "QuizExam/Host", "mem_used_percent", group, "Average"),
        ("db_cpu_percent", "AWS/RDS", "CPUUtilization", database, "Average"),
        ("db_connections", "AWS/RDS", "DatabaseConnections", database, "Maximum"),
        ("db_free_memory_bytes", "AWS/RDS", "FreeableMemory", database, "Minimum"),
        ("db_read_iops", "AWS/RDS", "ReadIOPS", database, "Average"),
        ("db_write_iops", "AWS/RDS", "WriteIOPS", database, "Average"),
        ("db_read_latency_seconds", "AWS/RDS", "ReadLatency", database, "Average"),
        ("db_write_latency_seconds", "AWS/RDS", "WriteLatency", database, "Average"),
        ("exams_submitted", "QuizExam/App", "ExamsSubmitted", [], "Sum"),
        ("login_failures", "QuizExam/App", "LoginFailures", [], "Sum"),
        ("app_latency_avg_ms", "QuizExam/App", "ApiLatency", [], "Average"),
    ]


def export_metrics(info, run_dir, start, end):
    definitions = metric_definitions(info)
    queries = [{
        "Id": f"m{index}",
        "Label": label,
        "MetricStat": {
            "Metric": {"Namespace": namespace, "MetricName": metric, "Dimensions": dimensions},
            "Period": 60,
            "Stat": statistic,
        },
    } for index, (label, namespace, metric, dimensions, statistic) in enumerate(definitions)]
    query_file = run_dir / "metric-queries.json"
    write_json(query_file, queries)

    rows = {}
    token = None
    while True:
        command = ["cloudwatch", "get-metric-data", "--metric-data-queries", f"file://{query_file}",
                   "--start-time", iso(start), "--end-time", iso(end), "--scan-by", "TimestampAscending"]
        if token:
            command += ["--next-token", token]
        response = aws(*command)
        for result in response.get("MetricDataResults", []):
            for moment, value in zip(result.get("Timestamps", []), result.get("Values", [])):
                rows.setdefault(moment, {"time": moment})[result["Label"]] = round(value, 6)
        token = response.get("NextToken")
        if not token:
            break
    query_file.unlink()
    fields = ["time"] + [definition[0] for definition in definitions]
    write_csv(run_dir / "metrics.csv", [rows[key] for key in sorted(rows)], fields)
    print(f"Exported {len(rows)} minutes of metrics to {run_dir / 'metrics.csv'}")


def prepare_run(name):
    run_dir = RUNS / name
    run_dir.mkdir(parents=True, exist_ok=True)
    return run_dir


def command_preview(args):
    run_dir = prepare_run(args.name)
    change_set, details, _ = create_change_set(args.name, parse_settings(args.set), run_dir)
    aws("cloudformation", "delete-change-set", "--stack-name", STACK, "--change-set-name", change_set, parse=False)
    write_json(run_dir / "summary.json", {
        "name": args.name, "kind": "preview", "settings": parse_settings(args.set),
        "changeSetStatus": details["Status"], "applied": False,
    })
    print("Preview only. Nothing was changed.")


def apply_change(name, settings, run_dir, info, before, settle):
    change_set, details, rows = create_change_set(name, settings, run_dir)
    if details["Status"] == "FAILED":
        aws("cloudformation", "delete-change-set", "--stack-name", STACK, "--change-set-name", change_set, parse=False)
        if "didn't contain changes" in details.get("StatusReason", "") or "No updates" in details.get("StatusReason", ""):
            return {"resourceChanges": [], "stackStatus": "UPDATE_COMPLETE", "noChange": True}
        raise SystemExit(f"Change set failed: {details.get('StatusReason')}")

    probe = Probe(info["LoadBalancerUrl"])
    probe.start()
    change_started = utc_now()
    aws("cloudformation", "execute-change-set", "--stack-name", STACK, "--change-set-name", change_set, parse=False)
    time.sleep(10)
    final_status = wait_for_stack()
    stack_finished = utc_now()
    after_change = wait_for_capacity(info)
    recovered = utc_now()
    time.sleep(settle)
    samples = probe.finish()
    write_csv(run_dir / "probe.csv", samples, PROBE_FIELDS)
    save_events(run_dir, change_started)
    return {
        "resourceChanges": rows,
        "stackStatus": final_status,
        "changeStartedAt": iso(change_started),
        "stackUpdateSeconds": round((stack_finished - change_started).total_seconds()),
        "secondsUntilHealthy": round((recovered - change_started).total_seconds()),
        **probe_summary(samples),
        "observedChange": compare(before, after_change),
    }


def command_reset(args):
    run_dir = prepare_run("_reset")
    stack = describe_stack()
    current = {item["ParameterKey"]: item.get("ParameterValue") for item in stack["Parameters"]}
    settings = {key: value for key, value in DEFAULT_SETTINGS.items() if key in current and current[key] != value}
    info = outputs(stack)
    if settings:
        result = apply_change("reset", settings, run_dir, info, snapshot(info), args.settle)
        print(f"Settings reset with status {result['stackStatus']}")
    # A load test can leave extra instances running, which would distort the next experiment.
    wanted = int(DEFAULT_SETTINGS["MinInstances"])
    if snapshot(info)["desiredCapacity"] != wanted:
        aws("autoscaling", "set-desired-capacity", "--auto-scaling-group-name", info["AutoScalingGroupName"],
            "--desired-capacity", str(wanted), parse=False)
        time.sleep(args.settle)
    state = wait_for_capacity(info)
    print(f"Ready with {state['healthyTargets']} healthy instances")


def command_observe(args):
    command = args.cmd[1:] if args.cmd[:1] == ["--"] else args.cmd
    if not command:
        raise SystemExit("Give a command after --")
    run_dir = prepare_run(args.name)
    info = running_outputs()
    before = snapshot(info)
    write_json(run_dir / "before.json", before)
    probe = Probe(info["LoadBalancerUrl"])
    probe.start()
    started = utc_now()
    result = subprocess.run(command, cwd=ROOT, check=False)
    finished = utc_now()
    after = wait_for_capacity(info)
    time.sleep(args.settle)
    samples = probe.finish()
    write_json(run_dir / "after.json", after)
    write_csv(run_dir / "probe.csv", samples, PROBE_FIELDS)
    versions = sorted({sample["version"] for sample in samples if sample["version"]})
    write_json(run_dir / "summary.json", {
        "name": args.name, "kind": "operation", "command": command, "exitCode": result.returncode,
        "changeStartedAt": iso(started), "stackUpdateSeconds": round((finished - started).total_seconds()),
        "versionsSeen": versions, **probe_summary(samples), "observedChange": compare(before, after),
    })
    print(f"Command exited with {result.returncode}. Results are in {run_dir}")


def command_run(args):
    run_dir = prepare_run(args.name)
    settings = parse_settings(args.set)
    stack = describe_stack()
    info = running_outputs(stack)
    before = snapshot(info)
    write_json(run_dir / "before.json", before)
    summary = {"name": args.name, "kind": "change" if settings else "baseline", "settings": settings}
    window_start = utc_now()

    if settings:
        summary.update(apply_change(args.name, settings, run_dir, info, before, args.settle))
        if summary["stackStatus"] != "UPDATE_COMPLETE":
            write_json(run_dir / "summary.json", summary)
            raise SystemExit(f"The stack finished as {summary['stackStatus']}")

    if args.skip_load:
        write_json(run_dir / "after.json", snapshot(info))
        write_json(run_dir / "summary.json", summary)
        print(f"Results are in {run_dir}")
        return

    load_started = utc_now()
    load = run_load_test(info, run_dir, args.stages)
    summary.update({"loadStartedAt": load["startedAt"], "loadEndedAt": load["endedAt"], "load": load["totals"]})
    after = snapshot(info)
    write_json(run_dir / "after.json", after)
    print(f"Waiting {args.metrics_delay} seconds for CloudWatch to publish the data")
    time.sleep(args.metrics_delay)
    export_metrics(info, run_dir, min(window_start, load_started) - timedelta(minutes=5), utc_now())
    write_json(run_dir / "summary.json", summary)
    print(f"Results are in {run_dir}")


def command_fail(args):
    run_dir = prepare_run(args.name)
    info = running_outputs()
    before = snapshot(info)
    write_json(run_dir / "before.json", before)
    in_service = [item for item in before["instances"] if item["state"] == "InService"]
    if len(in_service) < 2:
        raise SystemExit("At least two instances are needed for this test")
    victim = in_service[0]["id"]
    probe = Probe(info["LoadBalancerUrl"])
    probe.start()
    time.sleep(10)
    started = utc_now()
    print(f"Terminating {victim}")
    aws("ec2", "terminate-instances", "--instance-ids", victim)
    time.sleep(30)
    after = wait_for_capacity(info)
    recovered = utc_now()
    time.sleep(args.settle)
    samples = probe.finish()
    write_json(run_dir / "after.json", after)
    write_csv(run_dir / "probe.csv", samples, PROBE_FIELDS)
    summary = {
        "name": args.name, "kind": "failure", "terminatedInstance": victim, "changeStartedAt": iso(started),
        "secondsUntilHealthy": round((recovered - started).total_seconds()),
        **probe_summary(samples), "observedChange": compare(before, after),
    }
    write_json(run_dir / "summary.json", summary)
    time.sleep(args.metrics_delay)
    export_metrics(info, run_dir, started - timedelta(minutes=5), utc_now())
    print(json.dumps({key: summary[key] for key in ("secondsUntilHealthy", "appFailedChecks", "appLongestOutageChecks")}))


def command_export(args):
    run_dir = prepare_run(args.name)
    end = utc_now()
    export_metrics(outputs(), run_dir, end - timedelta(minutes=args.minutes), end)


def build_parser():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    commands = parser.add_subparsers(dest="command", required=True)

    preview = commands.add_parser("preview")
    preview.add_argument("--name", required=True)
    preview.add_argument("--set", nargs="+", required=True)
    preview.set_defaults(handler=command_preview)

    run = commands.add_parser("run")
    run.add_argument("--name", required=True)
    run.add_argument("--set", nargs="*", default=[])
    run.add_argument("--stages", default=DEFAULT_STAGES)
    run.add_argument("--settle", type=int, default=120)
    run.add_argument("--metrics-delay", type=int, default=240)
    run.add_argument("--skip-load", action="store_true")
    run.set_defaults(handler=command_run)

    reset = commands.add_parser("reset")
    reset.add_argument("--settle", type=int, default=60)
    reset.set_defaults(handler=command_reset)

    observe = commands.add_parser("observe")
    observe.add_argument("--name", required=True)
    observe.add_argument("--settle", type=int, default=30)
    observe.add_argument("cmd", nargs=argparse.REMAINDER)
    observe.set_defaults(handler=command_observe)

    fail = commands.add_parser("fail")
    fail.add_argument("--name", required=True)
    fail.add_argument("--settle", type=int, default=60)
    fail.add_argument("--metrics-delay", type=int, default=240)
    fail.set_defaults(handler=command_fail)

    export = commands.add_parser("export")
    export.add_argument("--name", required=True)
    export.add_argument("--minutes", type=int, default=60)
    export.set_defaults(handler=command_export)
    return parser


def main():
    args = build_parser().parse_args()
    try:
        args.handler(args)
    except subprocess.CalledProcessError as error:
        print(f"AWS command failed: {' '.join(error.cmd[:4])}\n{error.stderr}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
