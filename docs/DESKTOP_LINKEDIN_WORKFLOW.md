# Desktop LinkedIn workflow

ChatHelp&apos;s desktop workflow borrows the useful inbox and pipeline ideas from Pinqio while retaining a stricter local-storage boundary.

## Capture flow

    User opens one LinkedIn conversation
        → user clicks the ChatHelp extension
        → Chrome grants temporary activeTab access
        → an isolated function reads the visible contact header and message thread
        → one validated snapshot is held in chrome.storage.local
        → the authenticated ChatHelp tab receives it through the extension bridge
        → ChatHelp merges and encrypts it in the local device vault
        → ChatHelp acknowledges the capture and the extension deletes its pending copy

The snapshot contains the contact name, visible headline, sanitized profile/avatar URLs, the current conversation URL without query parameters, visible message text, available timestamps, speaker direction, and visible attachment labels/types. Attachment download URLs are deliberately excluded.

## Inbox and pipeline

- Inbox excludes archived conversations and conversations that are still snoozed.
- Pipeline supports Inbox, Hot, Warm, Cold, Follow-up, Replied, Snoozed, and Done stages.
- Labels, CRM-style private notes, snooze time, follow-up time, and the last extension sync are kept per contact.
- Reminder view sorts scheduled conversations by the next due time and highlights overdue items.
- J/K, E, R, S, L, Ctrl/Command+J, G then I, and ? provide keyboard-first triage without affecting LinkedIn.
- Up to 20 editable draft sets and bounded local AI usage metadata are retained under each contact&apos;s retention setting.

## Manual-send boundary

ChatHelp can copy an edited draft to the clipboard. The user switches to LinkedIn, reviews the content, pastes it, and clicks Send. **Mark manually sent** only records the already-completed human action in the local vault and advances the pipeline to Replied. It never calls LinkedIn or modifies LinkedIn&apos;s composer.

## Failure behavior

If LinkedIn changes its DOM, extraction fails closed with an extension badge message. It never broadens capture to the page, other conversations, or the user&apos;s network. Users can use the existing cropped local OCR or manual paste fallback until selectors are reviewed and updated.
