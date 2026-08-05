# Desktop LinkedIn workflow

ChatHelp provides an opt-in progressive inbox while retaining a strict local-storage and manual-send boundary.

## Automatic synchronization flow

    User clicks Enable automatic LinkedIn conversation sync
        → Chrome requests only the optional https://www.linkedin.com/* host permission
        → an isolated Manifest V3 content script activates on LinkedIn Messaging pages
        → the user manually opens a conversation
        → the reader selects LinkedIn's visible central application region and conversation thread
        → the visible header identity is read before any message nodes
        → only visible central message text, sender direction, timestamps, and attachment labels are extracted
        → SPA route and relevant DOM changes are debounced
        → unchanged snapshots are discarded
        → the snapshot passes directly through the local extension bridge without extension content storage
        → ChatHelp matches profile URL, then conversation URL, then a guarded unique name
        → an unknown contact is created, or the unambiguous existing contact is updated
        → messages are deduplicated and the result is encrypted in the local device vault

The extension does not inspect cookies, call LinkedIn APIs, enumerate conversation previews, open chats, click, type, scroll, paste, or send. Disabling synchronization unregisters the content script and revokes the optional LinkedIn permission. The toolbar action remains a one-time capture fallback whose session copy is deleted after ChatHelp acknowledges it.

## Identity and deduplication

- Normalized LinkedIn profile URL is the primary contact identifier.
- The stable conversation URL is secondary.
- Normalized name is used only when it produces one guarded match.
- Ambiguous contacts are never merged automatically.
- Stable LinkedIn DOM message identifiers are preferred.
- Without a stable identifier, ChatHelp fingerprints contact identity, sender, normalized message text, visible timestamp, and visible attachment labels.
- Synchronization updates visible metadata while preserving local labels, notes, stages, reminders, snooze state, outcomes, and draft history.

## Inbox and pipeline

- Inbox filters cover Main inbox, To respond, Awaiting reply, Follow-up due, Snoozed, New contacts, and Archived.
- Pipeline supports Inbox, Hot, Warm, Cold, Follow-up, Replied, Snoozed, and Done stages.
- Labels, private notes, snooze time, follow-up time, first synchronization, and last synchronization are kept per contact.
- J/K, E, R, S, L, Ctrl/Command+J, G then I, and ? provide keyboard-first triage without affecting LinkedIn.
- Up to 20 editable draft sets and bounded local AI usage metadata are retained under each contact's retention setting.

## Manual-send boundary

ChatHelp can copy an edited draft to the clipboard. The user switches to LinkedIn, reviews the content, pastes it, and clicks Send. **Mark manually sent** only records the already-completed human action in the local vault and advances the pipeline to Replied. It never calls LinkedIn or modifies LinkedIn's composer.

## Failure behavior

If the central conversation header or thread is unavailable, extraction fails closed with a bounded status. Paused, disabled, or revoked synchronization prevents further reads. When LinkedIn changes its DOM, ChatHelp never broadens capture to navigation, conversation previews, recommendations, job cards, or side panels; cropped local OCR and manual paste remain available.
