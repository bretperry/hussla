/*
  Component test for "Import from the old tracker": picking the file sends it, and the result says what came over and what didn't.
  In the app: nothing at runtime; guards the Settings import section.
  Used by: pnpm test.
*/
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "@/shared/api";
import type { ImportResult } from "@/shared/api";
import { ImportFromOldTracker } from "./ImportFromOldTracker";

afterEach(() => vi.restoreAllMocks());

const secrets = "Agent keys, mail passwords and other secrets are never imported: make new agent keys and set up mail in Settings.";
const firstRun: ImportResult = {
  jobs: 4, companies: 2, answers: 2, events: 4, emails: 5, pitches: 3, needApproval: 3, filesNotImported: 1,
  warnings: ['job #4 (sample-labs-design-engineer): status "ghosted" has no match in Hussla; imported as "review", so set it by hand'],
  notices: [secrets, "3 imported emails were never sent: unapproved in the Outbox, and nothing goes out until you approve it again."],
};
const backup = () => new File(['{"jobs":[]}'], "tracker-backup.json", { type: "application/json" });

describe("ImportFromOldTracker", () => {
  it("sends the picked file and shows what was added, the notices and the warnings", async () => {
    const importBundle = vi.spyOn(api, "importBundle").mockResolvedValue(firstRun);
    const user = userEvent.setup();
    render(<ImportFromOldTracker />);
    const file = backup();
    await user.upload(screen.getByLabelText("Choose the backup file"), file);
    expect(importBundle).toHaveBeenCalledWith(file);
    expect(await screen.findByText("Added 4 jobs, 2 companies, 2 answers, 5 emails, 3 pitches, 4 activity lines.")).toBeInTheDocument();
    expect(screen.getByText(secrets)).toBeInTheDocument();
    expect(screen.getByText("1 thing worth a look")).toBeInTheDocument();
  });

  it("says nothing was new on a second import", async () => {
    vi.spyOn(api, "importBundle").mockResolvedValue({ ...firstRun, jobs: 0, companies: 0, answers: 0, events: 0, emails: 0, pitches: 0, warnings: [], notices: [secrets] });
    const user = userEvent.setup();
    render(<ImportFromOldTracker />);
    await user.upload(screen.getByLabelText("Choose the backup file"), backup());
    expect(await screen.findByText("Nothing new: everything in that file is already here.")).toBeInTheDocument();
    expect(screen.queryByText(/worth a look/)).toBeNull();
  });

  it("shows the server's refusal", async () => {
    vi.spyOn(api, "importBundle").mockRejectedValue(new Error("the seed file isn't valid JSON of the expected shape"));
    const user = userEvent.setup();
    render(<ImportFromOldTracker />);
    await user.upload(screen.getByLabelText("Choose the backup file"), backup());
    expect(await screen.findByText(/isn't valid JSON/)).toBeInTheDocument();
  });
});
