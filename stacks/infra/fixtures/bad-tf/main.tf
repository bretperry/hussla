# Fixture: a module terraform validate must reject (an undeclared variable). Wrong on purpose.
# In the app: nothing; stacks/infra/infra.test.mjs runs validate on it and expects a failure.
# Used by: stacks/infra/infra.test.mjs. stacks/infra/check.mjs skips stacks/infra/fixtures/.

terraform {
  required_version = ">= 1.5.0"
}

output "greeting" {
  description = "Refers to a variable nobody declared."
  value       = "hello ${var.name}"
}
