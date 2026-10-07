# syntax=docker/dockerfile:1
# Fixture: the same image on a pinned base, so the latest one fails for its tag and not for the rest.
# In the app: nothing; stacks/infra/infra.test.mjs runs hadolint on it and expects a pass.
# Used by: stacks/infra/infra.test.mjs. stacks/infra/check.mjs skips stacks/infra/fixtures/.

# Pinned to a Debian release, not `latest`: the same file builds the same base next month.
FROM debian:13.1-slim
USER 65534
CMD ["true"]
