/*
  The copy-ready setup snippets for a new agent: Claude Code, JSON-file clients (Cursor), Claude Desktop, and a plain-API prompt.
  In the app: Settings → "Add an agent" shows one of each, with this install's origin and the new key filled in.
  Used by: src/features/settings/AddAgent.tsx.

  The origin comes from the browser (the address Hussla was opened at), never a hard-coded tailnet name.
  The MCP endpoint and its bearer-key header are described in docs/agents-api.md.
*/

export type AgentSnippet = {
  id: "claude-code" | "json" | "claude-desktop" | "prompt";
  title: string;
  hint: string;
  text: string;
};

// The MCP server's name in each client's config; agents see their tools under it.
const SERVER_NAME = "hussla";

export const agentSnippets = (origin: string, key: string): AgentSnippet[] => {
  const endpoint = `${origin}/mcp`;
  const bearer = `Bearer ${key}`;
  return [
    {
      id: "claude-code",
      title: "Claude Code",
      hint: "Run in a terminal. Add --scope user to use it in every project.",
      text: `claude mcp add --transport http ${SERVER_NAME} ${endpoint} --header "Authorization: ${bearer}"`,
    },
    {
      id: "json",
      title: "Cursor and other JSON configs",
      hint: "Merge into ~/.cursor/mcp.json (or your client's MCP config file).",
      text: JSON.stringify({ mcpServers: { [SERVER_NAME]: { url: endpoint, headers: { Authorization: bearer } } } }, null, 2),
    },
    {
      id: "claude-desktop",
      title: "Claude Desktop (unverified)",
      hint: "Its config runs local commands, so this goes through the mcp-remote shim (needs Node). Not yet tried end to end.",
      text: JSON.stringify(
        {
          mcpServers: {
            [SERVER_NAME]: {
              command: "npx",
              // ${HUSSLA_AUTH} is literal: mcp-remote expands it from env, which keeps the space in "Bearer …" out of the args.
              args: ["-y", "mcp-remote", endpoint, "--header", "Authorization:${HUSSLA_AUTH}"],
              env: { HUSSLA_AUTH: bearer },
            },
          },
        },
        null,
        2,
      ),
    },
    {
      id: "prompt",
      title: "Any other agent",
      hint: "Paste into the agent's instructions; it uses the plain HTTP API.",
      text: `You work on my job search. Hussla is at ${origin}. Send Authorization: ${bearer} on every request. Read ${origin}/api/docs first and follow its rules.`,
    },
  ];
};
