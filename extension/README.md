# DialogMint LinkedIn Conversation Reader

This Manifest V3 companion supports two user-controlled modes:

- Optional automatic sync of the visible LinkedIn conversation the user manually opens.
- A one-time toolbar capture fallback.

## Privacy boundary

When automatic sync is enabled, DialogMint reads the visible LinkedIn conversation you manually open. It does not scan the inbox, access LinkedIn cookies, open conversations, click, type, scroll, or send messages.

- Automatic sync is off by default.
- Enabling it requests only the optional 'https://www.linkedin.com/*' host permission.
- The isolated content script runs only on LinkedIn Messaging pages.
- It observes SPA route and central-thread DOM changes with debouncing.
- Only the visible conversation header and central message thread are queried.
- Background conversation previews, navigation, job cards, recommendations, notifications, and side panels are excluded.
- No LinkedIn API or authenticated network request is made.
- Automatic snapshots are handed directly to the authenticated DialogMint app and are not stored by the extension.
- A one-time manual snapshot may remain in extension session storage only until DialogMint acknowledges the encrypted local-vault import.
- Disabling sync unregisters the content script and revokes the optional LinkedIn host permission.

## Local testing

1. Open 'chrome://extensions', enable Developer mode, and choose **Load unpacked**.
2. Select this 'extension' directory. When updating, click **Reload** and confirm version '0.5.1', then reload the DialogMint and LinkedIn tabs.
3. In desktop DialogMint, click **Enable automatic LinkedIn conversation sync** and approve Chrome's LinkedIn host prompt.
4. Manually open conversations at LinkedIn Messaging. DialogMint's local inbox grows only from conversations you open.
5. Test Pause, Resume, and Disable. Disable must revoke the optional host permission.
6. For a one-time fallback, open one LinkedIn conversation and click the DialogMint extension icon.

LinkedIn may change its DOM. When the layout is unsupported, the extension reports a safe status and stops; it never broadens its scan.

The bridge is restricted to DialogMint's exact production and testing Worker hosts. The testing host is a Cloudflare aliased preview of the same Worker version stream; it is not a second Worker and receives no broader Chrome capability.
