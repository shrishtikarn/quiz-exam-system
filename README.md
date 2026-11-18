# QuizHall: quiz-based exam system on AWS

Students take timed exams, tutors create and mark them, and parents see released results.
The system runs on AWS Academy Learner Lab with 10 AWS services.

| Service | Used for |
| --- | --- |
| Amazon VPC | Public and private subnets, security groups |
| Amazon EC2 | Node.js web servers |
| Amazon EC2 Auto Scaling | Self-healing and CPU-based scaling |
| Elastic Load Balancing | Public entry point and health checks |
| Amazon RDS for MySQL | Exam data in private subnets |
| Amazon S3 | Release artifacts |
| AWS Secrets Manager | Database password and signing key |
| Amazon CloudWatch | Metrics, logs, alarms, dashboard |
| AWS CloudFormation | Creates and changes the environment |
| AWS IAM | Existing `LabRole` and `LabInstanceProfile` |

## Deploy

1. Push this folder to a GitHub repository.
2. Start the lab. Open its terminal and confirm the region is `us-east-1`.
3. Run:

   ```bash
   git clone https://github.com/<your-account>/<your-repository>.git
   cd <your-repository>
   bash scripts/deploy.sh
   ```

The first deployment takes about 20 minutes and prints the website address.
For a private repository, clone with a GitHub personal access token.

Sign in with `tutor@demo.quiz`, `parent@demo.quiz` or `student001@demo.quiz`.
The deploy script prints the command that shows the demo password.

Other commands:

```bash
bash scripts/status.sh     # health, instances, alarms and recent errors
bash scripts/teardown.sh   # delete the application stack at the end of a session
bash scripts/teardown.sh --all   # also delete the artifact bucket
```

**Budget rule:** delete the application stack after each working session. The load balancer,
database and public addresses can keep charging when you stop working.

EC2 instances stop when a lab session ends. If you keep the stack, start the lab again and allow
a few minutes for Auto Scaling to bring healthy instances back.

## Set up CI/CD

Learner Lab cannot create IAM users or roles, so the pipeline uses the temporary lab credentials.

1. In GitHub, open **Settings > Secrets and variables > Actions**.
2. From the lab's **AWS Details** panel, copy the values into these secrets:
   `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`.
3. Add the repository variable `DEPLOY_ENABLED` with the value `true`.
4. Update the secrets each time you start a new lab session.

Every pull request is tested. A push to `main` is tested, built, rolled out to AWS one instance at a
time, verified and rolled back automatically if verification fails. Set `DEPLOY_ENABLED` to `false`
when the lab is off, so the pipeline stops after the build.

After the first successful install, commit `package-lock.json` so builds use exact package versions.

## Monitoring experiments

Run these in the lab terminal after deployment. Results go to `monitoring/runs/`.

```bash
python3 monitoring/experiment.py run --name E0_baseline

python3 monitoring/experiment.py run --name E1_web_larger --set InstanceType=t3.small
python3 monitoring/experiment.py reset
python3 monitoring/experiment.py run --name E2_web_more --set MinInstances=3
python3 monitoring/experiment.py reset
python3 monitoring/experiment.py run --name E3_scaling_policy --set TargetCpuPercent=30
python3 monitoring/experiment.py reset
python3 monitoring/experiment.py run --name E4_health_check --set HealthCheckIntervalSeconds=30
python3 monitoring/experiment.py reset
python3 monitoring/experiment.py run --name E5_database_larger --set DBInstanceClass=db.t3.small
python3 monitoring/experiment.py reset
python3 monitoring/experiment.py run --name E6_database_storage --set DBAllocatedStorage=25

python3 monitoring/experiment.py fail --name E7_instance_failure
python3 monitoring/experiment.py observe --name E8_release -- bash scripts/release.sh --rollback

# Shows a replacement without applying it. Applying it would delete the database.
python3 monitoring/experiment.py preview --name P1_database_replacement --set DBName=quizexam2

python3 monitoring/analyze.py E0_baseline E1_web_larger E2_web_more E3_scaling_policy \
  E4_health_check E5_database_larger E6_database_storage E7_instance_failure E8_release
```

`analyze.py` writes `monitoring/report/comparison.md`, `comparison.csv` and charts when matplotlib is
installed. Copy `monitoring/` to S3 or download it before you delete the stack and end the lab.

`E8_release` needs an earlier release to return to, so run it after at least two deployments.

## Run the tests

The tests need Node.js 20 or newer and a MySQL 8.4 database:

```bash
npm install
DB_HOST=127.0.0.1 DB_USER=root DB_PASSWORD=secret DB_NAME=quizexam_test npm test
```

## HTTPS

Learner Lab gives no custom domain, so the default address uses HTTP. Do not enter real passwords.
`EnableHttpsViaCloudFront=true` adds HTTPS through CloudFront, but it makes this an eleventh service:

```bash
bash scripts/deploy.sh EnableHttpsViaCloudFront=true
```
