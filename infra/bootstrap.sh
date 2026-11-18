#!/bin/bash
# Runs once on every new EC2 instance. The launch template exports the settings it needs.
set -euo pipefail

: "${AWS_DEFAULT_REGION:?}" "${ARTIFACT_BUCKET:?}" "${DB_HOST:?}" "${DB_NAME:?}"
: "${DB_SECRET_ARN:?}" "${APP_SECRET_ARN:?}" "${DEMO_SECRET_ARN:?}" "${LOG_GROUP:?}"
TRUST_PROXY_HOPS="${TRUST_PROXY_HOPS:-1}"

echo "[bootstrap] installing operating system packages"
dnf install -y -q amazon-cloudwatch-agent logrotate tar gzip

id quiz >/dev/null 2>&1 || useradd --system --home-dir /opt/quiz --shell /sbin/nologin quiz
install -d -o root -g root -m 0755 /opt/quiz/releases /etc/quiz
install -d -o quiz -g quiz -m 0750 /var/log/quiz
touch /var/log/quiz/app.log
chown quiz:quiz /var/log/quiz/app.log

metadata_token=$(curl -fsS -X PUT http://169.254.169.254/latest/api/token \
  -H 'X-aws-ec2-metadata-token-ttl-seconds: 300')
INSTANCE_ID=$(curl -fsS -H "X-aws-ec2-metadata-token: ${metadata_token}" \
  http://169.254.169.254/latest/meta-data/instance-id)
export INSTANCE_ID

echo "[bootstrap] downloading the current release"
RELEASE=$(aws s3 cp "s3://${ARTIFACT_BUCKET}/releases/current" - | tr -d '[:space:]')
[ -n "${RELEASE}" ] || { echo "[bootstrap] no current release found" >&2; exit 1; }
release_dir="/opt/quiz/releases/${RELEASE}"
mkdir -p "${release_dir}"
aws s3 cp --only-show-errors "s3://${ARTIFACT_BUCKET}/releases/${RELEASE}.tar.gz" /tmp/release.tar.gz
tar -xzf /tmp/release.tar.gz -C "${release_dir}"
rm -f /tmp/release.tar.gz
chown -R root:root "${release_dir}"
ln -sfn "${release_dir}" /opt/quiz/current
export RELEASE

echo "[bootstrap] writing application settings"
python3 - <<'PYTHON'
import json
import os
import subprocess


def secret(env_name):
    output = subprocess.check_output([
        "aws", "secretsmanager", "get-secret-value",
        "--secret-id", os.environ[env_name],
        "--query", "SecretString", "--output", "text",
    ], text=True)
    return json.loads(output)


database = secret("DB_SECRET_ARN")
settings = {
    "NODE_ENV": "production",
    "PORT": "3000",
    "APP_VERSION": os.environ["RELEASE"],
    "INSTANCE_ID": os.environ["INSTANCE_ID"],
    "TRUST_PROXY_HOPS": os.environ.get("TRUST_PROXY_HOPS", "1"),
    "DB_HOST": os.environ["DB_HOST"],
    "DB_NAME": os.environ["DB_NAME"],
    "DB_USER": database["username"],
    "DB_PASSWORD": database["password"],
    "DB_CA_PATH": "/opt/quiz/current/certs/rds-global-bundle.pem",
    "JWT_SECRET": secret("APP_SECRET_ARN")["jwtSecret"],
    "SEED_ON_BOOT": "true",
    "DEMO_PASSWORD": secret("DEMO_SECRET_ARN")["password"],
}
descriptor = os.open("/etc/quiz/app.env", os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(descriptor, "w") as handle:
    for key, value in settings.items():
        handle.write(f"{key}={value}\n")
PYTHON

cat >/etc/systemd/system/quiz-exam.service <<'UNIT'
[Unit]
Description=Quiz exam web application
After=network-online.target
Wants=network-online.target

[Service]
User=quiz
Group=quiz
WorkingDirectory=/opt/quiz/current
EnvironmentFile=/etc/quiz/app.env
ExecStart=/opt/quiz/current/runtime/bin/node src/server.js
Restart=always
RestartSec=3
TimeoutStopSec=30
StandardOutput=append:/var/log/quiz/app.log
StandardError=append:/var/log/quiz/app.log
NoNewPrivileges=yes
PrivateTmp=yes
ProtectHome=yes
ProtectSystem=strict
ReadWritePaths=/var/log/quiz
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
UNIT

cat >/etc/logrotate.d/quiz-exam <<'ROTATE'
/var/log/quiz/app.log {
  daily
  rotate 3
  size 50M
  compress
  missingok
  notifempty
  copytruncate
}
ROTATE

echo "[bootstrap] configuring the CloudWatch agent"
cat >/opt/aws/amazon-cloudwatch-agent/etc/quiz-agent.json <<AGENT
{
  "agent": { "metrics_collection_interval": 60, "run_as_user": "root" },
  "metrics": {
    "namespace": "QuizExam/Host",
    "append_dimensions": { "AutoScalingGroupName": "\${aws:AutoScalingGroupName}" },
    "aggregation_dimensions": [["AutoScalingGroupName"]],
    "metrics_collected": {
      "mem": { "measurement": ["mem_used_percent"] },
      "disk": { "measurement": ["used_percent"], "resources": ["/"], "drop_device": true }
    }
  },
  "logs": {
    "logs_collected": {
      "files": {
        "collect_list": [
          { "file_path": "/var/log/quiz/app.log", "log_group_name": "${LOG_GROUP}", "log_stream_name": "{instance_id}/app" },
          { "file_path": "/var/log/quiz-bootstrap.log", "log_group_name": "${LOG_GROUP}", "log_stream_name": "{instance_id}/bootstrap" }
        ]
      }
    }
  }
}
AGENT
# Monitoring problems must not stop the application from starting.
/opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl -a fetch-config -m ec2 -s \
  -c file:/opt/aws/amazon-cloudwatch-agent/etc/quiz-agent.json \
  || echo "[bootstrap] warning: the CloudWatch agent did not start"

echo "[bootstrap] starting the application"
systemctl daemon-reload
systemctl enable --now quiz-exam.service

for _ in $(seq 1 60); do
  if curl -fsS http://127.0.0.1:3000/health >/dev/null 2>&1; then
    echo "[bootstrap] application is healthy, release ${RELEASE}"
    exit 0
  fi
  sleep 5
done
echo "[bootstrap] application did not become healthy within 5 minutes" >&2
exit 1
