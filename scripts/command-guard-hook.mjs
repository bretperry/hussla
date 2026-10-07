#!/usr/bin/env node
// The agent hooks' entry for command-guard: runs it, and turns any way it fails to answer into a block.
// In the app: nothing at runtime; Claude Code PreToolUse (Bash) and Cursor beforeShellExecution call it before every agent command.
// Used by: .claude/settings.json, .cursor/hooks.json; tested by scripts/command-guard.test.mjs.
// Uses: scripts/command-guard.mjs (main()).
//
// Claude Code reads a hook's exit code: 0 is its answer, 2 blocks, and anything else is a
// "non-blocking error", so the command runs. command-guard answers its own failures (an ask), but
// only once it has loaded: a syntax error, a missing or unreadable file, or a crash outside main()
// exits 1, and every command would run unguarded. This file is small, imports nothing outside Node,
// and so is still standing when the guard isn't: it loads the guard, and any exit other than 0 or 2
// becomes 2, with the reason on stderr (which Claude Code shows the agent). A block, not an ask:
// a guard that can't load reads nothing, the same as a rule file that doesn't load (every command
// refused, branch-protection.mdc), and the human's off switch still works.

import { writeSync } from "node:fs";

// The host, as command-guard reads it (its argv[2]), and the human's off switch.
const cursor = process.argv[2] === "cursor";
const off = process.env.WHIPPLETREE_GUARD === "off";

// Says why the command is blocked: Cursor reads a JSON answer, Claude Code reads stderr with exit 2.
// Each write may fail (a closed pipe); the exit code still blocks.
const blocked = (why) => {
  const message = `command-guard: ${why}, so this command is blocked. Tell the user: fix it, or set WHIPPLETREE_GUARD=off in the shell that starts the agent (branch-protection.mdc).`;
  if (cursor) {
    try {
      writeSync(1, JSON.stringify({ permission: "deny", user_message: message, agent_message: message }));
    } catch {
      // The exit code below still blocks.
    }
  }
  try {
    writeSync(2, `${message}\n`);
  } catch {
    // Nowhere left to say it.
  }
};

// Any exit but an answer (0) or a block (2) is a guard that died before answering: an uncaught
// throw, a rejected promise, or a process.exit(1) from anywhere. Node lets an exit listener change
// the code, whichever way the process is ending.
process.on("exit", (code) => {
  if (code === 0 || code === 2 || off) return;
  blocked(`the guard exited with code ${String(code)} without answering`);
  process.exitCode = 2;
});

try {
  // A dynamic import, so a guard that doesn't parse or isn't there throws here, where it is caught.
  const { main } = await import("./command-guard.mjs");
  main();
} catch (error) {
  if (off) process.exit(0);
  blocked(`the guard didn't load (${error instanceof Error ? error.message : String(error)})`);
  process.exit(2);
}
