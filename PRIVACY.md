# ChatHelp privacy notice

ChatHelp uses Cloudflare Access for approved-email authentication and MFA. It has no advertising or analytics SDK. The persistent workspace remains in the user's browser; selected text is sent to Cloudflare Workers AI only after explicit consent and a generation request.

## Data the user chooses to add

A user may add selected chat lines, profile notes, personal guidance, context files, a user-selected screen capture, draft feedback, and outcome notes. ChatHelp does not scan a LinkedIn account or select people automatically.

## Processing and storage

Screen images are captured only after the browser's permission prompt, processed locally by self-hosted OCR, and are not persisted; only extracted text is added to the encrypted workspace. Persistent content is encrypted in IndexedDB using a random, non-exportable AES-256 device key stored by the browser. There is no routine ChatHelp passphrase prompt. An older passphrase vault requires its existing passphrase once for local conversion.

## External requests

When the user requests drafts and has consented, ChatHelp sends the relevant recent chat, selected context, guidance, and agenda as text to its authenticated Cloudflare Worker and Workers AI. Screenshots, the complete vault, and the device encryption key are not sent. Opening LinkedIn is a separate user action and LinkedIn operates under its own terms and privacy policy.

## User control

Users can select per-contact retention, remove individual documents or contacts, and erase the complete local vault and device key. Clearing browser site data, changing browser profiles, or losing the device removes access to this local-only workspace. The current device-encrypted release does not provide cross-device recovery or encrypted backup export.

See [SECURITY.md](SECURITY.md) for the threat model and limitations.
