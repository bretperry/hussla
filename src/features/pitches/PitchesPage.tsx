/*
  The Pitches page: the owner's ten pitches with their live version, and for the open one its history, a writer for a new version, and a two-version compare.
  In the app: "/pitches" (the billboard links to "/pitches?slot=N", which opens that pitch). Agents add versions over the API; the owner picks what goes live.
  Used by: src/app/App.tsx.
  Uses: api.listPitches / createPitch / patchPitch / addPitchVersion / setLivePitch / deletePitchVersion / deletePitch, PitchCompare.tsx, words.ts.

  Making a version live and deleting each ask for a passkey tap (api.ts runs the step-up). Pitch
  text is untrusted (agents write it), so it is rendered as plain text, never markup. The knobs
  (slots, length limit, speaking pace) come from the server with the list, so the page and the
  server never disagree about them.
*/
import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { api, describeError } from "@/shared/api";
import type { Pitch, PitchList, PitchSettings, PitchVersion } from "@/shared/api";
import { formText } from "@/shared/lib/form";
import { formatWhen } from "@/shared/lib/format";
import { useLocation } from "@/shared/lib/router";
import { useResource } from "@/shared/lib/use-resource";
import { Button } from "@/shared/ui/Button";
import { ErrorLine, LoadingLine, Tag, useToast } from "@/shared/ui/Feedback";
import { Field, FieldRow, TextArea, TextInput } from "@/shared/ui/Form";
import { PageHead, Section } from "@/shared/ui/Section";
import { PitchCompare } from "./PitchCompare";
import { countWords, formatSpeakingTime, speakingSeconds } from "./words";

type Run = (work: () => Promise<unknown>, done: string) => Promise<boolean>;

const liveOf = (pitch: Pitch): PitchVersion | undefined => pitch.versions.find((version) => version.version === pitch.liveVersion);

// The pair the compare view opens on: the live version against the newest other one.
const defaultPair = (pitch: Pitch): readonly [number, number] | null => {
  const others = pitch.versions.filter((version) => version.version !== pitch.liveVersion);
  const newestOther = others.at(-1);
  return newestOther === undefined ? null : [pitch.liveVersion, newestOther.version];
};

const timing = (text: string, wordsPerMinute: number): string => {
  const words = countWords(text);
  return `${words} words · ${formatSpeakingTime(speakingSeconds(words, wordsPerMinute))}`;
};

// The new-version writer: counts words, time and characters as the owner types.
const Writer = ({ pitch, settings, run }: { pitch: Pitch; settings: PitchSettings; run: Run }) => {
  const [text, setText] = useState("");
  const [note, setNote] = useState("");
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (text.trim() === "") return;
    if (await run(() => api.addPitchVersion(pitch.slot, { text, note }), "Version added")) {
      setText("");
      setNote("");
    }
  };
  const left = settings.maxCharacters - text.length;
  return (
    <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-2" aria-label={`New version of ${pitch.title}`}>
      <Field label="New version" hint={`${timing(text, settings.wordsPerMinute)} · ${left} characters left`}>
        <TextArea value={text} maxLength={settings.maxCharacters} onChange={(event) => setText(event.target.value)} placeholder={liveOf(pitch)?.text ?? ""} />
      </Field>
      <Field label="Note (why it changed)">
        <TextInput value={note} onChange={(event) => setNote(event.target.value)} />
      </Field>
      <div>
        <Button type="submit" variant="primary" disabled={text.trim() === ""}>
          Add version
        </Button>
      </div>
    </form>
  );
};

const History = ({ pitch, settings, onMakeLive, run }: { pitch: Pitch; settings: PitchSettings; onMakeLive: (version: number) => void; run: Run }) => (
  <ol aria-label="Versions" className="flex flex-col">
    {pitch.versions.toReversed().map((version) => (
      <li key={version.version} data-version={version.version} className="flex flex-col gap-2 border-t border-hairline py-2 lg:flex-row lg:items-baseline lg:gap-4">
        <span className="kicker shrink-0">v{version.version}</span>
        <span className="min-w-0 flex-1">
          <span className="block">{version.text}</span>
          <span className="block text-small text-muted">
            {version.writer === "owner" ? "You" : version.author} · {formatWhen(version.createdAt)} · {timing(version.text, settings.wordsPerMinute)}
            {version.note === "" ? "" : ` · ${version.note}`}
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-2">
          {version.version === pitch.liveVersion ? (
            <Tag urgent>Live</Tag>
          ) : (
            <>
              <Button size="sm" onClick={() => onMakeLive(version.version)}>Make live</Button>
              <Button
                size="sm"
                variant="danger"
                aria-label={`Delete version ${version.version}`}
                onClick={() => {
                  if (window.confirm(`Delete version ${version.version}? This can't be undone.`)) void run(() => api.deletePitchVersion(pitch.slot, version.version), "Version deleted");
                }}
              >
                Delete
              </Button>
            </>
          )}
        </span>
      </li>
    ))}
  </ol>
);

const DetailsForm = ({ pitch, run }: { pitch: Pitch; run: Run }) => {
  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    await run(() => api.patchPitch(pitch.slot, { title: formText(data, "title"), when: formText(data, "when") }), "Saved");
  };
  return (
    <form onSubmit={(event) => void save(event)} className="flex flex-col gap-2" aria-label={`Details of ${pitch.title}`}>
      <FieldRow>
        <Field label="Title">
          <TextInput name="title" defaultValue={pitch.title} required />
        </Field>
        <Field label="When to use it">
          <TextInput name="when" defaultValue={pitch.when} />
        </Field>
      </FieldRow>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm">Save details</Button>
        <Button
          size="sm"
          variant="danger"
          onClick={() => {
            if (window.confirm(`Delete “${pitch.title}” and all ${pitch.versions.length} versions? This can't be undone.`)) void run(() => api.deletePitch(pitch.slot), "Pitch deleted");
          }}
        >
          Delete pitch
        </Button>
      </div>
    </form>
  );
};

const PitchCard = ({ pitch, settings, open, onToggle, run }: { pitch: Pitch; settings: PitchSettings; open: boolean; onToggle: () => void; run: Run }) => {
  const live = liveOf(pitch);
  const [pair, setPair] = useState<readonly [number, number] | null>(() => defaultPair(pitch));
  // A new version (or a deleted one) moves the default pair; a pair the owner picked stays if both still exist.
  const pairStillValid = pair !== null && pair.every((number) => pitch.versions.some((version) => version.version === number));
  const shownPair = pairStillValid ? pair : defaultPair(pitch);
  const makeLive = (version: number) => void run(() => api.setLivePitch(pitch.slot, version), `Version ${version} is live`);
  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-2">
          <h2 className="font-display text-headline-phone font-black lg:text-headline">{pitch.title}</h2>
          {pitch.when === "" ? null : <p className="text-muted">When: {pitch.when}</p>}
        </div>
        <Button size="sm" onClick={onToggle} aria-expanded={open}>
          {open ? "Close" : `Open · ${pitch.versions.length} version${pitch.versions.length === 1 ? "" : "s"}`}
        </Button>
      </div>
      {live === undefined ? null : <blockquote className="max-w-prose font-display text-prose italic">“{live.text}”</blockquote>}
      {open ? (
        <div className="mt-4 flex flex-col gap-6">
          {shownPair === null ? null : (
            <PitchCompare versions={pitch.versions} liveVersion={pitch.liveVersion} pair={shownPair} wordsPerMinute={settings.wordsPerMinute} onPick={setPair} onMakeLive={makeLive} />
          )}
          <Writer pitch={pitch} settings={settings} run={run} />
          <History pitch={pitch} settings={settings} onMakeLive={makeLive} run={run} />
          <DetailsForm pitch={pitch} run={run} />
        </div>
      ) : null}
    </>
  );
};

const StartPitch = ({ slot, settings, run }: { slot: number; settings: PitchSettings; run: Run }) => {
  const [text, setText] = useState("");
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    await run(() => api.createPitch({ slot, title: formText(data, "title"), when: formText(data, "when"), text }), "Pitch started");
  };
  return (
    <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-2" aria-label={`Start pitch ${slot}`}>
      <FieldRow>
        <Field label="Title">
          <TextInput name="title" required placeholder="Why now" />
        </Field>
        <Field label="When to use it">
          <TextInput name="when" placeholder="When they ask about timing" />
        </Field>
      </FieldRow>
      <Field label="The pitch" hint={`${timing(text, settings.wordsPerMinute)} · ${settings.maxCharacters - text.length} characters left`}>
        <TextArea value={text} required maxLength={settings.maxCharacters} onChange={(event) => setText(event.target.value)} />
      </Field>
      <div>
        <Button type="submit" variant="primary">Start pitch</Button>
      </div>
    </form>
  );
};

type SlotProps = { slot: number; pitch: Pitch | undefined; settings: PitchSettings; open: boolean; onToggle: () => void; run: Run };

const Slot = ({ slot, pitch, settings, open, onToggle, run }: SlotProps) => {
  const anchor = useRef<HTMLElement>(null);
  // The billboard's click-through opens a pitch by address; bring it into view once.
  useEffect(() => {
    if (open && typeof anchor.current?.scrollIntoView === "function") anchor.current.scrollIntoView({ block: "start" });
    // Only on first render (empty deps on purpose): later toggles happen where the owner already is.
  }, []);
  const live = pitch === undefined ? undefined : liveOf(pitch);
  return (
    <article ref={anchor} id={`pitch-${slot}`} aria-label={pitch === undefined ? `Pitch ${slot}, empty` : `Pitch ${slot}: ${pitch.title}`} className="flex scroll-mt-4 flex-col gap-2" data-slot={slot}>
      <Section kicker={`No. ${slot}`} urgent={false} aside={live === undefined ? "Empty" : timing(live.text, settings.wordsPerMinute)}>
        {pitch === undefined ? (
          open ? (
            <StartPitch slot={slot} settings={settings} run={run} />
          ) : (
            <div>
              <Button size="sm" onClick={onToggle}>Start pitch {slot}</Button>
            </div>
          )
        ) : (
          <PitchCard pitch={pitch} settings={settings} open={open} onToggle={onToggle} run={run} />
        )}
      </Section>
    </article>
  );
};

export const PitchesView = ({ list, reload, initialSlot }: { list: PitchList; reload: () => void; initialSlot: number | null }) => {
  const toast = useToast();
  const [openSlot, setOpenSlot] = useState<number | null>(initialSlot);
  const run: Run = async (work, done) => {
    try {
      await work();
      toast.show(done);
      reload();
      return true;
    } catch (failure) {
      toast.show(describeError(failure));
      return false;
    }
  };
  const slots = Array.from({ length: list.settings.slots }, (_, index) => index + 1);
  const filled = list.pitches.length;
  return (
    <>
      <PageHead kicker="Pitches" title={`${filled === 0 ? "No" : filled} pitch${filled === 1 ? "" : "es"} on the billboard`} />
      <p className="max-w-prose text-muted">
        Short answers to say out loud, honed over time. Agents may suggest versions; you choose which one is live. Each live pitch takes a turn on the front page.
      </p>
      {slots.map((slot) => (
        <Slot
          key={slot}
          slot={slot}
          pitch={list.pitches.find((pitch) => pitch.slot === slot)}
          settings={list.settings}
          open={openSlot === slot}
          onToggle={() => setOpenSlot((current) => (current === slot ? null : slot))}
          run={run}
        />
      ))}
    </>
  );
};

export const PitchesPage = () => {
  const list = useResource((signal) => api.listPitches({ signal }), []);
  const { search } = useLocation();
  const requested = Number(search.get("slot"));
  const initialSlot = Number.isInteger(requested) && requested > 0 ? requested : null;
  if (list.data === null) return list.error === null ? <LoadingLine /> : <ErrorLine message={describeError(list.error)} />;
  return (
    <>
      {list.error === null ? null : <ErrorLine message={describeError(list.error)} />}
      <PitchesView list={list.data} reload={list.reload} initialSlot={initialSlot} />
    </>
  );
};
