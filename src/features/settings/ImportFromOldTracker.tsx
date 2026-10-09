/*
  "Import from the old tracker": pick the backup file downloaded from the prototype, tap the passkey, see what came over.
  In the app: a section of Settings ("/settings"); owner-only, like everything there.
  Used by: SettingsPage.tsx.
  Uses: api.importBundle (POST /api/import).

  Safe to run again: records already here win, so a second import adds nothing. No imported email
  is approved; the result says how many wait in the Outbox, and that keys and passwords never come over.
*/
import { useState } from "react";
import type { ChangeEvent } from "react";
import { api, describeError } from "@/shared/api";
import type { ImportResult } from "@/shared/api";
import { Callout, ErrorLine } from "@/shared/ui/Feedback";
import { Section } from "@/shared/ui/Section";

const added = (result: ImportResult): string => {
  const parts: [number, string, string][] = [
    [result.jobs, "job", "jobs"], [result.companies, "company", "companies"], [result.answers, "answer", "answers"],
    [result.emails, "email", "emails"], [result.events, "activity line", "activity lines"],
  ];
  const named = parts.filter(([count]) => count > 0).map(([count, one, many]) => `${count} ${count === 1 ? one : many}`);
  return named.length === 0 ? "Nothing new: everything in that file is already here." : `Added ${named.join(", ")}.`;
};

export const ImportFromOldTracker = () => {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [problem, setProblem] = useState("");
  const pick = async (event: ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    const file = input.files?.[0];
    if (file === undefined) return;
    setBusy(true);
    setProblem("");
    setResult(null);
    try {
      setResult(await api.importBundle(file));
    } catch (failure) {
      setProblem(describeError(failure));
    } finally {
      setBusy(false);
      input.value = ""; // the same file can be picked again
    }
  };
  return (
    <Section kicker="Import from the old tracker">
      <p className="max-w-prose text-muted">In the old tracker, open Settings and download the JSON backup. Pick that file here. Anything already in Hussla stays as it is, so importing twice is safe.</p>
      <label className="self-start">
        <span className="box-border inline-flex h-touch cursor-pointer items-center border border-ink px-4 font-semibold lg:h-8 lg:text-small">{busy ? "Importing…" : "Choose the backup file"}</span>
        <input type="file" accept=".json,application/json" className="sr-only" aria-label="Choose the backup file" disabled={busy} onChange={(event) => void pick(event)} />
      </label>
      {problem === "" ? null : <ErrorLine message={problem} />}
      {result === null ? null : (
        <Callout tone="note" title={added(result)} role="status">
          <ul className="list-disc pl-5">
            {result.notices.map((notice) => <li key={notice}>{notice}</li>)}
          </ul>
          {result.warnings.length === 0 ? null : (
            <details className="mt-2">
              <summary className="cursor-pointer">{result.warnings.length} {result.warnings.length === 1 ? "thing" : "things"} worth a look</summary>
              <ul className="list-disc pl-5 text-small">{result.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>
            </details>
          )}
        </Callout>
      )}
    </Section>
  );
};
