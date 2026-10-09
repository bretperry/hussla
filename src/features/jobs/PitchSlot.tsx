/*
  "Pitch of the hour": the front page billboard that rotates the owner's live pitches, one at a time.
  In the app: sits under the lead story; every PitchRotateSeconds (from the server) the next pitch cross-fades in.
  Used by: src/features/jobs/FrontPage.tsx.
  Uses: src/shared/lib/use-reduced-motion.ts, the pitch-in / pitch-out animations in tokens.css, PITCH_LONG_CHARACTERS.

  Calm by design: it pauses while the pointer is over it or focus is inside it, the whole quote is a
  link to that pitch on the Pitches page, and under prefers-reduced-motion it switches with no fade
  (the outgoing pitch isn't drawn at all). The quote box has a fixed height (tokens.css →
  --spacing-pitch) sized to the longest pitch the server allows, so a rotation never moves the page.
  With no pitches it keeps its size and says pitches will rotate here.
*/
import { useEffect, useState } from "react";
import type { FocusEvent } from "react";
import { PITCH_FADE_MS, PITCH_LONG_CHARACTERS } from "@/config/ui";
import { cn } from "@/shared/lib/cn";
import { Link } from "@/shared/lib/router";
import { useReducedMotion } from "@/shared/lib/use-reduced-motion";
import { Button } from "@/shared/ui/Button";
import { SectionHead } from "@/shared/ui/Section";

// One live pitch as the billboard shows it.
export type BillboardPitch = { slot: number; title: string; text: string; version: number; byOwner: boolean; author: string };

type PitchSlotProps = { pitches: readonly BillboardPitch[]; rotateSeconds: number; now?: Date };

// Which pitch a visit opens on: the one whose turn it is by the clock, so the page doesn't always start at #1.
const startIndex = (count: number, rotateSeconds: number, now: Date): number =>
  count === 0 || rotateSeconds <= 0 ? 0 : Math.floor(now.getTime() / (rotateSeconds * 1000)) % count;

const quoteClass = (text: string): string =>
  text.length > PITCH_LONG_CHARACTERS ? "text-quote-long-phone lg:text-quote-long" : "text-quote-phone lg:text-quote";

const rotationNote = (rotateSeconds: number): string => {
  const minutes = Math.round(rotateSeconds / 60);
  if (minutes < 1) return "turns every few seconds";
  return minutes === 1 ? "turns every minute" : `turns every ${minutes} minutes`;
};

export const PitchSlot = ({ pitches, rotateSeconds, now }: PitchSlotProps) => {
  const reducedMotion = useReducedMotion();
  const count = pitches.length;
  const [index, setIndex] = useState(() => startIndex(count, rotateSeconds, now ?? new Date()));
  // The pitch fading out, drawn under the incoming one until its animation ends; never under reduced motion.
  const [leaving, setLeaving] = useState<number | null>(null);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const paused = hovered || focused;
  const shown = count === 0 ? 0 : index % count;

  const showNext = () => {
    if (count < 2) return;
    setLeaving(reducedMotion ? null : shown);
    setIndex((shown + 1) % count);
  };

  // One timer per pitch shown: hovering or focusing clears it, and leaving starts a full turn again.
  useEffect(() => {
    if (paused || count < 2 || rotateSeconds <= 0) return undefined;
    const timer = window.setTimeout(() => {
      setLeaving(reducedMotion ? null : shown);
      setIndex((shown + 1) % count);
    }, rotateSeconds * 1000);
    return () => window.clearTimeout(timer);
  }, [shown, paused, count, rotateSeconds, reducedMotion]);

  // The outgoing layer goes once its fade is done. A timer, not animationend: that event never comes when CSS turns the animation off.
  useEffect(() => {
    if (leaving === null) return undefined;
    const timer = window.setTimeout(() => setLeaving(null), PITCH_FADE_MS);
    return () => window.clearTimeout(timer);
  }, [leaving]);

  const onBlur = (event: FocusEvent<HTMLElement>) => {
    if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setFocused(false);
  };

  const current = pitches[shown];
  const outgoing = leaving === null ? undefined : pitches[leaving];
  return (
    <section
      aria-label="Pitch of the hour"
      data-col="lead"
      data-paused={paused ? "true" : "false"}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={onBlur}
      className="flex flex-col gap-2 pb-6 lg:col-span-8 lg:col-start-1 lg:row-start-2 lg:pb-0"
    >
      <SectionHead kicker="Pitch of the hour" urgent aside={current === undefined ? undefined : `${shown + 1} / ${count}`} />
      {/* On a phone the title, quote and button stack in that order; from lg the title and button share a row above the quote. */}
      <div className="contents lg:flex lg:items-center lg:justify-between lg:gap-6">
        <h2 className="order-1 font-display text-title font-bold lg:order-none">{current === undefined ? "Your pitch goes here" : current.title}</h2>
        {count < 2 ? null : (
          <Button onClick={showNext} aria-label="Next pitch" className="order-3 mt-2 self-start lg:order-none lg:mt-0 lg:self-auto">
            Next pitch →
          </Button>
        )}
      </div>
      {current === undefined ? (
        <p className="order-2 mt-2 h-pitch-phone font-display text-quote-phone text-muted lg:order-none lg:h-pitch lg:text-quote">Your pitches will rotate here, one at a time.</p>
      ) : (
        <Link
          to={`/pitches?slot=${current.slot}`}
          aria-label={`Open the pitch “${current.title}”`}
          className="order-2 mt-2 grid h-pitch-phone overflow-hidden no-underline lg:order-none lg:h-pitch"
        >
          {outgoing === undefined ? null : (
            <blockquote
              key={`out-${outgoing.slot}`}
              aria-hidden="true"
              data-billboard="leaving"
              className={cn("col-start-1 row-start-1 animate-pitch-out font-display italic", quoteClass(outgoing.text))}
            >
              “{outgoing.text}”
            </blockquote>
          )}
          <blockquote
            key={`in-${current.slot}`}
            data-billboard="current"
            className={cn("col-start-1 row-start-1 font-display italic", quoteClass(current.text), outgoing !== undefined && "animate-pitch-in")}
          >
            “{current.text}”
          </blockquote>
        </Link>
      )}
      <div className="kicker order-4 mt-auto pt-2 lg:order-none">
        {current === undefined
          ? "By you · one of ten · rotates every few minutes"
          : `${current.byOwner ? "By you" : `By ${current.author}`} · version ${current.version} · ${rotationNote(rotateSeconds)}`}
      </div>
    </section>
  );
};
