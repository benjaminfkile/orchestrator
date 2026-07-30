# orchestrator-runner — the lease image orchestrator playbooks run in.
#
# wisp boots this container with `tail -f /dev/null` as PID 1 and drives all
# work through execs, so the image needs no entrypoint — just the tools the
# executor's steps and the agent exec expect: node, git, and the claude CLI,
# plus the Go and .NET toolchains needed to build/test mixed-stack
# (Node + .NET + Go) repos.
#
# Build (on the machine running wispd):
#   docker build -t orchestrator-runner ./runner
#
# NOTE: this Dockerfile is only the image *definition*. After changing it you
# must rebuild the image on the host running wispd for the new toolchains to
# take effect:
#   docker build -t orchestrator-runner ./runner
#
# Then allow-list it in the wisp HOST's policy config — the file the operator's
# WISP_CONFIG points at (wisp.config.example.json next to this file shows the
# needed entries) — and set
# the orchestrator setting `default_lease_image` to "orchestrator-runner".

FROM node:20-slim

# Pinned toolchain versions. Go tracks the 1.22.x line; .NET tracks the 8.0 LTS
# channel to mirror what the grunt runner ships.
ENV GO_VERSION=1.22.12
ENV DOTNET_CHANNEL=8.0

RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g @anthropic-ai/claude-code@latest

# Go toolchain (1.22.x) — install the official tarball to /usr/local/go for
# whichever CPU arch the base image is (amd64 or arm64).
RUN set -eux; \
    arch="$(dpkg --print-architecture)"; \
    case "$arch" in \
      amd64) goarch=amd64 ;; \
      arm64) goarch=arm64 ;; \
      *) echo "unsupported arch: $arch" >&2; exit 1 ;; \
    esac; \
    curl -fsSL "https://go.dev/dl/go${GO_VERSION}.linux-${goarch}.tar.gz" -o /tmp/go.tar.gz; \
    tar -C /usr/local -xzf /tmp/go.tar.gz; \
    rm /tmp/go.tar.gz; \
    /usr/local/go/bin/go version

# .NET 8 SDK — install via the official dotnet-install script to a shared
# location. dotnet-install.sh auto-detects the CPU arch.
ENV DOTNET_ROOT=/usr/local/dotnet
RUN set -eux; \
    curl -fsSL https://dot.net/v1/dotnet-install.sh -o /tmp/dotnet-install.sh; \
    chmod +x /tmp/dotnet-install.sh; \
    /tmp/dotnet-install.sh --channel "$DOTNET_CHANNEL" --install-dir "$DOTNET_ROOT"; \
    rm /tmp/dotnet-install.sh; \
    "$DOTNET_ROOT/dotnet" --version

# Expose go, gofmt, and dotnet on PATH for every user (including node).
ENV PATH=/usr/local/go/bin:/usr/local/dotnet:${PATH}
# Keep Go's caches under the node user's writable HOME at runtime.
ENV GOPATH=/home/node/go
# Silence first-run telemetry/noise from the .NET CLI.
ENV DOTNET_CLI_TELEMETRY_OPTOUT=1
ENV DOTNET_NOLOGO=1
ENV DOTNET_SKIP_FIRST_TIME_EXPERIENCE=1

# Cloned repos and exec cwds can mix ownership; never let git balk at that
# inside a throwaway container.
RUN git config --system --add safe.directory '*'

# Run as the unprivileged node user (uid 1000). This is load-bearing: the
# claude CLI refuses --dangerously-skip-permissions when running as root, and
# every agent exec runs with exactly that flag.
USER node
ENV HOME=/home/node
WORKDIR /home/node
