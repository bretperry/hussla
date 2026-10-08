/*
  "Pitch of the hour": the slot on the front page where the rotating pitch goes.
  In the app: sits under the lead story; with no pitch it keeps its size and says pitches will rotate here.
  Used by: src/features/jobs/FrontPage.tsx.

  The quote box has a fixed height (tokens.css → --spacing-pitch) sized to the longest pitch the
  config allows, so a rotation never moves the page. Phase 5b supplies pitches, the rotation and
  the 900ms fade; this component already takes `pitch` and `onNext` so that work only fills it in.
*/
import { Button } from "@/shared/ui/Button";
import { SectionHead } from "@/shared/ui/Section";

export type Pitch = { title: string; text: string; number: number; total: number };

type PitchSlotProps = { pitch: Pitch | null; onNext?: () => void };

export const PitchSlot = ({ pitch, onNext }: PitchSlotProps) => (
  <section aria-label="Pitch of the hour" data-col="lead" className="flex flex-col gap-2 pb-6 lg:col-span-8 lg:col-start-1 lg:row-start-2 lg:pb-0">
    <SectionHead kicker="Pitch of the hour" urgent aside={pitch === null ? undefined : `${pitch.number} / ${pitch.total}`} />
    {/* On a phone the title, quote and button stack in that order; from lg the title and button share a row above the quote. */}
    <div className="contents lg:flex lg:items-center lg:justify-between lg:gap-6">
      <h2 className="order-1 font-display text-headline-phone font-black lg:order-none lg:text-headline">{pitch === null ? "Your pitch goes here" : pitch.title}</h2>
      {pitch === null || onNext === undefined ? null : (
        <Button onClick={onNext} aria-label="Next pitch" className="order-3 mt-2 self-start lg:order-none lg:mt-0 lg:self-auto">
          Next pitch →
        </Button>
      )}
    </div>
    {pitch === null ? (
      <p className="order-2 mt-2 h-pitch-phone font-display text-quote-phone text-muted lg:order-none lg:h-pitch lg:text-quote">Your pitches will rotate here, one at a time.</p>
    ) : (
      <blockquote className="order-2 mt-2 h-pitch-phone font-display text-quote-phone italic lg:order-none lg:h-pitch lg:text-quote">“{pitch.text}”</blockquote>
    )}
    <div className="kicker order-4 mt-auto pt-2 lg:order-none">By you · one of {pitch === null ? "ten" : pitch.total} · rotates every few minutes</div>
  </section>
);
