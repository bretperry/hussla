/*
  Your passkeys: the list, removing one (never the last), adding a spare, and a new passkey from a new setup code when every one is lost.
  In the app: "/setup/passkeys"; reached from setup's links and the recovery route a lost phone needs.
  Used by: src/app/App.tsx (the route).
  Uses: api.listPasskeys / removePasskey / registerPasskey, src/features/setup/PasskeyStep.tsx for the recovery code.
*/
import { useState } from "react";
import { api, describeError } from "@/shared/api";
import type { SetupStatus } from "@/shared/api";
import { formatWhen } from "@/shared/lib/format";
import { useResource } from "@/shared/lib/use-resource";
import { Button } from "@/shared/ui/Button";
import { ErrorLine, LoadingLine, useToast } from "@/shared/ui/Feedback";
import { PageHead, Section } from "@/shared/ui/Section";
import { PasskeyStep } from "./PasskeyStep";

export const PasskeysPage = ({ status, onChange }: { status: SetupStatus; onChange: () => void }) => {
  const passkeys = useResource(() => api.listPasskeys(), []);
  const toast = useToast();
  const [problem, setProblem] = useState("");

  const run = async (action: () => Promise<unknown>, done: string) => {
    setProblem("");
    try {
      await action();
      toast.show(done);
      passkeys.reload();
      onChange();
    } catch (failure) {
      setProblem(describeError(failure));
    }
  };

  const list = passkeys.data ?? [];
  return (
    <>
      <PageHead kicker="Passkeys" title="Your passkeys" />
      <Section kicker="On this address">
        {passkeys.data === null ? <LoadingLine /> : null}
        <ul>
          {list.map((key) => (
            <li key={key.id} className="flex flex-wrap items-baseline justify-between gap-2 border-t border-hairline py-2">
              <span>
                <b>{key.name}</b>{" "}
                <span className="text-small text-muted">
                  added {formatWhen(key.createdAt)} · last used {key.lastUsedAt === null ? "never" : formatWhen(key.lastUsedAt)}
                </span>
              </span>
              <Button size="sm" variant="danger" disabled={list.length < 2} onClick={() => void run(() => api.removePasskey(key.id), `Removed ${key.name}.`)}>
                Remove
              </Button>
            </li>
          ))}
        </ul>
        {list.length === 1 ? <p className="text-small text-muted">The last passkey can't be removed; add another first.</p> : null}
        <Button className="self-start" onClick={() => void run(() => api.registerPasskey("Spare passkey"), "Added a passkey.")}>
          Add a spare passkey
        </Button>
        {problem === "" ? null : <ErrorLine message={problem} />}
      </Section>
      <Section kicker="Lost every passkey?">
        <PasskeyStep status={status} mode="recover" onDone={() => void run(() => Promise.resolve(), "Added a passkey.")} />
      </Section>
    </>
  );
};
