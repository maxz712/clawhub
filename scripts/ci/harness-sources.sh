#!/bin/sh
# THE list of paths that constitute "the agent-harness image changed".
#
# Sourced by BOTH build-harness-arch.sh (should I build?) and
# assemble-harness-manifest.sh (should I fuse?). It exists because those two had
# their own copies of this regex and they DRIFTED: the build filter was widened to
# cover the build scripts, the fuse filter was not — so a build-script change built
# both per-arch tags and then silently skipped the fuse, leaving :latest pointing at
# a 19-day-old image while every leg reported success. One definition, no drift.
#
# Sourcing is best-effort in the callers: an old checkout without this file keeps
# its inline fallback rather than failing the build.
HARNESS_SOURCE_RE='^(packages/agent-harness/|scripts/(ci/)?build-harness|scripts/ci/assemble-harness|\.clawhub/ci/build-harness)'
export HARNESS_SOURCE_RE
