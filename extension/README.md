# ChatHelp LinkedIn Conversation Reader

This Manifest V3 extension is the desktop companion for ChatHelp. It receives temporary `activeTab` access only when the user clicks the extension while viewing a LinkedIn Messaging conversation.

## Manual-safe boundary

- Requires an existing LinkedIn contact to be selected in ChatHelp first.
- Verifies the open conversation matches that selected contact before traversing any message nodes.
- Reports connection, selector, identity, and empty-message failures inside ChatHelp instead of relying on a short-lived extension badge.
- Reads only that matching, currently open, visible conversation after an explicit click.
- Does not enumerate conversations, contacts, notifications, or connection graphs.
- Does not click, type into, submit, or send anything on LinkedIn.
- Keeps one pending snapshot in `chrome.storage.local` until the authenticated ChatHelp app imports and acknowledges it.
- Sends the snapshot only to the ChatHelp page through an extension content-script bridge. There is no extension network request or server sync.
- Stores attachment labels and types, not attachment download URLs.

## Local testing

1. Open `chrome://extensions`, enable Developer mode, and choose **Load unpacked**.
2. Select this `extension` directory. When updating an existing installation, click **Reload** on its card and confirm version `0.3.0`, then reload the ChatHelp tab.
3. Add or select a LinkedIn contact in ChatHelp. Use the person's full LinkedIn name when possible.
4. Open that same contact's LinkedIn Messaging conversation and click the ChatHelp extension icon.
5. ChatHelp opens or focuses, imports the visible messages into only that existing contact's encrypted local record, then clears the pending extension snapshot. A different contact is blocked before message reading begins. For a shortened saved name, ChatHelp can show and confirm the header-only LinkedIn identity; return to LinkedIn and click the extension again after confirming.

LinkedIn may change its DOM. When capture fails, the extension stops, focuses ChatHelp, and displays the exact safe failure reason. It never falls back to scanning the whole page.
