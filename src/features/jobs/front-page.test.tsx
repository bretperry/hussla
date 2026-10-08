/*
  Tests the front page rules (lead, board, news, signatures, overnight) and its three states.
  In the app: nothing at runtime; guards mockup 8c's states: day one, no lead story, nothing to sign.
  Used by: pnpm test.
*/
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { companyDetails, companySummaries, emails, FIXTURE_NOW, jobItems, makeJobItem } from "@/test/fixtures";
import { awaitingSignature, boardJobs, glanceFacts, latestNews, overnightCounts, pickLead } from "./front-page";
import { FrontPageView } from "./FrontPage";
import type { FrontPageData } from "./use-front-page";

const full: FrontPageData = { jobs: jobItems, companies: companySummaries, drafts: emails.filter((email) => email.status === "draft"), details: companyDetails };
const view = (data: FrontPageData) => render(<FrontPageView appName="Hussla" data={data} now={FIXTURE_NOW} />);

describe("front page rules", () => {
  it("leads with the job furthest along, then the best fit", () => {
    expect(pickLead(jobItems)?.id).toBe("northwind-staff-engineer-platform");
    const applied = [makeJobItem({ id: "a", company: "A", companySlug: "a", title: "t", status: "applied", score: 70 }), makeJobItem({ id: "b", company: "B", companySlug: "b", title: "t", status: "applied", score: 90 })];
    expect(pickLead(applied)?.id).toBe("b");
  });

  it("has no lead when nothing is open", () => {
    expect(pickLead(jobItems.map((job) => ({ ...job, status: "rejected" })))).toBeNull();
    expect(pickLead([])).toBeNull();
  });

  it("keeps closed and filtered jobs off the board", () => {
    expect(boardJobs(jobItems).every((job) => !["rejected", "skipped", "filtered"].includes(job.status))).toBe(true);
  });

  it("counts each company once among the drafts waiting for a signature", () => {
    const result = awaitingSignature(full.drafts, jobItems, companySummaries);
    expect(result.count).toBe(2);
    expect(result.companies).toEqual(["Fabrikam Cloud", "Contoso Payments"]);
  });

  it("counts overnight work inside the window only", () => {
    const counts = overnightCounts(jobItems, companySummaries, companyDetails, FIXTURE_NOW);
    expect(counts).toEqual({ applied: 1, reviews: 2, profiles: 2 });
  });

  it("lists the newest headlines first, loose dates included", () => {
    const stories = latestNews(companyDetails);
    expect(stories[0]?.headline).toMatch(/Fabrikam Cloud opens/);
    expect(stories.map((story) => story.date)).toEqual(["2026-09-12", "2026-09-02", "2026-08-28", "2026-06"]);
  });

  it("leaves out fact rows with nothing to say", () => {
    const lead = jobItems[0];
    if (lead === undefined) throw new Error("fixture");
    expect(glanceFacts({ ...lead, nextAction: "" }, undefined)).toEqual([]);
  });
});

describe("front page states", () => {
  it("full page: lead headline, fact box, signature ear with a button", () => {
    view(full);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Northwind Labs has you interviewing");
    expect(screen.getByRole("group", { name: "Northwind Labs at a glance" })).toBeInTheDocument();
    expect(screen.getByText("2 follow-ups ready")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Review & sign" })).toHaveAttribute("href", "/outbox");
    expect(screen.getByRole("link", { name: "All 10 jobs →" })).toHaveAttribute("href", "/jobs");
  });

  it("day one: nothing to sign (no button), an invitation instead of a lead, empty pitch slot, no fact box", () => {
    view({ jobs: [], companies: [], drafts: [], details: [] });
    expect(screen.getByText("Nothing to sign")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Review & sign" })).toBeNull();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Your first story starts with one job");
    expect(screen.getByRole("link", { name: "Add a job" })).toBeInTheDocument();
    expect(screen.queryByText(/at a glance/)).toBeNull();
    const pitch = screen.getByRole("region", { name: "Pitch of the hour" });
    expect(within(pitch).getByText(/Your pitches will rotate here/)).toBeInTheDocument();
    expect(within(pitch).queryByRole("button", { name: "Next pitch" })).toBeNull();
  });

  it("no lead story: the fact box is hidden even when companies have money data", () => {
    view({ ...full, jobs: jobItems.map((job) => ({ ...job, status: "rejected" })), drafts: [] });
    expect(screen.queryByText(/at a glance/)).toBeNull();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Your first story starts with one job");
  });

  it("nothing to sign: the ear says so with no button, the rest of the page stays", () => {
    view({ ...full, drafts: [] });
    expect(screen.getByText("Nothing to sign")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Review & sign" })).toBeNull();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Northwind Labs has you interviewing");
  });
});
