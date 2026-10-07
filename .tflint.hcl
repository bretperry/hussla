# tflint policy for every Terraform module in the repo, cloud-neutral (the bundled terraform ruleset only).
# In the app: nothing at runtime; `pnpm infra:lint` (stacks/infra/check.mjs lint) runs tflint per module with it.
# Used by: stacks/infra/check.mjs; CI's "Stack pack checks" step.
# Uses: tflint's bundled terraform ruleset (no download); `tflint --init` fetches any plugin added below.
#
# A cloud ruleset is the project's call, pinned by version, e.g.:
#   plugin "aws" { enabled = true  version = "0.x.y"  source = "github.com/terraform-linters/tflint-ruleset-aws" }

config {
  # Lint local child modules as part of their caller, so a bad argument to one is caught where it is passed.
  call_module_type = "local"
}

plugin "terraform" {
  enabled = true
  # recommended: pinned Terraform and provider versions, typed variables, no unused declarations, no deprecated syntax.
  preset = "recommended"
}

# Inputs and outputs carry a description: it is the only documentation a module's caller reads (docs-infra.mdc).
rule "terraform_documented_variables" {
  enabled = true
}

rule "terraform_documented_outputs" {
  enabled = true
}

# snake_case names everywhere, so addresses in plans and `terraform state` read the same in every module.
rule "terraform_naming_convention" {
  enabled = true
}
