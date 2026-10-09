/*
  Which page a caller gets (the app, setup, "not yours", or "sign in first"), and which wizard steps are left.
  In the app: the gate in App.tsx and the wizard's progress line; pure, so the rules are tested without a browser.
  Used by: src/app/App.tsx, src/features/setup/SetupPage.tsx.
  Uses: the setup status from GET /api/setup, src/config/setup.ts for the step order.
*/
import { TAILNET_ONLY_STEPS, WIZARD_STEPS } from "@/config/setup";
import type { SetupStatus, SetupStep } from "@/shared/api";

export type Gate =
  // The owner, set up: the app.
  | { kind: "app" }
  // The owner without a passkey or with wizard steps left, or someone who may claim an unowned install.
  | { kind: "setup" }
  // Someone else on the tailnet: name whose it is and who this browser is signed in as.
  | { kind: "not-owner"; ownerLogin: string; seenLogin: string }
  // No identity at all (the local listener without a sign-in link).
  | { kind: "sign-in" };

// The steps this address shows: the tailnet-only ones drop out on a laptop's local listener.
export const visibleSteps = (status: Pick<SetupStatus, "listener">): SetupStep[] =>
  WIZARD_STEPS.filter((step) => status.listener === "tailnet" || !TAILNET_ONLY_STEPS.includes(step));

// The wizard steps not yet done or skipped, in order.
export const stepsLeft = (status: Pick<SetupStatus, "listener" | "wizard">): SetupStep[] =>
  visibleSteps(status).filter((step) => status.wizard?.steps[step] === undefined);

export const gateFor = (status: SetupStatus): Gate => {
  if (status.isOwner) {
    return status.passkeys === 0 || stepsLeft(status).length > 0 ? { kind: "setup" } : { kind: "app" };
  }
  // No owner yet: someone the tailnet vouches for may claim it with the code from the log.
  if (!status.enrolled && status.seenLogin !== "") return { kind: "setup" };
  if (status.seenLogin !== "") return { kind: "not-owner", ownerLogin: status.ownerLogin, seenLogin: status.seenLogin };
  return { kind: "sign-in" };
};
