/*
  Component test for the first-run wizard: the passkey from the setup code (a cancelled prompt keeps the code), a new code, then skipping steps.
  In the app: nothing at runtime; guards setup's first screen and the skip buttons.
  Used by: pnpm test.
*/
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "@/shared/api";
import type { SetupStatus } from "@/shared/api";
import * as webauthn from "@/shared/lib/webauthn";
import { SetupPage } from "./SetupPage";

afterEach(() => vi.restoreAllMocks());

const status = (patch: Partial<SetupStatus>): SetupStatus => ({
  enrolled: true,
  passkeys: 0,
  codeInLog: true,
  listener: "tailnet",
  isOwner: true,
  ownerLogin: "owner@example.com",
  canStartOver: true,
  seenLogin: "owner@example.com",
  firstRunOpen: false,
  address: "https://hussla.tail0000.ts.net",
  wizard: { steps: {}, finished: false },
  ...patch,
});

describe("SetupPage", () => {
  it("adds the first passkey with the setup code, and the same code works after a cancelled prompt", async () => {
    vi.spyOn(webauthn, "passkeysSupported").mockReturnValue(true);
    const claim = vi.spyOn(api, "claimSetup").mockResolvedValue({ stepUp: "token-1", next: "POST /api/passkeys/register/begin" });
    const register = vi
      .spyOn(api, "registerPasskey")
      .mockRejectedValueOnce(new Error("The passkey prompt was cancelled or timed out. Nothing was saved; try again when you're ready."))
      .mockResolvedValueOnce({ id: "p1", name: "iPhone", rpId: "hussla.tail0000.ts.net" });
    const onChange = vi.fn<() => void>();
    const user = userEvent.setup();
    render(<SetupPage status={status({})} onChange={onChange} />);

    expect(screen.getByText(/owner@example.com/)).toBeInTheDocument();
    await user.type(screen.getByLabelText(/Setup code/), "abcd-efgh-jkmn");
    await user.clear(screen.getByLabelText(/Name this passkey/));
    await user.type(screen.getByLabelText(/Name this passkey/), "iPhone");
    await user.click(screen.getByRole("button", { name: "Add a passkey" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/cancelled/);
    expect(onChange).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Add a passkey" }));
    await waitFor(() => expect(onChange).toHaveBeenCalledOnce());
    expect(claim).toHaveBeenLastCalledWith({ code: "abcd-efgh-jkmn" });
    expect(register).toHaveBeenLastCalledWith("iPhone", "token-1");
  });

  it("prints a new code on request", async () => {
    const newCode = vi.spyOn(api, "newSetupCode").mockResolvedValue({ ok: true });
    const user = userEvent.setup();
    render(<SetupPage status={status({ codeInLog: false })} onChange={vi.fn<() => void>()} />);
    await user.click(screen.getByRole("button", { name: "Print a new code" }));
    expect(newCode).toHaveBeenCalledOnce();
    expect(await screen.findByRole("status")).toHaveTextContent(/new code is in the server log/);
  });

  it("skips one step, then the rest, saving each on the server", async () => {
    vi.spyOn(api, "mailProviders").mockResolvedValue([]);
    vi.spyOn(api, "mailSettings").mockResolvedValue({
      configured: false, hasSecret: false, providerId: "", host: "", port: 0, security: "", username: "", fromAddress: "", fromName: "", region: "", domain: "",
    });
    const mark = vi.spyOn(api, "markSetupStep").mockResolvedValue({ steps: {}, finished: false });
    const onChange = vi.fn<() => void>();
    const user = userEvent.setup();
    const { rerender } = render(<SetupPage status={status({ passkeys: 1 })} onChange={onChange} />);
    expect(screen.getByText(/Step 2 of 7 · Email/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Skip this step" }));
    await waitFor(() => expect(onChange).toHaveBeenCalledOnce());
    expect(mark).toHaveBeenCalledWith("mail", "skipped");

    rerender(<SetupPage status={status({ passkeys: 1, wizard: { steps: { mail: "skipped" }, finished: false } })} onChange={onChange} />);
    expect(screen.getByText(/Step 3 of 7 · Bring your jobs/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Skip the rest" }));
    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(2));
    expect(mark.mock.calls.map(([step]) => step)).toEqual(["mail", "import", "agent", "phone", "expiry", "second-passkey"]);
  });
});
