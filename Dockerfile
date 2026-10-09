# syntax=docker/dockerfile:1.7
# Hussla's image: the React app and the Go server in one static binary on a distroless base, for amd64 and arm64.
# In the app: what a NAS, a cloud VM or Docker Desktop runs (ghcr.io/bretperry/hussla); the `e2e` target is the test build with a fake Tailscale.
# Used by: .github/workflows/publish-image.yml (multi-arch push on a v* tag), docker-compose.yml, scripts/container-smoke.sh, src/test/setup-e2e.mjs.
# Uses: node (the Vite build), golang (a cgo-free cross-compile), gcr.io/distroless/static-debian12:nonroot.
#
# Why this shape:
#   - Every base image is pinned by digest (infra.mdc → Docker): the same tag builds the same image
#     tomorrow, and a rollback rebuilds what actually ran.
#   - The UI and Go stages run on the build machine's own platform ($BUILDPLATFORM) and Go
#     cross-compiles to $TARGETARCH: no QEMU, so an arm64 image builds in seconds on an amd64 runner.
#   - The data lives in a volume at /data owned by the image's non-root user (65532), so a named
#     volume works on any NAS with no chown and no PUID/PGID to look up.
#   - The home-network page (setup before Tailscale is signed in) is on 8484; the laptop-only local
#     listener is off, since loopback inside a container reaches no browser.

# ---- UI: the Vite build ------------------------------------------------------
FROM --platform=$BUILDPLATFORM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS ui
WORKDIR /src
# pnpm at the version package.json's packageManager names, through corepack (bundled with Node).
RUN corepack enable
# .pnpmfile.cjs is part of the lockfile (its checksum), so the frozen install needs it.
COPY package.json pnpm-lock.yaml .pnpmfile.cjs ./
RUN --mount=type=cache,target=/root/.local/share/pnpm/store pnpm install --frozen-lockfile
# The compiler configs by pattern: Vite reads them for JSX and paths.
COPY index.html vite.config.ts tsconfig*.json ./
COPY src ./src
RUN pnpm build

# ---- Go: one static binary per target ----------------------------------------
FROM --platform=$BUILDPLATFORM golang:1.27.1-alpine@sha256:8a5910f31396cd4d89662f56c68b3ae31d374308270a1c3bd96672ee5ed43414 AS server
WORKDIR /src
ARG TARGETOS
ARG TARGETARCH
# Set by the publish workflow from the git tag; shown on Settings and recorded with each migration.
ARG VERSION=dev
COPY go.mod go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download
COPY assets.go ./
COPY api ./api
COPY docs/agents-api.md ./docs/agents-api.md
COPY cmd ./cmd
COPY internal ./internal
# The Vite build replaces the placeholder page the binary would otherwise embed.
COPY --from=ui /src/dist ./cmd/hussla/web
# The empty data directory the volume mounts over, owned by the runtime user so a new named volume inherits it.
RUN mkdir -p /out/data && chown 65532:65532 /out/data
RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH \
    go build -trimpath -ldflags "-s -w -X github.com/bretperry/hussla/internal/config.Version=${VERSION}" -o /out/hussla ./cmd/hussla
# The same binary with the fake Tailscale linked in, for the e2e target only.
RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH \
    go build -trimpath -tags faketailnet -ldflags "-X github.com/bretperry/hussla/internal/config.Version=${VERSION}-e2e" -o /out/hussla-e2e ./cmd/hussla

# ---- e2e: the test build (fake Tailscale on plain HTTP); never published -----
FROM gcr.io/distroless/static-debian12:nonroot@sha256:afa5c872c891853ca7fcf1f12c3edb23f7eeef36189728842dd51042ff57f7ab AS e2e
COPY --from=server --chown=65532:65532 /out/data /data
COPY --from=server /out/hussla-e2e /hussla
ENV DATA_DIR=/data HUSSLA_HOME_PORT=8484 HUSSLA_LOCAL_PORT=off
VOLUME /data
EXPOSE 8484 8443 8445
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD ["/hussla", "health"]
ENTRYPOINT ["/hussla"]
CMD ["serve"]

# ---- the published image (last, so a plain `docker build` makes it) ----------
FROM gcr.io/distroless/static-debian12:nonroot@sha256:afa5c872c891853ca7fcf1f12c3edb23f7eeef36189728842dd51042ff57f7ab AS release
LABEL org.opencontainers.image.source="https://github.com/bretperry/hussla" \
      org.opencontainers.image.description="Hussla: a self-hosted job-search tracker on your own Tailscale network"
COPY --from=server --chown=65532:65532 /out/data /data
COPY --from=server /out/hussla /hussla
ENV DATA_DIR=/data HUSSLA_HOME_PORT=8484 HUSSLA_LOCAL_PORT=off
VOLUME /data
EXPOSE 8484
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD ["/hussla", "health"]
ENTRYPOINT ["/hussla"]
CMD ["serve"]
