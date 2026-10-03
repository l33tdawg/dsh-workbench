# The benchmark's outer boundary.
#
# DSH's macOS confinement applies seatbelt through `sandbox-exec`, and
# `sandbox-exec` cannot be applied from inside another sandbox. A benchmark
# launched from a confined shell therefore gets an inner sandbox that fails
# closed - `sandbox_apply: Operation not permitted` - and refuses to run the
# command unconfined, so the agent has no shell at all and cannot run the
# fixture's tests. Runs are consequently taken with DSH's own sandbox off
# (`DSH_PERMISSION_MODE=danger-full-access`), which leaves the agent unconfined
# unless something outside it provides the boundary.
#
# That is what this image is. It is the container, not the harness, that
# contains the run.
#
# Debian rather than Alpine on purpose: the harness pulls platform-native
# binaries (ripgrep among them), and musl is a needless variable in a layer whose
# whole job is to be the boring part.

FROM node:22-bookworm-slim

# git is how the harness captures the patch a run produced; without it every
# run records an empty diff and reads as "the agent changed nothing".
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Pinned to the version the desktop app runs, so a benchmark measures the
# harness that is actually installed rather than whatever is newest.
ARG DSH_VERSION=0.2.0-rc.2
RUN npm install -g "@deepseek-ai/dsh@${DSH_VERSION}" \
  && dsh --version

WORKDIR /bench
