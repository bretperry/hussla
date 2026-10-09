/*
  Component tests for Settings → "Add an agent": create a key, see each snippet with this page's origin and the key, copy, hide.
  In the app: nothing at runtime; guards the one-time key display and the snippet text agents are configured from.
  Used by: pnpm test.
  Uses: Testing Library, spies on the typed api client (the passkey tap itself is tested in api.test.ts).
*/
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, api } from "@/shared/api";
import { AddAgent } from "./AddAgent";
import { agentSnippets } from "./agent-snippets";

afterEach(() => vi.restoreAllMocks());

const KEY = "hk_test_0000000000000000";
const created = { id: "k9", name: "Laptop Claude Code", token: KEY };

const createKey = async (user: ReturnType<typeof userEvent.setup>, name = "Laptop Claude Code") => {
  await user.type(screen.getByLabelText("Agent name"), name);
  await user.click(screen.getByRole("button", { name: "Create key" }));
};

describe("agentSnippets", () => {
  const snippets = agentSnippets("https://hussla.example.ts.net", KEY);
  const byId = (id: string) => snippets.find((snippet) => snippet.id === id)?.text ?? "";

  it("builds the Claude Code command against /mcp with the bearer header", () => {
    expect(byId("claude-code")).toBe(`claude mcp add --transport http hussla https://hussla.example.ts.net/mcp --header "Authorization: Bearer ${KEY}"`);
  });

  it("builds JSON configs that parse, with the url and header filled in", () => {
    expect(JSON.parse(byId("json"))).toEqual({ mcpServers: { hussla: { url: "https://hussla.example.ts.net/mcp", headers: { Authorization: `Bearer ${KEY}` } } } });
    expect(JSON.parse(byId("claude-desktop"))).toEqual({
      mcpServers: {
        hussla: {
          command: "npx",
          args: ["-y", "mcp-remote", "https://hussla.example.ts.net/mcp", "--header", "Authorization:${HUSSLA_AUTH}"],
          env: { HUSSLA_AUTH: `Bearer ${KEY}` },
        },
      },
    });
  });

  it("points the plain-API prompt at the guide on this origin", () => {
    expect(byId("prompt")).toContain("Hussla is at https://hussla.example.ts.net.");
    expect(byId("prompt")).toContain("Read https://hussla.example.ts.net/api/docs first");
  });

  it("keeps the unverified note on Claude Desktop", () => {
    expect(snippets.find((snippet) => snippet.id === "claude-desktop")?.title).toContain("(unverified)");
  });
});

describe("AddAgent", () => {
  it("creates the key by name, then shows every snippet with this page's origin and the key", async () => {
    const createAgentKey = vi.spyOn(api, "createAgentKey").mockResolvedValue(created);
    const onKeyCreated = vi.fn<() => void>();
    const user = userEvent.setup();
    render(<AddAgent onKeyCreated={onKeyCreated} />);
    await createKey(user);
    expect(createAgentKey).toHaveBeenCalledWith("Laptop Claude Code");
    expect(await screen.findByText(/won't be shown again/)).toBeInTheDocument();
    expect(onKeyCreated).toHaveBeenCalledOnce();
    const origin = window.location.origin;
    for (const title of ["Claude Code", "Cursor and other JSON configs", "Claude Desktop (unverified)", "Any other agent"]) {
      expect(screen.getByRole("heading", { name: title })).toBeInTheDocument();
    }
    expect(screen.getByText(`claude mcp add --transport http hussla ${origin}/mcp --header "Authorization: Bearer ${KEY}"`)).toBeInTheDocument();
    expect(screen.queryByLabelText("Agent name")).toBeNull();
  });

  it("copies a snippet's exact text", async () => {
    vi.spyOn(api, "createAgentKey").mockResolvedValue(created);
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    render(<AddAgent onKeyCreated={vi.fn<() => void>()} />);
    await createKey(user);
    await user.click(await screen.findByRole("button", { name: "Copy Cursor and other JSON configs setup" }));
    const expected = agentSnippets(window.location.origin, KEY).find((snippet) => snippet.id === "json")?.text;
    expect(writeText).toHaveBeenCalledWith(expected);
  });

  it("hides the key for good on Done, back to the name form", async () => {
    vi.spyOn(api, "createAgentKey").mockResolvedValue(created);
    const user = userEvent.setup();
    const { container } = render(<AddAgent onKeyCreated={vi.fn<() => void>()} />);
    await createKey(user);
    await user.click(await screen.findByRole("button", { name: "Done, hide the key" }));
    expect(container.textContent).not.toContain(KEY);
    expect(screen.getByLabelText("Agent name")).toBeInTheDocument();
  });

  it("shows the server's reason when the key can't be made, and no snippet", async () => {
    vi.spyOn(api, "createAgentKey").mockRejectedValue(new ApiError("Passkey tap cancelled.", 403));
    const onKeyCreated = vi.fn<() => void>();
    const user = userEvent.setup();
    render(<AddAgent onKeyCreated={onKeyCreated} />);
    await createKey(user);
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("Passkey tap cancelled.")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Create key" })).toBeEnabled());
    expect(screen.queryByRole("heading", { name: "Claude Code" })).toBeNull();
    expect(onKeyCreated).not.toHaveBeenCalled();
  });
});
