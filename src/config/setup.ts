/*
  First-run knobs for the UI: the wizard's steps and their order, which ones need the tailnet, and the Tailscale pages it links to.
  In the app: the setup wizard ("/setup") and the key-expiry banner.
  Used by: src/features/setup/**, src/app/shell.tsx.

  The step names are the API's (SetupStepMark.step in api/openapi.yaml, generated into the types);
  the server's list is internal/config/setup.go's WizardSteps. Keep the two in the same order.
*/

export const WIZARD_STEPS = ["mail", "import", "agent", "phone", "expiry", "second-passkey"] as const;

// Steps that only mean something on the tailnet address: a laptop on its local listener skips them.
export const TAILNET_ONLY_STEPS: readonly string[] = ["phone", "expiry"];

// Where each machine's "Disable key expiry" lives (same as internal/config's TailscaleAdminMachines).
export const TAILSCALE_ADMIN_MACHINES = "https://login.tailscale.com/admin/machines";

// Where the phone and laptop apps are (same as internal/config's TailscaleDownload).
export const TAILSCALE_DOWNLOAD = "https://tailscale.com/download";

// The name a new passkey gets when the owner doesn't type one.
export const DEFAULT_PASSKEY_NAME = "Passkey";
