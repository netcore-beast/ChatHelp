# ChatHelp privacy notice

ChatHelp uses Cloudflare Access for approved-email authentication and MFA. It has no advertising or analytics SDK. The persistent workspace remains in the user's browser; selected text is sent to Cloudflare Workers AI only after explicit consent and a generation request.

## Data the user chooses to add

A user may add selected chat lines, profile notes, personal guidance, context files, a user-selected screen capture, private conversation notes, labels, reminders, draft feedback, and outcome notes. On desktop Chrome, a user may explicitly click the ChatHelp extension while one LinkedIn Messaging conversation is open. The extension reads only the visible open thread and does not enumerate the inbox or select people automatically.

## Processing and storage

Extension snapshots are validated, merged, encrypted in the local vault, and acknowledged so the extension can remove its one pending copy. The extension makes no network request. Avatar previews may be requested directly from LinkedIn&apos;s image CDN and use a no-referrer request. Screen images used by the OCR fallback are captured only after the browser&apos;s permission prompt, processed locally, and are not persisted. Persistent content is encrypted in IndexedDB using a random, non-exportable AES-256 device key stored by the browser. There is no routine ChatHelp passphrase prompt. An older passphrase vault requires its existing passphrase once for local conversion.

## External requests

When the user requests drafts and has consented, ChatHelp sends the relevant recent chat, selected context, guidance, and agenda as text to its authenticated Cloudflare Worker and Workers AI. Screenshots, the complete vault, and the device encryption key are not sent. Opening LinkedIn is a separate user action and LinkedIn operates under its own terms and privacy policy.

## User control

Users can select per-contact retention, remove individual documents or contacts, and erase the complete local vault and device key. Clearing browser site data, changing browser profiles, or losing the device removes access to this local-only workspace. The current device-encrypted release does not provide cross-device recovery or encrypted backup export.

See [SECURITY.md](SECURITY.md) for the threat model and limitations.
