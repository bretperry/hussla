/*
  Tests the front page billboard: it rotates on a (fake) timer, pauses on hover and focus, links to the pitch, and skips the fade under reduced motion.
  In the app: nothing at runtime; guards Phase 5b's billboard rules.
  Used by: pnpm test.
*/
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PITCH_FADE_MS } from "@/config/ui";
import { FIXTURE_NOW, pitches } from "@/test/fixtures";
import { billboardPitches } from "./front-page";
import { PitchSlot } from "./PitchSlot";

const ROTATE_SECONDS = 180;
const live = billboardPitches(pitches);
// FIXTURE_NOW falls on a turn boundary that opens on this pitch; the tests start from it.
const startsOn = Math.floor(FIXTURE_NOW.getTime() / (ROTATE_SECONDS * 1000)) % live.length;
const titleAt = (offset: number): string => live[(startsOn + offset) % live.length]?.title ?? "";

const prefersReducedMotion = (reduce: boolean) => {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: reduce && query === "(prefers-reduced-motion: reduce)",
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
};

const billboard = () => screen.getByRole("region", { name: "Pitch of the hour" });
const heading = () => within(billboard()).getByRole("heading", { level: 2 });
const advance = (seconds: number): void => {
  act(() => {
    vi.advanceTimersByTime(seconds * 1000);
  });
};

beforeEach(() => {
  vi.useFakeTimers();
  prefersReducedMotion(false);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("billboard", () => {
  it("shows the live version of each pitch, by slot", () => {
    expect(live.map((pitch) => [pitch.slot, pitch.version])).toEqual([[1, 2], [2, 1], [4, 1], [7, 1]]);
    expect(live[0]?.text).toMatch(/stay for the boring tenth/);
  });

  it("turns to the next pitch every rotateSeconds, and wraps around", () => {
    render(<PitchSlot pitches={live} rotateSeconds={ROTATE_SECONDS} now={FIXTURE_NOW} />);
    expect(heading()).toHaveTextContent(titleAt(0));
    advance(ROTATE_SECONDS - 1);
    expect(heading()).toHaveTextContent(titleAt(0));
    advance(1);
    expect(heading()).toHaveTextContent(titleAt(1));
    for (let turn = 2; turn <= live.length; turn += 1) advance(ROTATE_SECONDS);
    expect(heading()).toHaveTextContent(titleAt(0));
  });

  it("pauses while hovered or focused, and starts a full turn again after", () => {
    render(<PitchSlot pitches={live} rotateSeconds={ROTATE_SECONDS} now={FIXTURE_NOW} />);
    fireEvent.mouseEnter(billboard());
    advance(ROTATE_SECONDS * 3);
    expect(heading()).toHaveTextContent(titleAt(0));
    fireEvent.mouseLeave(billboard());
    advance(ROTATE_SECONDS - 1);
    expect(heading()).toHaveTextContent(titleAt(0));
    advance(1);
    expect(heading()).toHaveTextContent(titleAt(1));

    const link = within(billboard()).getByRole("link");
    act(() => {
      link.focus();
    });
    advance(ROTATE_SECONDS * 2);
    expect(heading()).toHaveTextContent(titleAt(1));
    act(() => {
      link.blur();
    });
    advance(ROTATE_SECONDS);
    expect(heading()).toHaveTextContent(titleAt(2));
  });

  it("links the quote to that pitch on the Pitches page", () => {
    render(<PitchSlot pitches={live} rotateSeconds={ROTATE_SECONDS} now={FIXTURE_NOW} />);
    const shown = live[startsOn];
    expect(within(billboard()).getByRole("link")).toHaveAttribute("href", `/pitches?slot=${shown?.slot ?? 0}`);
  });

  it("cross-fades: the outgoing pitch fades out under the incoming one", () => {
    const { container } = render(<PitchSlot pitches={live} rotateSeconds={ROTATE_SECONDS} now={FIXTURE_NOW} />);
    expect(container.querySelector('[data-billboard="leaving"]')).toBeNull();
    advance(ROTATE_SECONDS);
    const leaving = container.querySelector('[data-billboard="leaving"]');
    expect(leaving).toHaveClass("animate-pitch-out");
    expect(container.querySelector('[data-billboard="current"]')).toHaveClass("animate-pitch-in");
    act(() => {
      vi.advanceTimersByTime(PITCH_FADE_MS);
    });
    expect(container.querySelector('[data-billboard="leaving"]')).toBeNull();
  });

  it("switches with no fade under prefers-reduced-motion", () => {
    prefersReducedMotion(true);
    const { container } = render(<PitchSlot pitches={live} rotateSeconds={ROTATE_SECONDS} now={FIXTURE_NOW} />);
    advance(ROTATE_SECONDS);
    expect(heading()).toHaveTextContent(titleAt(1));
    expect(container.querySelector('[data-billboard="leaving"]')).toBeNull();
    expect(container.querySelector('[data-billboard="current"]')).not.toHaveClass("animate-pitch-in");
    fireEvent.click(within(billboard()).getByRole("button", { name: "Next pitch" }));
    expect(heading()).toHaveTextContent(titleAt(2));
    expect(container.querySelector('[data-billboard="leaving"]')).toBeNull();
  });

  it("with one pitch, shows it and has no Next button; with none, keeps the empty slot", () => {
    const { unmount } = render(<PitchSlot pitches={live.slice(0, 1)} rotateSeconds={ROTATE_SECONDS} now={FIXTURE_NOW} />);
    expect(heading()).toHaveTextContent("Who I am");
    expect(within(billboard()).queryByRole("button", { name: "Next pitch" })).toBeNull();
    unmount();
    render(<PitchSlot pitches={[]} rotateSeconds={ROTATE_SECONDS} now={FIXTURE_NOW} />);
    expect(within(billboard()).getByText(/Your pitches will rotate here/)).toBeInTheDocument();
  });
});
