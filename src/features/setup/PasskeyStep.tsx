/*
  The first passkey: from the home-network page's "Make it mine" link, or from the setup code in the server log; also how a lost passkey is replaced.
  In the app: setup's first step, and "/setup/passkeys" when every passkey is lost (the owner asks for a new code and uses it).
  Used by: src/features/setup/SetupPage.tsx, src/features/setup/PasskeysPage.tsx.
  Uses: api.claimSetup / newSetupCode / registerPasskey, src/shared/lib/webauthn.ts for browser support.

  A cancelled Face ID prompt with the code changes nothing: the code works again. The link from
  the home-network page is good once (decision 0015), so after a cancelled prompt the person
  presses Make it mine there again, or uses the code.
*/
import { useState } from "react";
import type { FormEvent } from "react";
import { DEFAULT_PASSKEY_NAME } from "@/config/setup";
import { ApiError, api, describeError } from "@/shared/api";
import type { SetupStatus } from "@/shared/api";
import { formText } from "@/shared/lib/form";
import { useLocation } from "@/shared/lib/router";
import { passkeysSupported } from "@/shared/lib/webauthn";
import { Button } from "@/shared/ui/Button";
import { Callout, ErrorLine } from "@/shared/ui/Feedback";
import { Field, TextInput } from "@/shared/ui/Form";

// Where the code is, in the words of each place Hussla runs.
const WHERE_THE_CODE_IS =
  "It's in the server's log: on a Synology, Container Manager → Container → hussla → Log; anywhere else, `docker logs hussla` (or the window you started Hussla in).";

type PasskeyStepProps = {
  status: SetupStatus;
  onDone: () => void;
  // "recover": the owner lost every passkey and uses a new code; the copy says so.
  mode?: "first" | "recover";
};

export const PasskeyStep = ({ status, onDone, mode = "first" }: PasskeyStepProps) => {
  const { search } = useLocation();
  const linkFromPage = search.get("link") ?? "";
  const [useLink, setUseLink] = useState(linkFromPage !== "" && mode === "first");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const [note, setNote] = useState("");

  const register = async (proof: { code: string } | { link: string }, name: string) => {
    setBusy(true);
    setProblem("");
    try {
      const { stepUp } = await api.claimSetup(proof);
      await api.registerPasskey(name === "" ? DEFAULT_PASSKEY_NAME : name, stepUp);
      onDone();
    } catch (failure) {
      // The link's window closed, or it was used or replaced: fall back to the code, which still works.
      if ("link" in proof && failure instanceof ApiError && (failure.status === 409 || failure.status === 403)) setUseLink(false);
      setProblem(describeError(failure));
    } finally {
      setBusy(false);
    }
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const name = formText(data, "name");
    void register(useLink ? { link: linkFromPage } : { code: formText(data, "code") }, name);
  };

  const printNewCode = async () => {
    setProblem("");
    try {
      await api.newSetupCode();
      setNote("A new code is in the server log now; the old one no longer works.");
    } catch (failure) {
      setProblem(describeError(failure));
    }
  };

  const someoneElse = status.ownerLogin !== "" && status.seenLogin !== "" && status.ownerLogin !== status.seenLogin;
  return (
    <form className="flex max-w-prose flex-col gap-4" onSubmit={submit} aria-label="Add your passkey">
      <h2 className="font-display text-lead-phone font-black">{mode === "first" ? "Make this Hussla yours" : "Add a new passkey"}</h2>
      <p>
        {mode === "first"
          ? "A passkey (Face ID, Touch ID, Windows Hello or your phone) is how Hussla knows it's you. Nothing is stored but a public key."
          : "Lost every passkey? Print a new code, type it here, and make a new passkey on this device."}
      </p>
      {status.ownerLogin === "" ? null : (
        <p className="text-small" id="owner-login">
          Owner: <b>{status.ownerLogin}</b>
          {someoneElse ? ` (this browser is signed in to Tailscale as ${status.seenLogin})` : ""}.
          {status.canStartOver ? " Not you? Open Hussla's home-network page and press Start over." : ""}
        </p>
      )}
      {passkeysSupported() ? null : (
        <Callout tone="warn" title="This browser can't make a passkey here" role="alert">
          Open the https address of Hussla in Safari, Chrome or Edge on your phone or laptop.
        </Callout>
      )}
      {useLink ? (
        <p>This link came from the home-network page and works once. If the passkey prompt is cancelled, press Make it mine there again.</p>
      ) : (
        <Field label="Setup code" hint={WHERE_THE_CODE_IS}>
          <TextInput name="code" autoComplete="one-time-code" placeholder="XXXX-XXXX-XXXX" required autoCapitalize="characters" spellCheck={false} />
        </Field>
      )}
      <Field label="Name this passkey" hint="So you can tell them apart later: “iPhone”, “Work laptop”.">
        <TextInput name="name" defaultValue={DEFAULT_PASSKEY_NAME} maxLength={60} />
      </Field>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="primary" disabled={busy}>
          {useLink ? "Make it mine" : "Add a passkey"}
        </Button>
        {useLink ? (
          <Button onClick={() => setUseLink(false)}>Use the setup code instead</Button>
        ) : (
          <Button onClick={() => void printNewCode()}>Print a new code</Button>
        )}
      </div>
      {note === "" ? null : <p role="status">{note}</p>}
      {problem === "" ? null : <ErrorLine message={problem} />}
    </form>
  );
};
