/*
  Settings: agent keys, the "Add an agent" slot, email sending, search settings, passkeys and backup.
  In the app: "/settings". Every change here is owner-only and asks for a passkey tap first.
  Used by: src/app/App.tsx.
  Uses: api.* for keys, mail, config, passkeys and sessions.

  A new key's secret is shown once, here, and never again (the server keeps only its hash).
  The "Add an agent" snippet for Claude Code, Claude Desktop and Cursor lands with the MCP endpoint (Phase 3b).
*/
import { useState } from "react";
import type { FormEvent } from "react";
import { api, describeError } from "@/shared/api";
import type { AgentKeyCreated, Me } from "@/shared/api";
import { formText } from "@/shared/lib/form";
import { formatWhen } from "@/shared/lib/format";
import { useResource } from "@/shared/lib/use-resource";
import { Button, LinkButton } from "@/shared/ui/Button";
import { Callout, ErrorLine, LoadingLine, useToast } from "@/shared/ui/Feedback";
import { TextInput } from "@/shared/ui/Form";
import { PageHead, Section } from "@/shared/ui/Section";

// Search settings worth naming; anything else an agent stored is listed below them as it is.
const KNOWN_SETTINGS = new Set(["paused", "updatedAt"]);

const AgentKeys = () => {
  const keys = useResource(() => api.listAgentKeys(), []);
  const [created, setCreated] = useState<AgentKeyCreated | null>(null);
  const [problem, setProblem] = useState("");
  const toast = useToast();
  const create = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const name = formText(new FormData(form), "name");
    setProblem("");
    try {
      setCreated(await api.createAgentKey(name));
      form.reset();
      keys.reload();
    } catch (failure) {
      setProblem(describeError(failure));
    }
  };
  const revoke = async (keyId: string) => {
    if (!window.confirm("Revoke this key? Agents using it will stop working.")) return;
    try {
      await api.revokeAgentKey(keyId);
      keys.reload();
    } catch (failure) {
      setProblem(describeError(failure));
    }
  };
  const copy = async (secret: string) => {
    try {
      await navigator.clipboard.writeText(secret);
      toast.show("Key copied");
    } catch {
      toast.show("Couldn't copy. Select the key and copy it by hand.");
    }
  };
  return (
    <Section kicker="Agent keys">
      <p className="max-w-prose text-muted">Each computer or agent gets its own key, so the activity log shows who did what and you can revoke one without touching the others.</p>
      <form onSubmit={(event) => void create(event)} className="flex max-w-xl gap-2">
        <TextInput name="name" aria-label="Key name" placeholder="Name, e.g. Laptop agent or Cloud search" required />
        <Button type="submit" variant="primary">Create key</Button>
      </form>
      {problem === "" ? null : <ErrorLine message={problem} />}
      {created === null ? null : (
        <Callout tone="warn" title="Copy this key now" role="status">
          It won't be shown again.
          <code className="my-2 block overflow-x-auto border border-ink p-2 font-mono text-small">{created.token}</code>
          <Button size="sm" onClick={() => void copy(created.token)}>Copy key</Button>
        </Callout>
      )}
      {keys.data === null ? <LoadingLine /> : keys.data.length === 0 ? <p className="text-muted">No keys yet.</p> : (
        <ul>
          {keys.data.map((key) => (
            <li key={key.id} className="flex flex-wrap items-baseline gap-x-4 gap-y-1 border-t border-hairline py-2">
              <b className="min-w-40">{key.name}</b>
              <span className="flex-1 text-small text-muted">created {formatWhen(key.createdAt)} · {key.lastUsedAt === null ? "never used" : `last used ${formatWhen(key.lastUsedAt, { withTime: true })}`}</span>
              {key.revokedAt === null ? <Button size="sm" variant="danger" onClick={() => void revoke(key.id)}>Revoke</Button> : <span className="kicker text-muted">revoked</span>}
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
};

const Mail = () => {
  const mail = useResource(() => api.mailStatus(), []);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const sendTest = async () => {
    setBusy(true);
    try {
      await api.sendTestEmail();
      toast.show("Test sent. Check your inbox.");
    } catch (failure) {
      toast.show(describeError(failure));
    } finally {
      setBusy(false);
    }
  };
  const status = mail.data;
  return (
    <Section kicker="Email sending">
      {status === null ? <LoadingLine /> : status.configured ? (
        <>
          <p>Sending as <b>{status.fromName === "" ? status.from : `${status.fromName} <${status.from}>`}</b> through {status.provider}. {status.sentToday} of {status.dailyLimit} sent today; {status.hours}; {status.minGapMinutes}+ minutes apart.</p>
          <Button size="sm" className="self-start" disabled={busy} onClick={() => void sendTest()}>Send a test email to myself</Button>
        </>
      ) : <p className="text-muted">Not set up yet. Finish mail setup on the server, then it appears here.</p>}
    </Section>
  );
};

const SearchSettings = () => {
  const config = useResource(() => api.getSearchConfig(), []);
  const [problem, setProblem] = useState("");
  const toggle = async (paused: boolean) => {
    setProblem("");
    try {
      await api.setPaused(paused);
      config.reload();
    } catch (failure) {
      setProblem(describeError(failure));
    }
  };
  const settings = config.data;
  const others = settings === null ? [] : Object.entries(settings).filter(([key, value]) => !KNOWN_SETTINGS.has(key) && (typeof value === "string" || typeof value === "number" || typeof value === "boolean"));
  return (
    <Section kicker="Search settings">
      {settings === null ? <LoadingLine /> : (
        <>
          <p>Agents are <b>{settings.paused === true ? "paused (they only read)" : "running"}</b>.</p>
          <Button size="sm" className="self-start" onClick={() => void toggle(settings.paused !== true)}>{settings.paused === true ? "Resume agents" : "Pause agents"}</Button>
          {others.length === 0 ? null : (
            <dl>{others.map(([key, value]) => (
              <div key={key} className="flex items-baseline justify-between gap-4 border-t border-hairline py-2"><dt className="kicker">{key}</dt><dd>{String(value)}</dd></div>))}
            </dl>
          )}
        </>
      )}
      {problem === "" ? null : <ErrorLine message={problem} />}
    </Section>
  );
};

const Security = ({ me }: { me: Me }) => {
  const passkeys = useResource(() => api.listPasskeys().catch(() => []), []);
  const toast = useToast();
  const signOut = async () => {
    try {
      await api.signOutEverywhere();
      toast.show("Signed out everywhere.");
    } catch (failure) {
      toast.show(describeError(failure));
    }
  };
  return (
    <Section kicker="Backup & security">
      <div className="flex flex-wrap gap-2">
        <LinkButton size="sm" external to="/api/export" download="hussla-backup.json">Download backup (JSON)</LinkButton>
        <Button size="sm" onClick={() => void signOut()}>Sign out everywhere</Button>
      </div>
      <p className="text-small text-muted">Signed in as {me.name}{me.login === undefined || me.login === "" ? "" : ` (${me.login})`} through {me.kind === "agent" ? "an agent key" : "your device"}.</p>
      {(passkeys.data ?? []).length === 0 ? null : (
        <ul>{(passkeys.data ?? []).map((key) => <li key={key.id} className="border-t border-hairline py-2"><b>{key.name}</b> <span className="text-small text-muted">works on {key.rpId} · last used {key.lastUsedAt === null ? "never" : formatWhen(key.lastUsedAt)}</span></li>)}</ul>
      )}
      <Callout title="About secrets">Stored secrets (mail passwords, agent keys) are encrypted with a key file that sits beside the data. That protects a leaked backup or log, not someone who holds the whole volume.</Callout>
    </Section>
  );
};

export const SettingsPage = ({ me }: { me: Me }) => (
  <>
    <PageHead kicker="Settings" title="Agents, mail and keys" />
    <AgentKeys />
    <Section kicker="Add an agent">
      <p className="max-w-prose text-muted">A copy-and-paste setup for Claude Code, Claude Desktop and Cursor is coming here. Until then, create a key above and point your agent at the guide.</p>
      <LinkButton size="sm" external to="/api/docs" className="self-start">Read the agent guide</LinkButton>
    </Section>
    <Mail />
    <SearchSettings />
    <Security me={me} />
  </>
);
