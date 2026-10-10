/*
  Search now: the Jobs page button that starts the owner's Claude job-search routine, and its setup in Settings.
  In the app: "/jobs" (SearchNowButton in the page head) and "/settings" (SearchRoutineSettings, the "Job search routine" section).
  Used by: src/features/jobs/JobsPage.tsx, src/features/settings/SettingsPage.tsx.
  Uses: api.getSearchRoutine / saveSearchRoutine (a passkey tap) / runSearch.

  The routine runs in Claude's cloud and writes jobs back over the agent API like any agent; this
  page only starts it and links to the run. The token is write-only: the server says whether one is
  stored, never what it is, so the token field always starts empty.
*/
import { useState } from "react";
import type { FormEvent } from "react";
import { api, describeError } from "@/shared/api";
import type { SearchRun } from "@/shared/api";
import { formatWhen } from "@/shared/lib/format";
import { useResource } from "@/shared/lib/use-resource";
import { Button, LinkButton } from "@/shared/ui/Button";
import { ErrorLine, LoadingLine, useToast } from "@/shared/ui/Feedback";
import { Field, TextInput } from "@/shared/ui/Form";
import { Section } from "@/shared/ui/Section";

// Where the owner makes the routine and its API trigger.
const ROUTINES_PAGE = "https://claude.ai/code/routines";

// The Jobs page button: starts a search, then offers the link to watch it. Unset, it leads to Settings.
export const SearchNowButton = () => {
  const routine = useResource(() => api.getSearchRoutine(), []);
  const [busy, setBusy] = useState(false);
  const [started, setStarted] = useState<SearchRun | null>(null);
  const toast = useToast();
  if (routine.data === null) {
    return routine.error === null ? null : <span role="alert" className="self-center text-small text-accent">Search now: {describeError(routine.error)}</span>;
  }
  if (!routine.data.configured) {
    return <LinkButton to="/settings">Set up Search now</LinkButton>;
  }
  const start = async () => {
    setBusy(true);
    try {
      setStarted(await api.runSearch());
      toast.show("Search started. New jobs land in Review as Claude finds them.");
    } catch (failure) {
      toast.show(describeError(failure));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-wrap gap-2">
      {started !== null && started.sessionUrl !== null ? (
        <LinkButton to={started.sessionUrl} external target="_blank" rel="noreferrer">Watch the search</LinkButton>
      ) : null}
      <Button disabled={busy} onClick={() => void start()}>{busy ? "Starting…" : "Search now"}</Button>
    </div>
  );
};

// Settings → Job search routine: which routine Search now starts, and its token.
export const SearchRoutineSettings = () => {
  const routine = useResource(() => api.getSearchRoutine(), []);
  const [routineText, setRoutineText] = useState<string | null>(null);
  const [token, setToken] = useState("");
  const [problem, setProblem] = useState("");
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const current = routine.data;
  // The field shows the saved id until the owner types, so a token-only change needs no retyping.
  const routineValue = routineText ?? current?.routineId ?? "";
  const save = async (event: FormEvent) => {
    event.preventDefault();
    setProblem("");
    setBusy(true);
    try {
      await api.saveSearchRoutine({ routine: routineValue, ...(token.trim() === "" ? {} : { token }) });
      setToken("");
      setRoutineText(null);
      routine.reload();
      toast.show("Saved. Search now is ready on the Jobs page.");
    } catch (failure) {
      setProblem(describeError(failure));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Section kicker="Job search routine">
      {current === null ? (routine.error === null ? <LoadingLine /> : <ErrorLine message={describeError(routine.error)} />) : (
        <>
          {current.configured ? (
            <p>
              Search now starts <b>{current.routineId}</b>.{" "}
              {current.lastRunAt === null ? "It hasn't run from here yet." : <>Last started {formatWhen(current.lastRunAt, { withTime: true })}{current.lastSessionUrl === null ? "." : <>: <a href={current.lastSessionUrl} target="_blank" rel="noreferrer">watch it</a>.</>}</>}
            </p>
          ) : (
            <p className="text-muted">
              Not set up yet. In <a href={ROUTINES_PAGE} target="_blank" rel="noreferrer">Claude routines</a>, open your job-search routine, choose Edit, then Add another trigger → API. Copy its URL, click Generate token, and paste both here.
            </p>
          )}
          <form className="flex flex-col gap-4" onSubmit={(event) => void save(event)}>
            <Field label="Routine URL or id" hint="The API trigger's URL (…/routines/trig_…/fire) or just the trig_… id.">
              <TextInput value={routineValue} onChange={(event) => setRoutineText(event.target.value)} placeholder="https://api.anthropic.com/v1/claude_code/routines/trig_…/fire" autoComplete="off" spellCheck={false} />
            </Field>
            <Field label="Routine token" hint={current.hasToken ? "Leave empty to keep the saved token." : "Shown once when you generate it. Stored encrypted; never shown again."}>
              <TextInput type="password" value={token} onChange={(event) => setToken(event.target.value)} placeholder={current.hasToken ? "Saved" : "sk-ant-oat01-…"} autoComplete="off" />
            </Field>
            <Button type="submit" size="sm" className="self-start" disabled={busy || routineValue.trim() === ""}>Save routine</Button>
          </form>
        </>
      )}
      {problem === "" ? null : <ErrorLine message={problem} />}
    </Section>
  );
};
