/*
  Two versions of one pitch side by side: a word-level diff, the word count and speaking time of each, and "Make live" on either.
  In the app: the open pitch on the Pitches page, whenever it has two or more versions.
  Used by: src/features/pitches/PitchesPage.tsx.
  Uses: words.ts (diffWords, countWords, speakingSeconds), src/shared/ui.

  The left side is "before" and the right "after": words only on the left are struck through, words
  only on the right are underlined. Neither uses red (the Gazette keeps red for urgent and live).
*/
import type { PitchVersion } from "@/shared/api";
import { formatWhen } from "@/shared/lib/format";
import { Button } from "@/shared/ui/Button";
import { Tag } from "@/shared/ui/Feedback";
import { Field, SelectInput } from "@/shared/ui/Form";
import { countWords, diffWords, formatSpeakingTime, sideOf, speakingSeconds } from "./words";
import type { DiffPart } from "./words";

type PitchCompareProps = {
  versions: readonly PitchVersion[];
  liveVersion: number;
  pair: readonly [number, number];
  wordsPerMinute: number;
  onPick: (pair: readonly [number, number]) => void;
  onMakeLive: (version: number) => void;
};

const versionLabel = (version: PitchVersion, live: number): string =>
  `Version ${version.version}${version.version === live ? " (live)" : ""} · ${version.writer === "owner" ? "you" : version.author}`;

const DiffText = ({ parts, side }: { parts: readonly DiffPart[]; side: "before" | "after" }) => (
  <p className="font-display text-prose italic" data-side={side}>
    {sideOf(parts, side).map((part, index) => {
      const spacer = index === 0 ? "" : " ";
      if (part.kind === "removed") return <span key={index}>{spacer}<del className="text-muted line-through decoration-1">{part.text}</del></span>;
      if (part.kind === "added") return <span key={index}>{spacer}<ins className="font-semibold underline decoration-2 underline-offset-4">{part.text}</ins></span>;
      return <span key={index}>{spacer}{part.text}</span>;
    })}
  </p>
);

const Side = ({ version, live, side, parts, wordsPerMinute, versions, onChoose, onMakeLive }: {
  version: PitchVersion;
  live: number;
  side: "before" | "after";
  parts: readonly DiffPart[];
  wordsPerMinute: number;
  versions: readonly PitchVersion[];
  onChoose: (number: number) => void;
  onMakeLive: (version: number) => void;
}) => {
  const words = countWords(version.text);
  return (
    <div className="flex flex-col gap-2" data-compare={side}>
      <Field label={side === "before" ? "Compare" : "With"}>
        <SelectInput value={version.version} onChange={(event) => onChoose(Number(event.target.value))}>
          {versions.map((candidate) => (
            <option key={candidate.version} value={candidate.version}>
              {versionLabel(candidate, live)}
            </option>
          ))}
        </SelectInput>
      </Field>
      <DiffText parts={parts} side={side} />
      <p className="kicker text-muted">
        {words} words · {formatSpeakingTime(speakingSeconds(words, wordsPerMinute))} to say · {formatWhen(version.createdAt)}
      </p>
      {version.note === "" ? null : <p className="text-small text-muted">Note: {version.note}</p>}
      <div>
        {version.version === live ? (
          <Tag urgent>Live</Tag>
        ) : (
          <Button size="sm" onClick={() => onMakeLive(version.version)}>
            Make version {version.version} live
          </Button>
        )}
      </div>
    </div>
  );
};

export const PitchCompare = ({ versions, liveVersion, pair, wordsPerMinute, onPick, onMakeLive }: PitchCompareProps) => {
  const before = versions.find((version) => version.version === pair[0]);
  const after = versions.find((version) => version.version === pair[1]);
  if (before === undefined || after === undefined) return null;
  const parts = diffWords(before.text, after.text);
  const delta = countWords(after.text) - countWords(before.text);
  const seconds = speakingSeconds(countWords(after.text), wordsPerMinute) - speakingSeconds(countWords(before.text), wordsPerMinute);
  return (
    <section aria-label="Compare versions" className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Side version={before} live={liveVersion} side="before" parts={parts} wordsPerMinute={wordsPerMinute} versions={versions} onChoose={(number) => onPick([number, pair[1]])} onMakeLive={onMakeLive} />
        <Side version={after} live={liveVersion} side="after" parts={parts} wordsPerMinute={wordsPerMinute} versions={versions} onChoose={(number) => onPick([pair[0], number])} onMakeLive={onMakeLive} />
      </div>
      <p className="kicker" aria-label="Difference">
        Version {after.version} vs {before.version}: {delta === 0 ? "same length" : `${delta > 0 ? "+" : "−"}${Math.abs(delta)} words`}
        {seconds === 0 ? "" : ` · ${seconds > 0 ? "+" : "−"}${formatSpeakingTime(Math.abs(seconds))}`}
      </p>
    </section>
  );
};
