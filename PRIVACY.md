# ChatHelp privacy notice

ChatHelp currently has no account system, application server, analytics, advertising, or AI prompt API. The workspace is processed in the user's browser.

## Data the user chooses to add

A user may add selected chat lines, profile notes, personal guidance, context files, a user-selected screen capture, draft feedback, and outcome notes. ChatHelp does not scan a LinkedIn account or select people automatically.

## Processing and storage

Text generation runs in an isolated browser worker with an on-device WebLLM model. Screen images are captured only after the browser's permission prompt, processed locally by self-hosted OCR, and are not persisted; only the extracted text is added to the encrypted workspace. Persistent content is encrypted in IndexedDB using a key derived from the user's passphrase.

## External requests

The first use of a model downloads public model files from the allowlisted model hosts. Those providers receive normal web-request metadata, not prompts from ChatHelp. Opening LinkedIn is a separate user action in a new tab. The LinkedIn site then operates under LinkedIn's own terms and privacy policy.

## User control

Users can lock the vault, select per-contact retention, remove individual documents or contacts, export an encrypted backup, and erase the complete local vault. Backups remain the user's responsibility. ChatHelp cannot recover a forgotten passphrase or a deleted vault.

See [SECURITY.md](SECURITY.md) for the threat model and limitations.
