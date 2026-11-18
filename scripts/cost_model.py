#!/usr/bin/env python3
"""Estimates the cost of the default deployment in us-east-1, in US dollars."""
import json

HOURS_PER_MONTH = 730
BUDGET = 50.0
RESERVE = 10.0

PRICE = {
    "ec2_t3_micro_hour": 0.0104,
    "ec2_t3_small_hour": 0.0208,
    "public_ipv4_hour": 0.005,
    "ebs_gp3_gb_month": 0.08,
    "alb_hour": 0.0225,
    "alb_lcu_hour": 0.008,
    "rds_t3_micro_hour": 0.017,
    "rds_t3_small_hour": 0.034,
    "rds_storage_gb_month": 0.115,
    "secret_month": 0.40,
    "alarm_month": 0.10,
    "custom_metric_month": 0.30,
    "dashboard_month": 3.00,
    "log_ingest_gb": 0.50,
    "s3_gb_month": 0.023,
}

QUANTITY = {
    "web_instances": 2,
    "ebs_gb_each": 8,
    "alb_public_ips": 2,
    "alb_lcu": 1,
    "rds_storage_gb": 20,
    "secrets": 3,
    "alarms": 9,  # 7 in the template plus 2 created by target tracking
    "custom_metrics": 7,  # 4 from log filters, 3 from the CloudWatch agent
    "dashboards": 1,
    "log_gb_per_hour": 0.02,
    "s3_gb": 1,
}


def monthly(value):
    return value / HOURS_PER_MONTH


def hourly_lines():
    p, q = PRICE, QUANTITY
    return [
        ("EC2 t3.micro instances", "2 x $0.0104", q["web_instances"] * p["ec2_t3_micro_hour"], True),
        ("Public IPv4 on instances", "2 x $0.005", q["web_instances"] * p["public_ipv4_hour"], True),
        ("EBS gp3 root volumes", "16 GB x $0.08 per month", monthly(q["web_instances"] * q["ebs_gb_each"] * p["ebs_gp3_gb_month"]), False),
        ("Load balancer hours", "1 x $0.0225", p["alb_hour"], False),
        ("Load balancer capacity", "1 LCU x $0.008 (assumed)", q["alb_lcu"] * p["alb_lcu_hour"], True),
        ("Public IPv4 on load balancer", "2 x $0.005", q["alb_public_ips"] * p["public_ipv4_hour"], False),
        ("RDS db.t3.micro", "1 x $0.017", p["rds_t3_micro_hour"], False),
        ("RDS storage", "20 GB x $0.115 per month", monthly(q["rds_storage_gb"] * p["rds_storage_gb_month"]), False),
        ("Secrets Manager", "3 x $0.40 per month", monthly(q["secrets"] * p["secret_month"]), False),
        ("CloudWatch alarms", "9 x $0.10 per month", monthly(q["alarms"] * p["alarm_month"]), False),
        ("CloudWatch custom metrics", "7 x $0.30 per month", monthly(q["custom_metrics"] * p["custom_metric_month"]), False),
        ("CloudWatch dashboard", "1 x $3.00 per month (assumed)", monthly(q["dashboards"] * p["dashboard_month"]), False),
        ("CloudWatch Logs ingestion", "0.02 GB x $0.50 (assumed)", q["log_gb_per_hour"] * p["log_ingest_gb"], True),
        ("S3 artifacts", "1 GB x $0.023 per month (assumed)", monthly(q["s3_gb"] * p["s3_gb_month"]), False),
    ]


def build():
    lines = hourly_lines()
    active = sum(line[2] for line in lines)
    idle = sum(line[2] for line in lines if not line[3])
    p = PRICE
    extra_instance = p["ec2_t3_micro_hour"] + p["public_ipv4_hour"]
    resize_premium = 2 * (p["ec2_t3_small_hour"] - p["ec2_t3_micro_hour"]) + p["rds_t3_small_hour"] - p["rds_t3_micro_hour"]

    plan = [
        ("Build, first deployment and debugging", 12),
        ("Baseline and change experiments", 16),
        ("CI/CD runs and rollback test", 8),
        ("Rehearsal and final demonstration", 8),
        ("Contingency", 16),
    ]
    active_hours = sum(hours for _, hours in plan)
    extras = [
        ("Two extra instances during 6 hours of load tests", 2 * extra_instance * 6),
        ("Larger web and database sizes for 4 hours", resize_premium * 4),
        ("Internet data transfer, 5 GB at $0.09 (assumed)", 5 * 0.09),
        ("CPU credit surplus during load tests (allowance)", 1.00),
        ("Part-hour rounding across 15 deploy cycles", 15 * (p["alb_hour"] + p["alb_lcu_hour"])),
    ]
    planned = active_hours * active + sum(amount for _, amount in extras)

    scenarios = [
        ("Recommended: 60 active hours, deleted after each session", planned),
        ("Forgotten for 14 days with 30 active hours", 30 * active + (14 * 24 - 30) * idle),
        ("Forgotten for 30 days with 30 active hours", 30 * active + (30 * 24 - 30) * idle),
        ("Running continuously for 30 days", 30 * 24 * active),
    ]
    return {
        "activePerHour": active,
        "idlePerHour": idle,
        "lines": [{"item": a, "basis": b, "perHour": c, "stopsWithInstances": d} for a, b, c, d in lines],
        "plan": [{"activity": a, "hours": h, "cost": h * active} for a, h in plan],
        "activeHours": active_hours,
        "extras": [{"item": a, "cost": c} for a, c in extras],
        "plannedTotal": planned,
        "remainingBudget": BUDGET - planned,
        "activeHoursWithinBudget": (BUDGET - RESERVE) / active,
        "scenarios": [{"scenario": a, "cost": c, "withinBudget": c <= BUDGET} for a, c in scenarios],
    }


if __name__ == "__main__":
    print(json.dumps(build(), indent=2))
