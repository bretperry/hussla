/*
  Mail setup: pick the provider, follow its steps to make an app password or API key, save, then send a test to yourself.
  In the app: the wizard's mail step, and "/setup/mail" to change it later.
  Used by: src/features/setup/SetupPage.tsx, src/app/App.tsx (the "/setup/mail" route).
  Uses: api.mailProviders / mailSettings / saveMailSettings / sendTestEmail (the catalog lives in internal/config on the server).

  Save and the test are two buttons, one passkey tap each: a browser only shows a passkey prompt
  shortly after a click, so a second prompt chained after the first one's network round trips is
  refused (Firefox measured it as "cancelled or timed out").

  The password never comes back from the server: a saved one shows as "stored", and leaving the
  field empty keeps it. The test goes to your own From address only; nothing else is ever sent
  from here.
*/
import { useState } from "react";
import type { FormEvent } from "react";
import { api, describeError } from "@/shared/api";
import type { MailProvider, MailSettings, MailSettingsSave } from "@/shared/api";
import { formText } from "@/shared/lib/form";
import { useResource } from "@/shared/lib/use-resource";
import { Button } from "@/shared/ui/Button";
import { Callout, ErrorLine, LoadingLine } from "@/shared/ui/Feedback";
import { Field, FieldRow, SelectInput, TextInput } from "@/shared/ui/Form";

type Loaded = { providers: MailProvider[]; settings: MailSettings };

// The save body from the form: only the fields this provider uses, and the secret only when typed.
const saveBody = (data: FormData, provider: MailProvider): MailSettingsSave => {
  const fromAddress = formText(data, "fromAddress");
  const secret = formText(data, "secret");
  const body: MailSettingsSave = {
    providerId: provider.id,
    fromAddress,
    fromName: formText(data, "fromName"),
    username: formText(data, "username") === "" ? fromAddress : formText(data, "username"),
  };
  if (secret !== "") body.secret = secret;
  if (provider.needsServer) {
    body.host = formText(data, "host");
    body.port = Number(formText(data, "port"));
    body.security = formText(data, "security");
  }
  if (provider.regions.length > 0) body.region = formText(data, "region");
  if (provider.needsDomain) body.domain = formText(data, "domain");
  return body;
};

const ProviderSteps = ({ provider }: { provider: MailProvider }) => (
  <div className="flex flex-col gap-2">
    {provider.warning === "" ? null : <Callout tone="warn">{provider.warning}</Callout>}
    {provider.helpSteps.length === 0 ? null : (
      <ol className="ml-6 list-decimal">
        {provider.helpSteps.map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>
    )}
    <div className="flex flex-wrap gap-4 text-small">
      {provider.credentialUrl === "" ? null : (
        <a href={provider.credentialUrl} target="_blank" rel="noreferrer">
          Make the {provider.secretLabel.toLowerCase()} ↗
        </a>
      )}
      {provider.docsUrl === "" ? null : (
        <a href={provider.docsUrl} target="_blank" rel="noreferrer">
          {provider.label}'s help ↗
        </a>
      )}
    </div>
  </div>
);

export const MailStep = ({ onDone }: { onDone: () => void }) => {
  const loaded = useResource(async (): Promise<Loaded> => {
    const [providers, settings] = await Promise.all([api.mailProviders(), api.mailSettings()]);
    return { providers, settings };
  }, []);
  const [chosenId, setChosenId] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const [savedAs, setSavedAs] = useState("");
  const [sentTo, setSentTo] = useState("");

  if (loaded.error !== null) return <ErrorLine message={describeError(loaded.error)} />;
  if (loaded.data === null) return <LoadingLine label="Loading mail providers" />;
  const { providers, settings } = loaded.data;
  const providerId = chosenId !== "" ? chosenId : settings.providerId !== "" ? settings.providerId : (providers[0]?.id ?? "");
  const provider = providers.find((candidate) => candidate.id === providerId);
  const keepsSecret = settings.hasSecret && settings.providerId === providerId;

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (provider === undefined) return;
    const body = saveBody(new FormData(event.currentTarget), provider);
    setBusy(true);
    setProblem("");
    try {
      await api.saveMailSettings(body);
      setSavedAs(body.fromAddress);
      setSentTo("");
    } catch (failure) {
      setProblem(describeError(failure));
    } finally {
      setBusy(false);
    }
  };

  // Its own click, so its passkey prompt starts from a fresh user gesture.
  const sendTest = async () => {
    setBusy(true);
    setProblem("");
    try {
      await api.sendTestEmail();
      setSentTo(savedAs);
    } catch (failure) {
      setProblem(describeError(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="flex max-w-prose flex-col gap-4" onSubmit={(event) => void submit(event)} aria-label="Mail setup">
      <h2 className="font-display text-lead-phone font-black">Send follow-ups from your own address</h2>
      <p>Hussla only sends what you approve, one at a time. Pick who handles your email.</p>
      <Field label="Email provider">
        <SelectInput name="providerId" value={providerId} onChange={(event) => setChosenId(event.target.value)}>
          {providers.map((candidate) => (
            <option key={candidate.id} value={candidate.id}>
              {candidate.label}
            </option>
          ))}
        </SelectInput>
      </Field>
      {provider === undefined ? null : (
        <>
          <ProviderSteps provider={provider} />
          <FieldRow>
            <Field label="Your name">
              <TextInput name="fromName" defaultValue={settings.fromName} autoComplete="name" />
            </Field>
            <Field label="Your email address">
              <TextInput name="fromAddress" type="email" defaultValue={settings.fromAddress} autoComplete="email" required />
            </Field>
          </FieldRow>
          {provider.kind === "smtp" ? (
            <Field label="Username" hint={provider.usernameHint === "" ? "Usually your email address; leave empty to use it." : provider.usernameHint}>
              <TextInput name="username" defaultValue={settings.username} autoComplete="username" />
            </Field>
          ) : null}
          <Field label={provider.secretLabel} hint={keepsSecret ? "One is stored. Leave this empty to keep it." : "Pasted once; Hussla never shows it again."}>
            <TextInput name="secret" type="password" autoComplete="new-password" required={!keepsSecret} spellCheck={false} />
          </Field>
          {provider.needsServer ? (
            <FieldRow>
              <Field label="Server">
                <TextInput name="host" defaultValue={settings.host} placeholder="smtp.example.com" required />
              </Field>
              <Field label="Port">
                <TextInput name="port" inputMode="numeric" defaultValue={settings.port === 0 ? "587" : String(settings.port)} required />
              </Field>
              <Field label="Security">
                <SelectInput name="security" defaultValue={settings.security === "" ? "starttls" : settings.security}>
                  <option value="starttls">STARTTLS (port 587)</option>
                  <option value="tls">TLS (port 465)</option>
                </SelectInput>
              </Field>
            </FieldRow>
          ) : null}
          {provider.regions.length === 0 ? null : (
            <Field label="Region">
              <SelectInput name="region" defaultValue={settings.region === "" ? provider.regions[0]?.id : settings.region}>
                {provider.regions.map((region) => (
                  <option key={region.id} value={region.id}>
                    {region.label}
                  </option>
                ))}
              </SelectInput>
            </Field>
          )}
          {provider.needsDomain ? (
            <Field label="Sending domain" hint="The domain you verified with the provider.">
              <TextInput name="domain" defaultValue={settings.domain} placeholder="mail.example.com" required />
            </Field>
          ) : null}
        </>
      )}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant={savedAs === "" ? "primary" : "secondary"} disabled={busy || provider === undefined}>
          Save
        </Button>
        {savedAs === "" ? null : (
          <Button variant={sentTo === "" ? "primary" : "secondary"} disabled={busy} onClick={() => void sendTest()}>
            Send me a test
          </Button>
        )}
        {sentTo === "" ? null : (
          <Button variant="primary" onClick={onDone}>It arrived: next</Button>
        )}
      </div>
      {savedAs === "" || sentTo !== "" ? null : <p role="status">Saved. Now send yourself a test.</p>}
      {sentTo === "" ? null : <p role="status">A test is on its way to {sentTo}; check that inbox (and spam).</p>}
      {problem === "" ? null : <ErrorLine message={problem} />}
    </form>
  );
};
