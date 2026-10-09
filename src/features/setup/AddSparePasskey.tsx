/*
  Adding a spare passkey in two clicks: confirm with a passkey you have, then make the new one.
  In the app: setup's spare-passkey step and "/setup/passkeys".
  Used by: src/features/setup/SetupPage.tsx, src/features/setup/PasskeysPage.tsx.
  Uses: api.confirmForNewPasskey / registerPasskey.

  One click used to chain both prompts; a browser only shows a passkey prompt shortly after a
  click, so Firefox refused the second as "cancelled or timed out". The confirm token lives two
  minutes (config.StepUpLifetime) and is spent by the first use, so a failed attempt starts over.
*/
import { useState } from "react";
import { api, describeError } from "@/shared/api";
import { Button } from "@/shared/ui/Button";
import { ErrorLine } from "@/shared/ui/Feedback";

export const AddSparePasskey = ({ onAdded }: { onAdded: () => void }) => {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");

  const confirm = async () => {
    setBusy(true);
    setProblem("");
    try {
      setToken(await api.confirmForNewPasskey());
    } catch (failure) {
      setProblem(describeError(failure));
    } finally {
      setBusy(false);
    }
  };

  const make = async () => {
    setBusy(true);
    setProblem("");
    try {
      await api.registerPasskey("Spare passkey", token);
      setToken("");
      onAdded();
    } catch (failure) {
      // The token is spent or expired either way; the next try confirms again.
      setToken("");
      setProblem(describeError(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      {token === "" ? (
        <Button variant="primary" className="self-start" disabled={busy} onClick={() => void confirm()}>
          1. Confirm with your current passkey
        </Button>
      ) : (
        <>
          <p role="status">Confirmed. Now make the new one; pick “use another device” in the prompt to put it on a different one.</p>
          <Button variant="primary" className="self-start" disabled={busy} onClick={() => void make()}>
            2. Make the new passkey
          </Button>
        </>
      )}
      {problem === "" ? null : <ErrorLine message={problem} />}
    </div>
  );
};
