# Passkey prompts chained in one click are refused in Firefox

`2026-10-09` · from PR #16 (first NAS install) · area: `src/features/setup`

**Symptom:** a second passkey prompt in the same click (confirm, then create; save, then send a test) fails in Firefox (Zen) as "cancelled or timed out", while Playwright runs pass.
**Cause:** Firefox wants a passkey prompt to follow a user click closely and refuses a second one chained after the first; the Chromium virtual authenticator the e2e tests use doesn't enforce it.
**Do instead:** one passkey prompt per click: split the action into two buttons, each one tap.
**Check:** the component tests that assert one prompt per click, `src/features/setup/AddSparePasskey.test.tsx` and `MailStep.test.tsx` (PR #16).
