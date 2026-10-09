/*
  Checks a draft before the owner approves it: a guessed address, or a [placeholder] an agent left in.
  In the app: the email editor and the approve panel show these above their buttons.
  Used by: src/features/outbox/EmailEditor.tsx, src/features/outbox/ApprovePanel.tsx.
*/
import type { Contact } from "@/shared/api";
import { firstEmail, hasPlaceholder, splitAddresses } from "@/shared/lib/format";

type Draft = { to: string; subject: string; body: string };

export const emailWarnings = (draft: Draft, contacts: readonly Contact[]): string[] => {
  const warnings: string[] = [];
  const recipients = splitAddresses(draft.to).map((address) => address.toLowerCase());
  for (const contact of contacts) {
    const address = firstEmail(contact.email ?? "").toLowerCase();
    if (contact.emailStatus === "inferred" && address !== "" && recipients.includes(address)) {
      warnings.push(`${address} was guessed from the company's email pattern, not confirmed. It may bounce.`);
    }
  }
  if (hasPlaceholder(draft.subject, draft.body)) warnings.push("The message still has a [placeholder] in it.");
  return warnings;
};
