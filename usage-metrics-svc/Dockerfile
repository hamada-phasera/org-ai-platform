# syntax=docker/dockerfile:1

# ---- build stage ----
FROM golang:1.25-alpine AS builder
WORKDIR /src

# Cache module downloads separately from source changes.
COPY go.mod go.sum ./
RUN go mod download

COPY . .
# Static, stripped binary. CGO off ⇒ runs on distroless/static (no libc).
# GOOS/GOARCH default to the build platform; pass --platform=linux/amd64 to
# `docker build` for x86 AWS targets (see DEPLOY.md).
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/usage-metrics-svc ./cmd/server

# ---- runtime stage ----
# distroless/static: no shell, no package manager, runs as a non-root user —
# minimal attack surface. Health checks are done by the platform against /healthz.
FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=builder /out/usage-metrics-svc /usage-metrics-svc
EXPOSE 8080
USER nonroot:nonroot
ENTRYPOINT ["/usage-metrics-svc"]
