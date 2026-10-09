/*
  Settings: "Add an agent", agent keys, email sending, search settings, passkeys and backup.
  In the app: "/settings". Every change here is owner-only and asks for a passkey tap first.
  Used by: src/app/App.tsx.
  Uses: api.* for keys, mail, config, passkeys and sessions; AddAgent for the key-and-snippet flow.

  A new key's secret is shown once, in AddAgent, and never again (the server keeps only its hash).
*/
import { useState } from "react";
import { api, describeError } from "@/shared/api";
import type { AgentKey, Me } from "@/shared/api";
import { formatWhen } from "@/shared/lib/format";
import { useResource } from "@/shared/lib/use-resource";
import type { Resource } from "@/shared/lib/use-resource";
import { Button, LinkButton } from "@/shared/ui/Button";
import { Callout, ErrorLine, LoadingLine, useToast } from "@/shared/ui/Feedback";
import { PageHead, Section } from "@/shared/ui/Section";
import { AddAgent } from "./AddAgent";

// Search settings worth naming; anything else an agent stored is listed below them as it is.
const KNOWN_SETTINGS = new Set(["paused", "updatedAt"]);

const AgentKeys = ({ keys }: { keys: Resource<AgentKey[]> }) => {
  const [problem, setProblem] = useState("");
  const revoke = async (keyId: string) => {
    if (!window.confirm("Revoke this key? Agents using it will stop working.")) return;
    try {
      await api.revokeAgentKey(keyId);
      keys.reload();
    } catch (failure) {
      setProblem(describeError(failure));
    }
  };
  return (
    <Section kicker="Agent keys">
      {problem === "" ? null : <ErrorLine message={problem} />}
      {keys.data === null ? <LoadingLine /> : keys.data.length === 0 ? <p className="text-muted">No keys yet. Add an agent above.</p> : (
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

export const SettingsPage = ({ me }: { me: Me }) => {
  // One list for both sections, so a key made in "Add an agent" shows up in the list at once.
  const keys = useResource(() => api.listAgentKeys(), []);
  return (
    <>
      <PageHead kicker="Settings" title="Agents, mail and keys" />
      <AddAgent onKeyCreated={keys.reload} />
      <AgentKeys keys={keys} />
      <Mail />
      <SearchSettings />
      <Security me={me} />
    </>
  );
};
