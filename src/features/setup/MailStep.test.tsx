/*
  Component test for the mail step: Save and the test email are separate clicks, one passkey tap each.
  In the app: nothing at runtime; guards the fix for a second passkey prompt the browser refused.
  Used by: pnpm test.

  One click that chained two step-up taps failed in Firefox ("cancelled or timed out"): a browser
  shows a passkey prompt only shortly after a click, so each tap needs its own button.
*/
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "@/shared/api";
import type { MailProvider, MailSettings } from "@/shared/api";
import { MailStep } from "./MailStep";

afterEach(() => vi.restoreAllMocks());

const provider: MailProvider = {
  id: "resend",
  label: "Resend",
  kind: "api",
  needsServer: false,
  needsDomain: false,
  usernameHint: "",
  secretLabel: "API key",
  helpSteps: [],
  credentialUrl: "https://example.com/keys",
  docsUrl: "",
  warning: "",
  regions: [],
};

const settings: MailSettings = {
  configured: false,
  hasSecret: false,
  providerId: "",
  host: "",
  port: 0,
  security: "",
  username: "",
  fromAddress: "",
  fromName: "",
  region: "",
  domain: "",
};

describe("MailStep", () => {
  it("saves on one click and sends the test on another, so each passkey prompt follows a click", async () => {
    vi.spyOn(api, "mailProviders").mockResolvedValue([provider]);
    vi.spyOn(api, "mailSettings").mockResolvedValue(settings);
    const save = vi.spyOn(api, "saveMailSettings").mockResolvedValue({ ...settings, configured: true, hasSecret: true });
    const test = vi.spyOn(api, "sendTestEmail").mockResolvedValue({ ok: true, messageId: "m1" });
    const onDone = vi.fn<() => void>();
    const user = userEvent.setup();
    render(<MailStep onDone={onDone} />);

    await user.type(await screen.findByLabelText(/Your email address/), "owner@example.com");
    await user.type(screen.getByLabelText(/^API key/), "re_test_key");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Saved. Now send yourself a test.")).toBeInTheDocument();
    expect(save).toHaveBeenCalledOnce();
    expect(test).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Send me a test" }));
    expect(await screen.findByText(/on its way to owner@example.com/)).toBeInTheDocument();
    expect(test).toHaveBeenCalledOnce();

    await user.click(screen.getByRole("button", { name: "It arrived: next" }));
    expect(onDone).toHaveBeenCalledOnce();
  });
});
