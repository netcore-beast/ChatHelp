# ChatHelp LinkedIn Conversation Reader

This Manifest V3 extension is the desktop companion for ChatHelp. It receives temporary `activeTab` access only when the user clicks the extension while viewing a LinkedIn Messaging conversation.

## Manual-safe boundary

- Reads only the currently open, visible conversation after an explicit click.
- Does not enumerate conversations, contacts, notifications, or connection graphs.
- Does not click, type into, submit, or send anything on LinkedIn.
- Keeps one pending snapshot in `chrome.storage.local` until the authenticated ChatHelp app imports and acknowledges it.
- Sends the snapshot only to the ChatHelp page through an extension content-script bridge. There is no extension network request or server sync.
- Stores attachment labels and types, not attachment download URLs.

## Local testing

1. Open `chrome://extensions`, enable Developer mode, and choose **Load unpacked**.
2. Select this `extension` directory.
3. Open one LinkedIn Messaging conversation and click the ChatHelp extension icon.
4. ChatHelp opens or focuses, imports the visible contact/thread into the encrypted local vault, then clears the pending extension snapshot.

LinkedIn may change its DOM. When capture fails, the extension stops and asks the user to keep the conversation header and at least one message visible; it never falls back to scanning the whole page.
