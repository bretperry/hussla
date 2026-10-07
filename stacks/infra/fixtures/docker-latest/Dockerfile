# Fixture: a base image on `latest`, which hadolint must reject under .hadolint.yaml. Wrong on purpose.
# In the app: nothing; stacks/infra/infra.test.mjs runs hadolint on it and expects DL3007.
# Used by: stacks/infra/infra.test.mjs. stacks/infra/check.mjs skips stacks/infra/fixtures/.
FROM debian:latest
CMD ["true"]
