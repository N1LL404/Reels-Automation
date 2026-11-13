# AdXtreme Reels Kit

A local Windows profile manager with an Electron desktop UI and browser-accessible UI. It creates isolated browser profiles, imports cookie lines, edits proxies, and starts/stops the bundled SunBrowser through a small CDP client.

## Windows installer

Run the x64 setup EXE in the release folder. The wizard defaults to `%LOCALAPPDATA%\Programs\AdXtreme Reels Kit` and lets you select an empty folder. Launch the installed app from Start or the desktop. Windows Settings → Apps can uninstall it.

The installed app saves profile settings in `%LOCALAPPDATA%\AdXtreme Reels Kit\Workspace\profiles`, browser sessions in `Workspace\data`, and upload screenshots in `Workspace\screenshots`. Installations that predate the rename keep using `%LOCALAPPDATA%\Facebook Reels Kit\Workspace`. Reinstalling or uninstalling the app preserves this workspace. The shareable installer contains the two runtimes and starts with an empty profile library on a new PC.

To carry your development profiles into a fresh installation on the same Windows account, close both copies of the app and their browsers. Back up both workspaces, then copy the project's `profiles` and `data` folders into the installed app's empty `Workspace` folder. Keep the original folders. Copy `screenshots` too if desired. Browser session credentials can be tied to the original Windows account.

Build another installer on Windows with `python installer/build.py`. The script uses the installed Electron distribution, the bundled kernel, NSIS and rcedit. It looks for the packaging tools on PATH and in the local electron-builder cache.

Profiles have a persistent `serialNumber` and `createdAt` in their JSON configuration. Older profiles receive numbers once, in file creation order with filename as a tie-breaker. The workspace's `profile-order.json` reserves the next number so deleting profiles never renumbers the remaining profiles or reuses deleted numbers. Include that file when backing up or moving an existing workspace. Show and Sort controls only affect presentation. Upload selections are separate from profile management selections.

## Running from source

Requires Node.js 22+ and `kernel/SunBrowser.exe`. Imported cookie headers and proxy credentials are stored locally in plaintext; treat `profiles/` and `data/` as private. A previously embedded API-key-like value has been removed: optional Google integration now reads `GOOGLE_API_KEY` from the environment. Review/revoke the old key if it belongs to you. Existing generated browser files were not scrubbed.

## Run

From the project directory:

```powershell
npm ci
npm run gui
```

For browser access:

```powershell
npm run serve
```

Open `http://127.0.0.1:8899`. Set `PORT` in the process environment to change the port. The API accepts same-origin browser requests and binds only to loopback. Desktop mode now loads this same local origin. Local command-line clients can still call the API without an Origin header; this is not an authentication boundary against other local processes.

Create a Windows or Android profile, select it, and click Start. Saving proxy settings stops the profile; start it again to use the new settings. Clear the proxy host to remove the proxy. Search matches profile names and platforms. Checkboxes select profiles for bulk deletion; deleting a profile also deletes its browser data after confirmation.

## Verify

```powershell
npm run check
npm test
npm run test:ui
npm run batch -- 2 Windows
npm run verify -- about:blank Windows
npm run verify -- about:blank Android
```

`check` checks JavaScript syntax; it is not a semantic linter. `test` runs Node regression tests, including a temporary loopback HTTP server. `test:ui` opens a hidden Electron window with synthetic data and writes screenshots into `test/artifacts/`. It never launches stored account profiles. The verification scripts launch fresh real browser profiles and leave their generated data directories behind; they print diagnostics rather than asserting fingerprint consistency. Tests may require loopback/native process access outside restrictive sandboxes.

## Project map

| Location | Purpose |
| --- | --- |
| `electron/main.js`, `preload.js` | Desktop entry, server startup, window and shutdown handling |
| `gui/index.html`, `style.css`, `app.js` | Vanilla DOM UI, CSS-variable dark theme, profile state and API calls |
| `src/server.js` | Loopback JSON API and static assets |
| `src/manager.js` | In-memory session lifecycle and start/stop coordination |
| `src/index.js` | Profile loading, geo resolution, browser launch orchestration |
| `src/kernel.js` | Kernel configuration files and process launch |
| `src/cdp.js` | WebSocket CDP commands, pages and browser contexts |
| `src/geo.js`, `cookies.js` | Geo lookup/proxy parsing and cookie import conversion |
| `src/random.js`, `presets.js`, `assets/` | Profile generation and bundled preset data |
| `profiles/`, `data/` | Persistent JSON profiles and browser session data |
| `kernel/` | Bundled executable, components and existing runtime data |
| `test/` | Regression tests, UI smoke test and legacy browser diagnostics |

There is no bundler or build step; Electron is the only declared dependency. See [the upgrade report](2026-10-31_engineering-fingerprint-studio-report.md) for findings, changed files, evidence and remaining work.

## Check Facebook UIDs

Click **Check all UIDs** to check every profile, or select a profile and click **Check UID**. Progress and Alive / Dead / Check failed / No UID badges update as requests finish (up to three requests at once).

The checker sends only numeric UIDs to `https://check.fb.tools/api/check/facebook`, with `checkFriends: false`; imported cookies and proxy credentials are not sent. UIDs are extracted from imported `c_user` cookies, falling back to `fb-<uid>` profile names, including duplicate-name suffixes. Ambiguous profiles are skipped.

The provider's `valid` status means Alive. Only explicit `invalid` or `noExist` results mean Dead. Network failures, rate limits, malformed responses and unknown statuses mean Check failed and are never included in dead-profile deletion.

**Delete dead profiles** appears when recent dead results exist. It shows a confirmation listing the profiles, then deletes those profiles and their browser data. The server independently requires a matching dead result from the last 15 minutes. Results are held in memory and cleared on app restart; rechecking invalidates an earlier result. This is the third-party service's account-status report, not a check of whether the stored cookies can log in.


## Download Facebook videos (desktop)

Open **Download Videos**, paste one Facebook video/Reel or profile HTTPS link per line (up to 100 inputs), select **HD** or **Normal**, and choose 1–10 simultaneous transfers. Duplicate URLs in the same batch are removed. Video links are resolved serially through fdown.net's own form; file transfers overlap. If the provider asks for verification, its isolated window appears. Complete verification there; closing that window fails only that video. No saved Facebook profile cookies or captured tokens are sent to the provider.

Videos default to your Windows **Downloads / AdXtreme Reels Kit** folder. **Choose folder** remembers another location across app restarts. **Open folder** and **Show file** reveal saved files. Byte counts and percentages use the server's content length; when unavailable the progress bar is indeterminate. Requested quality must exist; HD never silently falls back to Normal. Cancelled/failed transfers remove their `.part` files. Failed rows let you put the link back into the input for a retry. Closing the app cancels the queue; history and partial downloads are not resumed after restart. The app does not overwrite existing videos.

The provider is a third-party website, not a versioned API; verification or website changes can temporarily interrupt resolution. The captured request was to `https://fdown.net/download.php`, with `URLz` and a fresh Turnstile response. Provider HTML, tokens, cookies and temporary CDN URLs are not bundled with the installer.

Additional checks: `node test/run-ui.js downloads-ui.js` covers downloader UI; `npm test` covers streaming, concurrency, cancellation, host validation and failed downloads. `node test/run-ui.js download-provider-live.js` is an optional live check against the capture's sample video and removes its temporary output.


### Profile Reel collection

Download Videos detects direct video/Reel links versus profile URLs automatically. Both `profile.php?id=…` and `profile.php?id=…&sk=reels_tab` identify the same source; `/people/name/id/` and username profile links are supported too. Profiles open on their Reels tab in a separate Facebook session. The collector reads the actual `aggregated_fb_shorts` connection from the page and its pagination responses, checks the owner ID when the input supplies one, and scrolls to request later pages. It does not replay captured cookies, tokens or GraphQL document IDs.

Profile Reel collection runs with a fixed pool of five concurrent profiles; a free slot immediately starts the next profile. All profile links are collected before a mixed batch starts downloading. Each profile’s Open Facebook button targets its own collection window. The collection panel shows each profile's count, progress and errors, and a readable list of queue links. There is no Reel-count cap per profile or batch. Collection continues while Facebook supplies new Reels, then queues all collected links. Stalled pagination is reported as a **Partial list**, never as a complete profile; videos collected before the interruption are still queued. A five-minute timeout applies only when no Reel collection can be opened, not to progressing pagination. A failed profile does not prevent other profiles/direct video links from downloading. Duplicate canonical Reel URLs are downloaded only once per batch.

Facebook may require login/verification; use **Open Facebook** in the collection panel to complete it normally. This temporary Facebook session is separate from saved account profiles and the fdown provider session. Cancelling the queue stops both collection and transfers. Ten simultaneous transfers are supported, while fdown resolves fresh download links serially.

Validation: `npm test`; `node test/run-ui.js downloads-ui.js`; `node test/run-ui.js reel-discovery-browser.js` (synthetic scrolling/pagination); optional `node test/run-ui.js reel-discovery-live.js` (public sample profile); optional `node test/run-ui.js profile-download-live.js` (collects and downloads all available sample-profile Reels, then deletes temporary output).


## Reels Upload

Title and Description apply to each Reel in the batch. A blank Title uses the Description as the title. Entering only a Title preserves the description. It fills titles first, checks every description, and clicks an enabled Publish button once all the selected files have reached 100%. Each worker waits for an enabled Publish button and dispatches one click. About 7.5 seconds later it checks the submission state. The “Your bulk upload is processing!” dialog confirms acceptance of the batch for the selected publishing options. Unconfirmed submissions are flagged for review. If Facebook is still submitting, shows a publishing error, or the click outcome cannot be inspected safely, close the retained browser after reviewing it to release that slot. Other workers continue independently.

Profiles show the last composer login check. The check looks for a nonempty DTSGInitialData token in the loaded Facebook page. A visible login form or login redirect marks the profile logged out; a checkpoint requests verification. A missing marker alone is reported as unverified. The application saves the result and timestamp.


## Import Facebook accounts

Import Cookies accepts a cookie header on its own, or `UID|password|cookies`, or the same three fields separated by actual tabs. Paste one account per line. Use tabs if the password contains a pipe. A trailing `vpd` cookie on a separate line is joined to the preceding account record. A supplied `c_user` must match the UID. Format errors identify the line before any profiles are created.

During import the app saves the UID and password for `https://www.facebook.com/` using the bundled browser’s local password manager in a separate data directory for each new profile. This also applies to Android-style profiles running in SunBrowser on Windows. After import, open the profile and select the saved login on Facebook. Cookie-only imports continue to work. Configuration JSON contains the cookie header; the password is retained in the browser password store.
