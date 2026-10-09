/*
  Component test for adding a spare passkey: the confirm tap and the new passkey are separate clicks.
  In the app: nothing at runtime; guards the fix for a second passkey prompt the browser refused.
  Used by: pnpm test.
*/
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "@/shared/api";
import { AddSparePasskey } from "./AddSparePasskey";

afterEach(() => vi.restoreAllMocks());

describe("AddSparePasskey", () => {
  it("confirms on one click and makes the passkey with that token on the next", async () => {
    const confirm = vi.spyOn(api, "confirmForNewPasskey").mockResolvedValue("token-1");
    const register = vi.spyOn(api, "registerPasskey").mockResolvedValue({ id: "p2", name: "Spare passkey", rpId: "hussla.tail0000.ts.net" });
    const onAdded = vi.fn<() => void>();
    const user = userEvent.setup();
    render(<AddSparePasskey onAdded={onAdded} />);

    await user.click(screen.getByRole("button", { name: /Confirm with your current passkey/ }));
    expect(confirm).toHaveBeenCalledOnce();
    expect(register).not.toHaveBeenCalled();

    await user.click(await screen.findByRole("button", { name: /Make the new passkey/ }));
    await waitFor(() => expect(onAdded).toHaveBeenCalledOnce());
    expect(register).toHaveBeenCalledWith("Spare passkey", "token-1");
  });

  it("asks to confirm again after a failed attempt, since the token is spent", async () => {
    vi.spyOn(api, "confirmForNewPasskey").mockResolvedValue("token-1");
    vi.spyOn(api, "registerPasskey").mockRejectedValue(new Error("The passkey prompt was cancelled or timed out. Nothing was saved; try again when you're ready."));
    const user = userEvent.setup();
    render(<AddSparePasskey onAdded={vi.fn<() => void>()} />);

    await user.click(screen.getByRole("button", { name: /Confirm with your current passkey/ }));
    await user.click(await screen.findByRole("button", { name: /Make the new passkey/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/cancelled/);
    expect(screen.getByRole("button", { name: /Confirm with your current passkey/ })).toBeInTheDocument();
  });
});
