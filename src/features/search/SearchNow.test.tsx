/*
  Component tests for Search now: the Jobs page button (unset, start, refused) and the routine form in Settings.
  In the app: nothing at runtime; guards that the token is write-only and that a start shows where to watch it.
  Used by: pnpm test.
  Uses: Testing Library, spies on the typed api client (the passkey tap itself is tested in api.test.ts).
*/
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, api } from "@/shared/api";
import type { SearchRoutine } from "@/shared/api";
import { ToastProvider } from "@/shared/ui/Feedback";
import { SearchNowButton, SearchRoutineSettings } from "./SearchNow";

afterEach(() => vi.restoreAllMocks());

const unset: SearchRoutine = { configured: false, routineId: "", hasToken: false, lastRunAt: null, lastSessionUrl: null };
const ready: SearchRoutine = { configured: true, routineId: "trig_01ABC", hasToken: true, lastRunAt: null, lastSessionUrl: null };

describe("SearchNowButton", () => {
  it("leads to Settings until a routine is saved", async () => {
    vi.spyOn(api, "getSearchRoutine").mockResolvedValue(unset);
    render(<SearchNowButton />);
    expect(await screen.findByRole("link", { name: "Set up Search now" })).toHaveAttribute("href", "/settings");
  });

  it("says so when the setup can't be read", async () => {
    vi.spyOn(api, "getSearchRoutine").mockRejectedValue(new ApiError("Can't reach Hussla.", 0));
    render(<SearchNowButton />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Can't reach Hussla.");
  });

  it("starts a search and links to the run", async () => {
    vi.spyOn(api, "getSearchRoutine").mockResolvedValue(ready);
    const run = vi.spyOn(api, "runSearch").mockResolvedValue({ startedAt: "2026-10-10T03:00:00.000Z", sessionUrl: "https://claude.ai/code/session_01X" });
    const user = userEvent.setup();
    render(<ToastProvider><SearchNowButton /></ToastProvider>);
    await user.click(await screen.findByRole("button", { name: "Search now" }));
    expect(run).toHaveBeenCalledOnce();
    expect(await screen.findByRole("link", { name: "Watch the search" })).toHaveAttribute("href", "https://claude.ai/code/session_01X");
    expect(screen.getByRole("status")).toHaveTextContent("Search started");
  });

  it("says why a search didn't start", async () => {
    vi.spyOn(api, "getSearchRoutine").mockResolvedValue(ready);
    vi.spyOn(api, "runSearch").mockRejectedValue(new ApiError("a search started a few minutes ago", 429));
    const user = userEvent.setup();
    render(<ToastProvider><SearchNowButton /></ToastProvider>);
    await user.click(await screen.findByRole("button", { name: "Search now" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("a search started a few minutes ago"));
    expect(screen.queryByRole("link", { name: "Watch the search" })).toBeNull();
  });
});

describe("SearchRoutineSettings", () => {
  it("saves the routine and token, then clears the token field", async () => {
    vi.spyOn(api, "getSearchRoutine").mockResolvedValue(unset);
    const save = vi.spyOn(api, "saveSearchRoutine").mockResolvedValue(ready);
    const user = userEvent.setup();
    render(<ToastProvider><SearchRoutineSettings /></ToastProvider>);
    await user.type(await screen.findByLabelText(/Routine URL or id/), "https://api.anthropic.com/v1/claude_code/routines/trig_01ABC/fire");
    await user.type(screen.getByLabelText(/Routine token/), "sk-ant-oat01-x");
    await user.click(screen.getByRole("button", { name: "Save routine" }));
    expect(save).toHaveBeenCalledWith({ routine: "https://api.anthropic.com/v1/claude_code/routines/trig_01ABC/fire", token: "sk-ant-oat01-x" });
    await waitFor(() => expect(screen.getByLabelText(/Routine token/)).toHaveValue(""));
  });

  it("keeps the saved token when the field is left empty", async () => {
    vi.spyOn(api, "getSearchRoutine").mockResolvedValue(ready);
    const save = vi.spyOn(api, "saveSearchRoutine").mockResolvedValue(ready);
    const user = userEvent.setup();
    render(<ToastProvider><SearchRoutineSettings /></ToastProvider>);
    expect(await screen.findByLabelText(/Routine URL or id/)).toHaveValue("trig_01ABC");
    await user.click(screen.getByRole("button", { name: "Save routine" }));
    expect(save).toHaveBeenCalledWith({ routine: "trig_01ABC" });
  });
});
