# Installable clients

ChatHelp has one local-first web codebase and three delivery forms:

| Client | Packaging | Current artifact | Security boundary |
|---|---|---|---|
| Browser/Windows PWA | Web App Manifest + service worker | `chathelp-pwa` | Browser sandbox; encrypted local vault |
| Windows desktop | Electron + electron-builder | Setup and portable `.exe` files | Context isolation, sandbox, no Node integration, restricted external navigation |
| Android | Capacitor | Debug-signed `.apk` preview | HTTPS WebView origin, no cleartext traffic, Android backup disabled |

## Build only in Codespaces or GitHub Actions

`npm ci` prepares self-hosted OCR assets and PWA icons. The repository workflow **Package installable apps** verifies the application and produces all artifacts. Trigger it from the Actions tab with **Run workflow**. Artifacts are retained for 14 days.

- `chathelp-pwa`: static PWA export.
- `chathelp-windows`: unsigned preview Setup and portable executables.
- `chathelp-android`: debug-signed preview APK.

The preview packages are installable for testing but are not production-distribution builds. Windows SmartScreen may warn about an unsigned executable. A production release requires a protected code-signing certificate or Microsoft Store signing. Android production distribution requires a private release keystore stored as an Actions secret and Play App Signing. Never commit signing keys or passwords.

## Manual platform handoff

The app can label a conversation as LinkedIn, Gmail, Outlook, or another HTTPS service. It opens a reviewed destination in the system browser and copies no credentials. ChatHelp does not inject scripts, read a whole account, or send messages. Screen capture always uses the operating-system/browser chooser and OCR runs locally.

The Windows wrapper only opens the built-in LinkedIn, Gmail, and Outlook hosts. Custom service URLs remain supported in the browser/PWA; they are deliberately blocked by the Windows wrapper until a reviewed allowlist policy is added.

## Production signing checklist

1. Pin a release tag and require successful CI.
2. Generate an SBOM and publish checksums for every artifact.
3. Sign Windows packages with a protected certificate or publish the PWA through Microsoft Store/PWABuilder.
4. Sign Android App Bundles with a protected upload key and use Play App Signing.
5. Run mobile/desktop penetration tests and dependency review.
6. Publish supported versions, update policy, privacy limits, and incident contact.

References: [Microsoft Windows distribution paths](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/choose-distribution-path), [Publish a PWA to Microsoft Store](https://learn.microsoft.com/en-us/microsoft-edge/progressive-web-apps/how-to/microsoft-store), [Android Trusted Web Activities](https://developer.android.com/develop/ui/views/layout/webapps/trusted-web-activities), [Capacitor documentation](https://capacitorjs.com/docs), and [Electron security checklist](https://www.electronjs.org/docs/latest/tutorial/security).
