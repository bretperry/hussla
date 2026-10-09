/*
  The first-run wizard: your passkey first, then mail, an import, an agent key, your phone, key expiry and a second passkey, each skippable.
  In the app: "/setup", and every address until the owner has a passkey and has done or skipped each step; a restart keeps the progress.
  Used by: src/app/App.tsx (the setup gate and the "/setup" route).
  Uses: src/features/setup/setup-steps.ts for the steps left, api.markSetupStep to save each one on the server.
*/
import { useState } from "react";
import type { ChangeEvent, FormEvent, ReactNode } from "react";
import { TAILSCALE_ADMIN_MACHINES, TAILSCALE_DOWNLOAD } from "@/config/setup";
import { api, describeError } from "@/shared/api";
import type { AgentKeyCreated, ImportResult, SetupStatus, SetupStep } from "@/shared/api";
import { formText } from "@/shared/lib/form";
import { Button, LinkButton } from "@/shared/ui/Button";
import { ErrorLine } from "@/shared/ui/Feedback";
import { Field, TextInput } from "@/shared/ui/Form";
import { PageHead, Section } from "@/shared/ui/Section";
import { MailStep } from "./MailStep";
import { PasskeyStep } from "./PasskeyStep";
import { stepsLeft, visibleSteps } from "./setup-steps";

const STEP_TITLES: Record<SetupStep, string> = {
  mail: "Email",
  import: "Bring your jobs",
  agent: "Connect an agent",
  phone: "Your phone",
  expiry: "Stay signed in",
  "second-passkey": "A spare passkey",
};

const ImportStep = ({ onDone }: { onDone: () => void }) => {
  const [result, setResult] = useState<ImportResult | null>(null);
  const [problem, setProblem] = useState("");
  const pick = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file === undefined) return;
    setProblem("");
    try {
      // The server parses and validates the file (backup, seed, or the old tracker's export or emails list).
      setResult(await api.importBundle(file));
    } catch (failure) {
      setProblem(describeError(failure));
    }
  };
  return (
    <div className="flex max-w-prose flex-col gap-4">
      <h2 className="font-display text-lead-phone font-black">Bring your jobs</h2>
      <p>Have a Hussla backup or an export from the old tracker? Pick the .json file. Importing twice changes nothing.</p>
      <Field label="Backup file">
        <input type="file" accept="application/json,.json" onChange={(event) => void pick(event)} />
      </Field>
      {result === null ? null : (
        <p role="status">
          Imported {result.jobs} jobs, {result.companies} companies, {result.answers} answers and {result.events} events.
        </p>
      )}
      {result === null ? null : (
        <Button variant="primary" className="self-start" onClick={onDone}>
          Next
        </Button>
      )}
      {problem === "" ? null : <ErrorLine message={problem} />}
    </div>
  );
};

const AgentStep = ({ onDone }: { onDone: () => void }) => {
  const [created, setCreated] = useState<AgentKeyCreated | null>(null);
  const [problem, setProblem] = useState("");
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setProblem("");
    try {
      setCreated(await api.createAgentKey(formText(new FormData(event.currentTarget), "name")));
    } catch (failure) {
      setProblem(describeError(failure));
    }
  };
  return (
    <form className="flex max-w-prose flex-col gap-4" onSubmit={(event) => void submit(event)} aria-label="Connect an agent">
      <h2 className="font-display text-lead-phone font-black">Connect an agent</h2>
      <p>An agent (Claude, say) finds jobs and drafts follow-ups through a key you can revoke any time. It can never send or approve email.</p>
      {created === null ? (
        <>
          <Field label="Name the agent">
            <TextInput name="name" defaultValue="Claude" required maxLength={60} />
          </Field>
          <Button type="submit" variant="primary" className="self-start">
            Create a key
          </Button>
        </>
      ) : (
        <>
          <p>Copy this key now; it is shown once.</p>
          <code className="break-all border border-ink p-2" data-testid="agent-key">
            {created.token}
          </code>
          <p>
            Address for the agent: <code>{window.location.origin}/mcp</code>. Settings has the rest, and the{" "}
            <a href="/api/docs">agent guide</a> says what it can do.
          </p>
          <Button variant="primary" className="self-start" onClick={onDone}>
            Next
          </Button>
        </>
      )}
      {problem === "" ? null : <ErrorLine message={problem} />}
    </form>
  );
};

const PhoneStep = ({ status, onDone }: { status: SetupStatus; onDone: () => void }) => (
  <div className="flex max-w-prose flex-col gap-4">
    <h2 className="font-display text-lead-phone font-black">Open Hussla on your phone</h2>
    <ol className="ml-6 list-decimal">
      <li>
        Install Tailscale on the phone (<a href={TAILSCALE_DOWNLOAD}>tailscale.com/download</a>) and sign in as <b>{status.ownerLogin}</b>.
      </li>
      <li>Turn Tailscale on, then scan this with the camera.</li>
    </ol>
    <img src="/api/setup/qr" alt={`QR code for ${status.address}`} width={192} height={192} className="border border-ink bg-paper" />
    <p>
      Or type <code>{status.address}</code>
    </p>
    <Button variant="primary" className="self-start" onClick={onDone}>
      It opened: next
    </Button>
  </div>
);

const ExpiryStep = ({ status, onDone }: { status: SetupStatus; onDone: () => void }) => (
  <div className="flex max-w-prose flex-col gap-4">
    <h2 className="font-display text-lead-phone font-black">Keep this machine signed in to Tailscale</h2>
    <p>
      Tailscale signs a machine out after a while (about six months), and Hussla goes quiet until someone signs it in again.
      {status.keyExpiry === undefined ? " This one never expires already." : ` This one expires in ${status.keyExpiry.daysLeft} days.`}
    </p>
    <ol className="ml-6 list-decimal">
      <li>
        Open <a href={TAILSCALE_ADMIN_MACHINES}>Tailscale's Machines page</a>.
      </li>
      <li>Find this Hussla, open its ⋯ menu, and choose “Disable key expiry”.</li>
    </ol>
    <Button variant="primary" className="self-start" onClick={onDone}>
      Done
    </Button>
  </div>
);

const SecondPasskeyStep = ({ onDone }: { onDone: () => void }) => {
  const [problem, setProblem] = useState("");
  const add = async () => {
    setProblem("");
    try {
      await api.registerPasskey("Spare passkey");
      onDone();
    } catch (failure) {
      setProblem(describeError(failure));
    }
  };
  return (
    <div className="flex max-w-prose flex-col gap-4">
      <h2 className="font-display text-lead-phone font-black">Add a spare passkey</h2>
      <p>
        If this phone is lost, a second passkey (your laptop, a security key) still gets you in. You tap your current passkey once, then make
        the new one; choose “use another device” in the prompt to make it on a different one.
      </p>
      <Button variant="primary" className="self-start" onClick={() => void add()}>
        Add a spare passkey
      </Button>
      {problem === "" ? null : <ErrorLine message={problem} />}
    </div>
  );
};

// Each step's page; a Record so a new step name fails the typecheck until it has one.
const StepBody = ({ step, status, onDone }: { step: SetupStep; status: SetupStatus; onDone: () => void }): ReactNode => {
  const bodies: Record<SetupStep, () => ReactNode> = {
    mail: () => <MailStep onDone={onDone} />,
    import: () => <ImportStep onDone={onDone} />,
    agent: () => <AgentStep onDone={onDone} />,
    phone: () => <PhoneStep status={status} onDone={onDone} />,
    expiry: () => <ExpiryStep status={status} onDone={onDone} />,
    "second-passkey": () => <SecondPasskeyStep onDone={onDone} />,
  };
  return bodies[step]();
};

type SetupPageProps = { status: SetupStatus; onChange: () => void };

export const SetupPage = ({ status, onChange }: SetupPageProps) => {
  const [problem, setProblem] = useState("");
  const all = visibleSteps(status);
  const left = stepsLeft(status);

  const mark = async (steps: SetupStep[], state: "done" | "skipped") => {
    setProblem("");
    try {
      for (const step of steps) await api.markSetupStep(step, state);
      onChange();
    } catch (failure) {
      setProblem(describeError(failure));
    }
  };

  if (!status.isOwner || status.passkeys === 0) {
    return (
      <Shell kicker="Setup · Step 1">
        <PasskeyStep status={status} onDone={onChange} />
      </Shell>
    );
  }
  const step = left[0];
  if (step === undefined) return null;
  const number = all.indexOf(step) + 2;
  return (
    <Shell kicker={`Setup · Step ${number} of ${all.length + 1} · ${STEP_TITLES[step]}`}>
      <StepBody key={step} step={step} status={status} onDone={() => void mark([step], "done")} />
      <div className="flex flex-wrap gap-2 border-t border-hairline pt-4">
        <Button size="sm" onClick={() => void mark([step], "skipped")}>
          Skip this step
        </Button>
        <Button size="sm" onClick={() => void mark(left, "skipped")}>
          Skip the rest
        </Button>
      </div>
      {problem === "" ? null : <ErrorLine message={problem} />}
    </Shell>
  );
};

// Setup's own frame: no nav, since nothing else works until the passkey exists. No product name either: /api/me isn't open yet.
const Shell = ({ kicker, children }: { kicker: string; children: ReactNode }) => (
  <div className="mx-auto flex max-w-page flex-col gap-6 px-4 py-8 sm:px-8 lg:px-16">
    <PageHead kicker={kicker} title="Setup" />
    <Section kicker="This step">{children}</Section>
  </div>
);

// Someone else on the tailnet: whose it is, and who this browser is signed in as.
export const NotYoursPage = ({ ownerLogin, seenLogin }: { ownerLogin: string; seenLogin: string }) => (
  <div className="mx-auto flex max-w-page flex-col gap-6 px-4 py-8 sm:px-8 lg:px-16">
    <PageHead kicker="Not your Hussla" title="This Hussla belongs to someone else" />
    <p className="max-w-prose" role="alert">
      It belongs to <b>{ownerLogin === "" ? "another Tailscale user" : ownerLogin}</b>, and this device is signed in to Tailscale as{" "}
      <b>{seenLogin}</b>. If it's yours, switch the Tailscale app on this device to that account and reload.
    </p>
    <LinkButton to="/" external className="self-start">
      Reload
    </LinkButton>
  </div>
);
