[日本語](desktop.md) | **English**

# Desktop app

A macOS proposal application. It runs the existing CLI as a separate process and displays the existing screen in Electron.

## Startup and shutdown

The app prevents duplicate launches and checks Docker and GitHub CLI connectivity in its setup screen. The CLI creates a configuration template only when missing. The existing configuration determines the required images. Only missing images matching the bundled manifest name and CPU trigger an archive import and another check. A missing custom image never triggers a standard-image import. Missing custom images produce an explanation.

After starting the CLI, the app captures the authentication URL and waits up to 60 seconds for an HTTP response before opening a dedicated window. Failed startup stops the launched CLI and allows retrying. Quitting invokes the existing CLI shutdown procedure and waits up to 35 seconds. Configurations with screen authentication disabled are rejected. Every quit request during shutdown is deferred; quitting is allowed only after shutdown completes. Shutdown failures are reported and can be retried.

Code: `apps/desktop/main.cjs`, `apps/desktop/runtime.cjs`

## Image updates

When the configured `image` is an older standard image, the app shows the replacement and asks for confirmation. Only the standard repository name with a three-component numeric version is eligible. Custom names, registries, tags, and future versions are left unchanged.

After confirmation, the current image is checked and imported from the bundle if missing. The original settings are then backed up with mode 600 before changing only the image name, preserving YAML comments and other settings. Cancellation and import failure leave settings untouched. Edits made after confirmation are not overwritten. Parsed YAML values before and after the update are compared. If anything other than the top-level `image` changes, the update is rejected before creating backup or temporary files. This also rejects changes to aliases sharing a YAML anchor.

Code: `apps/desktop/config-tool.mjs`, `apps/desktop/runtime.cjs`

## Language and wording

Setup follows the OS language unless a selected `sacty-lang` is available. Japanese and English can be selected, stored for one year in the same HttpOnly cookie as the Web app, flushed to disk, and carried into the main screen. Bilingual dictionaries are checked for product naming, body and hint wording, and length. Hints appear on hover or focus and close with Escape or an outside interaction.

Code: `apps/desktop/messages.cjs`, `apps/desktop/preferences.cjs`, `apps/desktop/setup.js`, `tests/desktop/messages.test.ts`

## Authentication and permissions

Only the setup screen receives limited IPC capabilities; the sender is validated. API keys are saved under a fixed Keychain service. Keys are validated and passed through standard input, never process arguments. The input is cleared and keys are not logged. Up to 64KiB of standard error output is accumulated. On the `close` event, after standard streams have closed, the exit code and complete retained output are checked for errors. This includes output arriving after exit and error markers split across chunks. Output exceeding the limit is treated as failure because diagnostics would be incomplete.

The application screen has no preload script. Both windows disable Node.js integration and enable context isolation and sandboxing. Notifications are allowed only from the main screen's main frame on its own origin. Notification opt-in uses the existing settings screen; OS-level permission may also be required. All other permission requests, new windows, and external navigation are denied. Main-screen external links are handed to the default browser only for HTTP/HTTPS URLs without credentials. Redirects do not open the browser. Help opens a fixed URL in the selected language.

Code: `apps/desktop/main.cjs`, `apps/desktop/preload.cjs`, `apps/desktop/runtime.cjs`, `apps/desktop/links.cjs`, `apps/desktop/permissions.cjs`

## Packaging

The package includes Electron for the same CPU architecture, the build-time Node.js executable and license, built code, production dependencies, and a compressed default image archive. The default agent definitions in `config/agents.yaml` are included. Final links are rewritten as relative links within the bundle so they do not depend on staging directories. Links resolving outside the bundle or missing definitions fail packaging. The image is exported from an already-built local image. Packaging does not copy host configuration, keys, or work history. Signing, notarization, automatic updates, and image publication are not performed.

Code: `apps/desktop/scripts/package.mjs`, `apps/desktop/scripts/start.mjs`, `apps/desktop/packaging.cjs`

A DMG can be created from the packaged application. The app is copied while preserving relative links and stored in a compressed disk image alongside a link to the Applications folder. Signing and notarization are not added.

Code: `apps/desktop/scripts/dmg.mjs`

Packaged-app verification uses a temporary folder from copying through shutdown verification. On success, verification failure, or copy failure, it waits for application shutdown before recursively removing the folder. If shutdown cannot be confirmed, it keeps the folder and reports an error.

Code: `apps/desktop/scripts/smoke.mjs`, `apps/desktop/scripts/smoke-workspace.mjs`
