/*
  Settings → "Add an agent": name it, create its key (passkey tap), then copy a ready setup snippet with the key filled in.
  In the app: the one place in the UI that makes an agent key; the key list below it shows and revokes keys.
  Used by: src/features/settings/SettingsPage.tsx.
  Uses: api.createAgentKey, agentSnippets.

  The key lives only in this component's state: shown once, never logged or stored, and gone on "Done" or on leaving the page.
*/
import { useState } from "react";
import type { FormEvent } from "react";
import { api, describeError } from "@/shared/api";
import type { AgentKeyCreated } from "@/shared/api";
import { formText } from "@/shared/lib/form";
import { Button, LinkButton } from "@/shared/ui/Button";
import { Callout, ErrorLine, useToast } from "@/shared/ui/Feedback";
import { TextInput } from "@/shared/ui/Form";
import { Section } from "@/shared/ui/Section";
import { agentSnippets } from "./agent-snippets";

export const AddAgent = ({ onKeyCreated }: { onKeyCreated: () => void }) => {
  const [created, setCreated] = useState<AgentKeyCreated | null>(null);
  const [problem, setProblem] = useState("");
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const create = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const name = formText(new FormData(form), "name");
    setProblem("");
    setBusy(true);
    try {
      setCreated(await api.createAgentKey(name));
      form.reset();
      onKeyCreated();
    } catch (failure) {
      setProblem(describeError(failure));
    } finally {
      setBusy(false);
    }
  };
  const copy = async (text: string, what: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.show(`${what} copied`);
    } catch {
      toast.show("Couldn't copy. Select the text and copy it by hand.");
    }
  };
  return (
    <Section kicker="Add an agent">
      <p className="max-w-prose text-muted">Each computer or agent gets its own key, so the activity log shows who did what and you can revoke one without touching the others. Name it, then paste the setup into the agent.</p>
      {created === null ? (
        <form onSubmit={(event) => void create(event)} className="flex max-w-xl flex-wrap gap-2">
          <TextInput name="name" aria-label="Agent name" placeholder="Name, e.g. Laptop Claude Code" required className="min-w-0 flex-1" />
          <Button type="submit" variant="primary" disabled={busy}>Create key</Button>
        </form>
      ) : (
        <AgentSetup created={created} copy={copy} onDone={() => setCreated(null)} />
      )}
      {problem === "" ? null : <ErrorLine message={problem} />}
      <LinkButton size="sm" external to="/api/docs" className="self-start">Read the agent guide</LinkButton>
    </Section>
  );
};

const AgentSetup = ({ created, copy, onDone }: { created: AgentKeyCreated; copy: (text: string, what: string) => Promise<void>; onDone: () => void }) => {
  // The address this page was opened at is the one the agent's machine can reach (tailnet name or localhost), so no name is hard-coded.
  const snippets = agentSnippets(window.location.origin, created.token);
  return (
    <div className="flex flex-col gap-4">
      <Callout tone="warn" title="Copy this now" role="status">
        The key for <b>{created.name}</b> is in every snippet below. It won't be shown again; if you lose it, revoke it and add the agent again.
      </Callout>
      {snippets.map((snippet) => (
        <div key={snippet.id} className="flex flex-col gap-2 border-t border-hairline pt-2">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h3 className="kicker">{snippet.title}</h3>
            <Button size="sm" aria-label={`Copy ${snippet.title} setup`} onClick={() => void copy(snippet.text, snippet.title)}>Copy</Button>
          </div>
          <p className="text-small text-muted">{snippet.hint}</p>
          {/* Wrapped, not scrolled: a long key must not push the page sideways on a phone. */}
          <pre className="border border-ink p-2 font-mono text-small break-all whitespace-pre-wrap">{snippet.text}</pre>
        </div>
      ))}
      <Button className="self-start" onClick={onDone}>Done, hide the key</Button>
    </div>
  );
};
