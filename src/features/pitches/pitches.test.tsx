/*
  Component tests for the Pitches page: all ten slots, the compare view's word diff and timing, the writer's count, and making a version live.
  In the app: nothing at runtime; guards Phase 5b's Pitches page.
  Used by: pnpm test.
  Uses: Testing Library, spies on the typed api client (the passkey tap itself is tested in api.test.ts).
*/
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "@/shared/api";
import { pitchList } from "@/test/fixtures";
import { PitchesView } from "./PitchesPage";
import { PitchCompare } from "./PitchCompare";

afterEach(() => vi.restoreAllMocks());

const noop = () => undefined;
const firstPitch = pitchList.pitches[0];
if (firstPitch === undefined) throw new Error("fixture");

describe("Pitches page", () => {
  it("lists every slot: filled ones with their live version, empty ones with a start button", () => {
    render(<PitchesView list={pitchList} reload={noop} initialSlot={null} />);
    expect(screen.getAllByRole("article")).toHaveLength(10);
    const first = screen.getByRole("article", { name: "Pitch 1: Who I am" });
    expect(within(first).getByText(/stay for the boring tenth/)).toBeInTheDocument();
    expect(within(first).queryByText(/stay for the tenth/)).toBeNull(); // version 3 isn't live
    expect(within(screen.getByRole("article", { name: "Pitch 3, empty" })).getByRole("button", { name: "Start pitch 3" })).toBeInTheDocument();
  });

  it("opens the pitch the address names, with the compare view on the live version and the newest other", () => {
    render(<PitchesView list={pitchList} reload={noop} initialSlot={1} />);
    const compare = screen.getByRole("region", { name: "Compare versions" });
    expect(within(compare).getByLabelText("Compare")).toHaveValue("2");
    expect(within(compare).getByLabelText("With")).toHaveValue("3");
  });

  it("makes a version live with the passkey step-up, then reloads", async () => {
    const setLive = vi.spyOn(api, "setLivePitch").mockResolvedValue({ ...firstPitch, liveVersion: 3 });
    const reload = vi.fn<() => void>();
    const user = userEvent.setup();
    render(<PitchesView list={pitchList} reload={reload} initialSlot={1} />);
    await user.click(screen.getByRole("button", { name: "Make version 3 live" }));
    await waitFor(() => expect(reload).toHaveBeenCalled());
    expect(setLive).toHaveBeenCalledWith(1, 3);
  });

  it("counts words and speaking time as the owner writes, and adds the version", async () => {
    const add = vi.spyOn(api, "addPitchVersion").mockResolvedValue(firstPitch);
    const user = userEvent.setup();
    render(<PitchesView list={pitchList} reload={noop} initialSlot={1} />);
    const writer = screen.getByRole("form", { name: "New version of Who I am" });
    await user.type(within(writer).getByLabelText("New version", { exact: false }), "one two three four five");
    expect(within(writer).getByText(/5 words · 2 s · 397 characters left/)).toBeInTheDocument();
    await user.click(within(writer).getByRole("button", { name: "Add version" }));
    await waitFor(() => expect(add).toHaveBeenCalledWith(1, { text: "one two three four five", note: "" }));
  });
});

describe("PitchCompare", () => {
  it("shows the word diff on each side, with word counts and speaking time", () => {
    render(<PitchCompare versions={firstPitch.versions} liveVersion={2} pair={[2, 3]} wordsPerMinute={150} onPick={noop} onMakeLive={noop} />);
    const before = screen.getByText((_, element) => element?.getAttribute("data-side") === "before");
    const after = screen.getByText((_, element) => element?.getAttribute("data-side") === "after");
    expect([...before.querySelectorAll("del")].map((node) => node.textContent)).toEqual(["calm", "version,", "boring"]);
    expect([...after.querySelectorAll("ins")].map((node) => node.textContent)).toEqual(["calm, fast", "version"]);
    // Both versions are 20 words: 8 s each at 150 words a minute.
    expect(screen.getAllByText(/^20 words · 8 s to say/)).toHaveLength(2);
    expect(screen.getByLabelText("Difference")).toHaveTextContent("Version 3 vs 2: same length");
    expect(screen.getByText("Live")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Make version 3 live" })).toBeInTheDocument();
  });

  it("says how much longer or shorter the newer version runs", () => {
    render(<PitchCompare versions={firstPitch.versions} liveVersion={2} pair={[1, 2]} wordsPerMinute={150} onPick={noop} onMakeLive={noop} />);
    // Version 1 is 16 words (6 s); version 2 is 20 (8 s).
    expect(screen.getByText(/^16 words · 6 s to say/)).toBeInTheDocument();
    expect(screen.getByLabelText("Difference")).toHaveTextContent("Version 2 vs 1: +4 words · +2 s");
  });

  it("lets the owner pick any two versions", async () => {
    const onPick = vi.fn<(pair: readonly [number, number]) => void>();
    const user = userEvent.setup();
    render(<PitchCompare versions={firstPitch.versions} liveVersion={2} pair={[2, 3]} wordsPerMinute={150} onPick={onPick} onMakeLive={noop} />);
    await user.selectOptions(screen.getByLabelText("Compare"), "1");
    expect(onPick).toHaveBeenCalledWith([1, 3]);
  });
});
