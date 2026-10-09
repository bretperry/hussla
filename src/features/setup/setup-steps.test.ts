/*
  Unit tests for the setup gate and the wizard's steps left.
  In the app: nothing at runtime; guards who sees setup, the app, or the "not yours" page.
  Used by: pnpm test.
*/
import { describe, expect, it } from "vitest";
import type { SetupStatus } from "@/shared/api";
import { gateFor, stepsLeft, visibleSteps } from "./setup-steps";

const status = (patch: Partial<SetupStatus>): SetupStatus => ({
  enrolled: true,
  passkeys: 1,
  codeInLog: false,
  listener: "tailnet",
  isOwner: true,
  ownerLogin: "owner@example.com",
  canStartOver: false,
  seenLogin: "owner@example.com",
  firstRunOpen: false,
  address: "https://hussla.tail0000.ts.net",
  wizard: { steps: {}, finished: false },
  ...patch,
});

const allDone = { mail: "done", import: "skipped", agent: "done", phone: "done", expiry: "skipped", "second-passkey": "done" } as const;

describe("gateFor", () => {
  it("sends the owner without a passkey to setup, even with every step done", () => {
    expect(gateFor(status({ passkeys: 0, wizard: { steps: allDone, finished: true } }))).toEqual({ kind: "setup" });
  });

  it("sends the owner with steps left to setup, and a finished owner to the app", () => {
    expect(gateFor(status({}))).toEqual({ kind: "setup" });
    expect(gateFor(status({ wizard: { steps: allDone, finished: true } }))).toEqual({ kind: "app" });
  });

  it("lets a laptop's local owner finish without the tailnet-only steps", () => {
    const { phone: _phone, expiry: _expiry, ...rest } = allDone;
    expect(gateFor(status({ listener: "local", wizard: { steps: rest, finished: false } }))).toEqual({ kind: "app" });
  });

  it("names the owner and the login seen to someone else on the tailnet", () => {
    expect(gateFor(status({ isOwner: false, seenLogin: "neighbor@example.com" }))).toEqual({
      kind: "not-owner",
      ownerLogin: "owner@example.com",
      seenLogin: "neighbor@example.com",
    });
  });

  it("lets a tailnet caller claim an install with no owner, and asks an unknown caller to sign in", () => {
    expect(gateFor(status({ isOwner: false, enrolled: false, ownerLogin: "", seenLogin: "pat@example.com" }))).toEqual({ kind: "setup" });
    expect(gateFor(status({ isOwner: false, seenLogin: "", listener: "local" }))).toEqual({ kind: "sign-in" });
  });
});

describe("steps", () => {
  it("keeps the server's order and drops the tailnet-only steps on the local listener", () => {
    expect(visibleSteps(status({}))).toEqual(["mail", "import", "agent", "phone", "expiry", "second-passkey"]);
    expect(visibleSteps(status({ listener: "local" }))).toEqual(["mail", "import", "agent", "second-passkey"]);
  });

  it("counts a skipped step as handled", () => {
    expect(stepsLeft(status({ wizard: { steps: { mail: "skipped", import: "done" }, finished: false } }))).toEqual([
      "agent",
      "phone",
      "expiry",
      "second-passkey",
    ]);
  });
});
