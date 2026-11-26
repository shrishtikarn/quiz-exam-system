# QuizHall: quiz-based exam system on AWS

Students take timed exams, tutors create and mark them, and parents see released results.
It runs on your own computer for development, and on AWS with 10 services.

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
| AWS IAM | Role for the web servers (`LabInstanceProfile` in Learner Lab) |

## 1. Run it on your own computer

You need Node.js 20.6 or newer and MySQL 8.0 or 8.4. XAMPP's MariaDB is not compatible.

1. Create the database in MySQL:

   ```sql
   CREATE DATABASE quizexam;
   ```
## dataset used dataset/csbench_review.csv

2. In the project folder, install the packages and create your settings file:

   ```bash
   npm install
   cp env.example .env
   ```

   On Windows Command Prompt use `copy env.example .env` instead of `cp`.

3. Open `.env` and set `DB_PASSWORD` to your MySQL root password.

4. Start the app:

   ```bash
   npm run local
   ```

5. Open http://localhost:3000 and sign in as `tutor@demo.quiz`, `parent@demo.quiz` or
   `student001@demo.quiz`. The password is `DEMO_PASSWORD` in `.env` (`demo12345` by default).

Press **Ctrl + C** to stop it.

## 2. Deploy it to AWS

Works with a personal AWS account (Free plan) and with AWS Academy Learner Lab. The script detects which one you use.

1. Sign in to the AWS console. In a personal account, set the Region (top right) to **US East (N. Virginia)**.
   Learner Lab uses that Region already.
2. Open a terminal: **AWS CloudShell** (the `>_` icon in the console's top bar) in a personal account,
   or the lab terminal in Learner Lab.
3. Run:

   ```bash
   git clone https://github.com/shrishtikarn/quiz-exam-system.git
   cd quiz-exam-system
   bash scripts/deploy.sh
   ```

The first deployment takes 20 to 25 minutes and prints the website address. CloudShell closes after about
20 minutes without a key press, so click in the terminal now and then. If it disconnects, open CloudShell again
and run `cd quiz-exam-system && bash scripts/deploy.sh`. It waits for any work still in progress and carries on.

To create every service but leave the website switched off:

```bash
bash scripts/deploy.sh ServiceMode=off
```

Show the demo account password:

```bash
bash scripts/service.sh password
```

## 3. Switch the service on and off

All 10 services stay in place in both modes.

```bash
bash scripts/service.sh status   # current mode, web servers, database, address
bash scripts/service.sh off      # stop paying for the running parts
bash scripts/service.sh on       # bring the website back (about 10 minutes)
```

| Mode | What runs | Approximate cost (us-east-1) |
| --- | --- | --- |
| On | 2 web servers, load balancer, database | $0.113 an hour, about $2.71 a day |
| Off | Nothing runs. The load balancer is removed, the database is stopped, data is kept | $0.005 an hour, about $3.77 a month |
| Deleted (`bash scripts/teardown.sh`) | Nothing exists, data is lost | $0 |

- A load balancer cannot be paused, so turning off deletes it and turning on creates a new one.
  The website address changes each time.
- AWS restarts a stopped database after 7 days. Run `bash scripts/service.sh off` again within a week,
  or delete everything if you will not need it for a while.

## 4. CI/CD

Every pull request and push to `main` runs the tests, the package audit and the template checks.
A push to `main` then builds a release and, when deployment is enabled, rolls it out one web server
at a time, verifies it and rolls back automatically if verification fails.

Deployment needs AWS credentials in GitHub (**Settings > Secrets and variables > Actions**):

- Learner Lab: copy `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` and `AWS_SESSION_TOKEN` from
  **AWS Details**. They change every lab session.
- Then add the repository variable `DEPLOY_ENABLED` with the value `true`.

While the service is off, a deployment only uploads the release. It is used the next time the service is turned on.

## 5. Monitoring experiments

Turn the service on first. Results go to `monitoring/runs/`.

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
installed. Download `monitoring/` before you delete the stack. `E8_release` needs an earlier release,
so run it after at least two deployments.

## Other commands

```bash
bash scripts/status.sh            # health, instances, alarms and recent errors
bash scripts/teardown.sh          # delete the application stack and its data
bash scripts/teardown.sh --all    # also delete the artifact bucket
```

## Run the tests

The tests need a MySQL 8 database:

```bash
DB_HOST=127.0.0.1 DB_USER=root DB_PASSWORD=secret DB_NAME=quizexam_test npm test
```

## HTTPS

The default address uses HTTP, so do not reuse real passwords. `EnableHttpsViaCloudFront=true` adds HTTPS
through CloudFront, which makes it an eleventh service:

```bash
bash scripts/deploy.sh EnableHttpsViaCloudFront=true
```
