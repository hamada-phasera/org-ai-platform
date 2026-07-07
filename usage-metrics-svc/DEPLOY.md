# Deploying usage-metrics-svc to AWS

A single stateless container that listens on `:8080`. Health check path is
`/healthz`. It needs outbound access to Postgres (`DATABASE_URL`) — for prod,
the Neon `org-ai-platform` DB via a **least-privilege role** (read AILog, write
only `usage_daily_rollup`; see [schema.sql](schema.sql)).

## Build & push the image

The image must be **linux/amd64** for the default App Runner / Fargate runtime
(build on Apple Silicon needs `--platform`):

```bash
AWS_ACCOUNT=123456789012
REGION=us-east-1
REPO=usage-metrics-svc

aws ecr create-repository --repository-name "$REPO" --region "$REGION"
aws ecr get-login-password --region "$REGION" \
  | docker login --username AWS --password-stdin "$AWS_ACCOUNT.dkr.ecr.$REGION.amazonaws.com"

docker build --platform linux/amd64 -t "$REPO:latest" .
docker tag "$REPO:latest" "$AWS_ACCOUNT.dkr.ecr.$REGION.amazonaws.com/$REPO:latest"
docker push "$AWS_ACCOUNT.dkr.ecr.$REGION.amazonaws.com/$REPO:latest"
```

## Option A — AWS App Runner (fewest moving parts; recommended)

App Runner pulls the image, runs it, gives you HTTPS, autoscaling, and health
checks with no load balancer to manage.

1. **App Runner → Create service → Container registry → Amazon ECR**, pick the
   image above.
2. **Port** `8080`. **Health check** HTTP path `/healthz`.
3. **Environment variables**: `METRICS_SOURCE=rollup` (or `raw`), `ROLLUP_INTERVAL=5m`.
   Put `DATABASE_URL` in **Secrets Manager** and reference it (don't inline the DSN).
4. Deploy. The service URL serves `GET /metrics/usage?tenant_id=<org>`.

CLI sketch:

```bash
aws apprunner create-service \
  --service-name usage-metrics-svc \
  --source-configuration '{
    "ImageRepository": {
      "ImageIdentifier": "'"$AWS_ACCOUNT"'.dkr.ecr.'"$REGION"'.amazonaws.com/'"$REPO"':latest",
      "ImageRepositoryType": "ECR",
      "ImageConfiguration": {
        "Port": "8080",
        "RuntimeEnvironmentVariables": { "METRICS_SOURCE": "rollup" },
        "RuntimeEnvironmentSecrets": { "DATABASE_URL": "arn:aws:secretsmanager:'"$REGION"':'"$AWS_ACCOUNT"':secret:usage-metrics/database-url" }
      }
    }
  }' \
  --health-check-configuration '{"Protocol":"HTTP","Path":"/healthz","Interval":10,"Timeout":5}' \
  --region "$REGION"
```

## Option B — ECS Fargate (more control: VPC, ALB, IAM)

1. **Task definition** (Fargate, 0.25 vCPU / 0.5 GB is plenty): one container,
   image from ECR, port `8080`, `DATABASE_URL` from Secrets Manager via
   `secrets`, `METRICS_SOURCE` via `environment`. Log driver `awslogs`.
2. **Service** behind an **ALB**; target group health check path `/healthz`,
   port `8080`. Desired count 1–2.
3. **Security group**: inbound 8080 from the ALB only; outbound 443/5432 to reach
   Neon. **Task role** needs `secretsmanager:GetSecretValue` for the DSN secret.

## Notes

- **Read-only DB posture** carries to prod regardless of platform: the raw read
  path runs in a `READ ONLY` transaction, and the worker writes only
  `usage_daily_rollup`. Use the `metrics_svc` least-privilege role in
  [schema.sql](schema.sql) so the DB itself enforces "never writes AILog".
- **One-time schema apply**: run [schema.sql](schema.sql) against the target DB
  (index + rollup table) before first deploy.
- **Stateless**: the rollup lives in Postgres, so scaling to N tasks is safe; the
  worker's upsert is idempotent, so multiple instances refreshing concurrently
  converge rather than corrupt.
