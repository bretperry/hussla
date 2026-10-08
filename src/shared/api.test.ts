/*
  Tests the API client's passkey step-up: the tap happens first, and its one-use token rides on the owner-only request.
  In the app: nothing at runtime; guards "approve and other owner-only buttons run the passkey step-up".
  Used by: pnpm test.
  Uses: a fake fetch and a stand-in for the browser's WebAuthn.
*/
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, api } from "./api";

type Call = { method: string; path: string; headers: Record<string, string>; body: unknown };

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

class FakeCredential {
  toJSON = () => ({ id: "cred-1", type: "public-key", response: { signature: "sig" } });
}

let calls: Call[] = [];

const stubFetch = (handler: (call: Call) => Response) => {
  vi.stubGlobal("fetch", (path: string, init: RequestInit = {}) => {
    const call: Call = {
      method: init.method ?? "GET",
      path,
      headers: Object.fromEntries(new Headers(init.headers)),
      body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    return Promise.resolve(handler(call));
  });
};

beforeEach(() => {
  calls = [];
  vi.stubGlobal("PublicKeyCredential", Object.assign(FakeCredential, { parseRequestOptionsFromJSON: (options: unknown) => options }));
  vi.stubGlobal("navigator", { credentials: { get: () => Promise.resolve(new FakeCredential()) } });
});
afterEach(() => vi.unstubAllGlobals());

describe("owner-only calls", () => {
  it("tap first for exactly this method and path, then send the token", async () => {
    stubFetch((call) => {
      if (call.path === "/api/stepup/begin") return json({ challengeId: "c1", options: { publicKey: { challenge: "abc" } } });
      if (call.path === "/api/stepup/finish") return json({ token: "one-use", expiresAt: "2026-10-08T14:05:00.000Z" });
      return json({ id: "e1", status: "approved" });
    });
    await api.approveEmail("e1", 4);
    expect(calls.map((call) => call.path)).toEqual(["/api/stepup/begin", "/api/stepup/finish", "/api/emails/e1/approve"]);
    expect(calls[0]?.body).toEqual({ method: "POST", path: "/api/emails/e1/approve" });
    expect(calls[1]?.body).toEqual({ challengeId: "c1", credential: { id: "cred-1", type: "public-key", response: { signature: "sig" } } });
    expect(calls[2]?.headers["x-hussla-step-up"]).toBe("one-use");
    expect(calls[2]?.body).toEqual({ version: 4 });
  });

  it("does not call the action when the passkey tap is cancelled", async () => {
    stubFetch(() => json({ challengeId: "c1", options: { publicKey: { challenge: "abc" } } }));
    vi.stubGlobal("navigator", { credentials: { get: () => Promise.reject(new DOMException("no", "NotAllowedError")) } });
    await expect(api.deleteJob("j1")).rejects.toThrow(/cancelled/);
    expect(calls.map((call) => call.path)).toEqual(["/api/stepup/begin"]);
  });

  it("does not ask for a tap on an ordinary edit", async () => {
    stubFetch(() => json({ id: "j1" }));
    await api.patchJob("j1", { notes: "hi" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.headers["x-hussla-step-up"]).toBeUndefined();
  });
});

describe("errors", () => {
  it("carries the server's stable code", async () => {
    stubFetch(() => json({ error: "changed since you read it", code: "changed-since-read" }, 409));
    const failure = await api.patchJob("j1", {}).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ApiError);
    expect(failure).toMatchObject({ status: 409, code: "changed-since-read" });
  });
});
