/*
  Component tests for the email editor, the approve panel and the email card.
  In the app: nothing at runtime; covers save, approve confirm, "changed since you read it", the inferred-address and placeholder warnings.
  Used by: pnpm test.
  Uses: Testing Library, spies on the typed api client (the passkey tap itself is tested in api.test.ts).
*/
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, api } from "@/shared/api";
import type { Email } from "@/shared/api";
import { makeContact, makeEmail } from "@/test/fixtures";
import { ApprovePanel } from "./ApprovePanel";
import { EmailCard } from "./EmailCard";
import { EmailEditor } from "./EmailEditor";
import type { EmailFields } from "./EmailEditor";

afterEach(() => vi.restoreAllMocks());

const noop = () => undefined;
const noopSave = () => Promise.resolve(makeEmail());

const initial = { to: "riley@northwind.example.com", cc: "", subject: "Following up", body: "Hi Riley" };
const inferredContact = makeContact({ name: "Riley Example", email: "riley@northwind.example.com", emailStatus: "inferred" });

describe("EmailEditor", () => {
  it("saves the edited fields and hands back the saved email", async () => {
    const user = userEvent.setup();
    const saved = makeEmail({ subject: "Better subject", version: 2 });
    const save = vi.fn<(fields: EmailFields) => Promise<Email>>().mockResolvedValue(saved);
    const onSaved = vi.fn<(email: Email) => void>();
    render(<EmailEditor initial={initial} contacts={[]} submitLabel="Save draft" save={save} onSaved={onSaved} onClose={vi.fn<() => void>()} />);
    await user.clear(screen.getByLabelText("Subject"));
    await user.type(screen.getByLabelText("Subject"), "Better subject");
    await user.click(screen.getByRole("button", { name: "Save draft" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(saved));
    expect(save).toHaveBeenCalledWith({ ...initial, subject: "Better subject" });
  });

  it("shows the server's reason when a save fails, and does not report it saved", async () => {
    const user = userEvent.setup();
    const onSaved = vi.fn<(email: Email) => void>();
    render(<EmailEditor initial={initial} contacts={[]} submitLabel="Save draft" save={() => Promise.reject(new ApiError("subject is too long", 400))} onSaved={onSaved} onClose={vi.fn<() => void>()} />);
    await user.click(screen.getByRole("button", { name: "Save draft" }));
    expect(await screen.findByText("subject is too long")).toBeInTheDocument();
    expect(onSaved).not.toHaveBeenCalled();
  });

  it("warns when the recipient is an inferred (guessed) address", () => {
    render(<EmailEditor initial={initial} contacts={[inferredContact]} submitLabel="Save draft" save={noopSave} onSaved={noop} onClose={noop} />);
    expect(screen.getByText(/was guessed from the company's email pattern/)).toBeInTheDocument();
  });

  it("does not warn about a verified address, and warns about a [placeholder] as it is typed", async () => {
    const user = userEvent.setup();
    const verified = makeContact({ name: "Riley Example", email: "riley@northwind.example.com", emailStatus: "verified" });
    render(<EmailEditor initial={initial} contacts={[verified]} submitLabel="Save draft" save={noopSave} onSaved={noop} onClose={noop} />);
    expect(screen.queryByText(/guessed/)).toBeNull();
    expect(screen.queryByText(/placeholder/)).toBeNull();
    await user.type(screen.getByLabelText("Message"), " on [[date]");
    expect(screen.getByText(/still has a \[placeholder\]/)).toBeInTheDocument();
  });
});

describe("ApprovePanel", () => {
  it("shows exactly what will be sent and approves that version", async () => {
    const user = userEvent.setup();
    const email = makeEmail({ version: 3 });
    const approve = vi.spyOn(api, "approveEmail").mockResolvedValue({ ...email, status: "approved" });
    const onApproved = vi.fn<() => void>();
    render(<ApprovePanel email={email} contacts={[]} onApproved={onApproved} onShowLatest={vi.fn<() => void>()} onBack={vi.fn<() => void>()} />);
    expect(screen.getByText(email.subject)).toBeInTheDocument();
    expect(screen.getByText(/version 3/)).toBeInTheDocument();
    expect(approve).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Approve & queue" }));
    await waitFor(() => expect(onApproved).toHaveBeenCalled());
    expect(approve).toHaveBeenCalledWith(email.id, 3);
  });

  it("says the email changed since it was read, approves nothing, and offers the latest", async () => {
    const user = userEvent.setup();
    vi.spyOn(api, "approveEmail").mockRejectedValue(new ApiError("changed since you read it", 409, "changed-since-read"));
    const onApproved = vi.fn<() => void>();
    const onShowLatest = vi.fn<() => void>();
    render(<ApprovePanel email={makeEmail()} contacts={[]} onApproved={onApproved} onShowLatest={onShowLatest} onBack={vi.fn<() => void>()} />);
    await user.click(screen.getByRole("button", { name: "Approve & queue" }));
    expect(await screen.findByText(/changed since you read it, so nothing was approved/)).toBeInTheDocument();
    expect(onApproved).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Approve & queue" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Show the latest" }));
    expect(onShowLatest).toHaveBeenCalled();
  });

  it("shows other failures (a cancelled passkey) without calling it approved", async () => {
    const user = userEvent.setup();
    vi.spyOn(api, "approveEmail").mockRejectedValue(new Error("The passkey prompt was cancelled or timed out. Nothing was changed."));
    const onApproved = vi.fn<() => void>();
    render(<ApprovePanel email={makeEmail()} contacts={[]} onApproved={onApproved} onShowLatest={vi.fn<() => void>()} onBack={vi.fn<() => void>()} />);
    await user.click(screen.getByRole("button", { name: "Approve & queue" }));
    expect(await screen.findByText(/passkey prompt was cancelled/)).toBeInTheDocument();
    expect(onApproved).not.toHaveBeenCalled();
  });

  it("warns that a failed email may already have been sent, and repeats the warnings", () => {
    const email = makeEmail({ status: "failed", error: "connection reset", body: "On [date] I wrote" });
    render(<ApprovePanel email={email} contacts={[inferredContact]} onApproved={vi.fn<() => void>()} onShowLatest={vi.fn<() => void>()} onBack={vi.fn<() => void>()} />);
    expect(screen.getByText(/may have been sent before the failure/)).toBeInTheDocument();
    expect(screen.getByText(/guessed/)).toBeInTheDocument();
    expect(screen.getByText(/placeholder/)).toBeInTheDocument();
  });
});

describe("EmailCard", () => {
  it("asks for a confirmation before anything is approved", async () => {
    const user = userEvent.setup();
    const approve = vi.spyOn(api, "approveEmail");
    render(<EmailCard email={makeEmail()} onChanged={vi.fn<() => void>()} />);
    await user.click(screen.getByRole("button", { name: "Review & approve" }));
    expect(screen.getByRole("group", { name: "Approve this email" })).toBeInTheDocument();
    expect(approve).not.toHaveBeenCalled();
  });

  it("offers no approve button for an email that already went out", () => {
    render(<EmailCard email={makeEmail({ status: "sent" })} onChanged={vi.fn<() => void>()} />);
    expect(screen.queryByRole("button", { name: "Review & approve" })).toBeNull();
  });
});
