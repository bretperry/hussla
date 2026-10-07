# Fixture: the same module, correct, so the bad one fails for its error and not for the setup.
# In the app: nothing; stacks/infra/infra.test.mjs runs validate on it and expects a pass.
# Used by: stacks/infra/infra.test.mjs. stacks/infra/check.mjs skips stacks/infra/fixtures/.

terraform {
  required_version = ">= 1.5.0"
}

variable "name" {
  description = "Who to greet."
  type        = string
  default     = "world"
}

output "greeting" {
  description = "A greeting for var.name."
  value       = "hello ${var.name}"
}
