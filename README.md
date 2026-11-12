# Bulwark Desktop

The Bulwark desktop app: a thin Electron shell around the webmail. Most of the code lives in the webmail. This repo has the main process, the preload bridge, the server host and packaging.

## Two modes

- **Standalone.** Any JMAP server, no Bulwark instance needed. The webmail's Next server runs inside the app.
- **Instance.** A window on a Bulwark instance URL, with the same bridge exposed only to that origin.

The first run asks which one. The File menu changes it later.

Each server keeps its own data on this computer: a partition of its own (the sign-in, mail kept offline, drafts, messages waiting to be sent) and the shell's records for it (edited attachments, the Files drive and synced folders of its accounts, local imports, crash files, windows to bring back, the app lock). "Change connection…" keeps the old server's data, so going back to it finds everything as it was, and then asks whether to remove it instead; Keep is the default. A wipe asked for by a server's page ("Remove everything from this device" in its settings, or a remote wipe its admin sends) removes that server's data and nothing of another server's, without asking: the page has asked already, and a remote wipe has nobody to ask. The servers approved on this computer belong to the standalone page and go with its wipe. Only the `WipeOfflineData` policy clears the whole profile, every server's data in it. Whatever a wipe covers goes completely: the partition's folder under `Partitions` is removed at the next start, before anything opens it again, and with it the network state Chromium keeps there, which names every server the app talked to. A folder that can't be removed yet (a program holds a file in it) is tried again at each start until it goes. When the page keeps its local storage to report the wipe to its server after the restart, the partition's `Local Storage` folder stays; the page has emptied it of everything else and drops the report once it is sent.

## Develop

```sh
npm install
# A desktop build of the webmail: run `npm run build:desktop` in a webmail checkout first.
node scripts/fetch-webmail.mjs --path ../path/to/webmail
npm start
```

`ELECTRON_RUN_AS_NODE` must not be set when launching Electron. For a second copy next to a running one: `node scripts/run-electron.mjs . --bulwark-user-data=<dir> --standalone`, or `--instance=<url>`. `--dev` adds the reload and devtools items. These switches only exist in a test build (`node build.mjs --test`, which `npm start` and `npm test` use), never in what ships.

## How it's built

- `src/main/` is the main process. ESM with top-level await: the random port has to be in `--host-resolver-rules` before Chromium's network service starts.
- `src/server/` runs in a utilityProcess: a custom `next()` server on TLS, with a per-install certificate pinned by fingerprint, answering only requests with a per-launch secret that main adds. See `src/server/host.ts`.
- `src/preload/` is the bridge, `window.bulwarkDesktop`. The webmail's side is `lib/desktop/`. `src/shared/bridge.ts` is a copy of the contract in `lib/desktop/types.ts`: change both together.
- `src/main/windows.ts` is the window manager: all app windows go through it.
- `src/main/menu.ts` is the app menu. Commands run in the page, through `menu.onCommand` and `lib/desktop/commands.ts` in the webmail. A feature adds its own lines with `menu.extend`. Native right-click menus are the webmail's HTML menus read back: `lib/desktop/native-menu.ts`.
- `src/main/features/` is where tray, jump lists, toasts, context menus and policies plug in. See `features/index.ts`.
- `src/main/features/import.ts` with `import-scan.ts`, `import-files.ts` and `import-books.ts` finds Thunderbird and Outlook data and gives a page read access to the files the user confirmed, through a `bulwark-import:` scheme that serves ranges from main. Each step asks natively. The disk work runs in `import-worker.ts`, a utilityProcess under a timeout, since a file on the disk can be built to hang.
- `native/` is the native helper: Windows Hello, the OS keystore for S/MIME, and the macOS check for forced preferences. `npm run build:native` needs Rust, and the app runs without it, with those features unavailable. Its exports are in `native/README.md`.

## OS integration

`src/main/features/os*.ts`: tray, badge, jump list, thumbnail toolbar, toasts, default mail app, files, start at login, sleep and wake. The page's side is `lib/desktop/` in the webmail; settings are on its General page. `os-rules.ts` holds the decisions with no Electron in them, and `assets/os` the icons: the tray's, made from the logo by `scripts/make-os-icons.cjs`, and those of the jump list, the thumbnail toolbar and the menus, made from the Tabler glyphs in `assets/glyphs` by `scripts/make-task-icons.mjs` (`node scripts/make-task-icons.mjs --webmail <webmail checkout>`, for sharp). Windows reads the jump list's .ico files itself, so a package has them as files in `resources/os-icons`, and the package guard checks each is there with every size. Test builds use their own AppUserModelID, so a test run never touches the installed app's jump list.

Unpackaged, these write under HKCU when asked, and a toast makes a Start Menu shortcut and a COM key. `test/os.spec.ts` takes them away again; on a hand run, look for `Bulwark Dev` under `Run`, `{C2D85A16-4E7B-4F39-8A10-6B3E9F72D154}` under `Software\Classes\CLSID` and `Electron.lnk` under Start Menu Programs.

A file dragged or copied out of the app is a temporary copy in a private folder (`%LOCALAPPDATA%\Bulwark\os-files`, or under userData elsewhere), gone within minutes, at sign-out and at quit. Save it somewhere before working on it: a program opened straight on that copy loses its edits when the copy goes. Decrypted S/MIME and PGP attachments never go through that folder.

"Edit" on an attachment is a different thing (`features/os-edit.ts`): a copy in a private folder of its own (`%LOCALAPPDATA%\Bulwark\edit-files`, or under userData elsewhere), only readable by this user, opened in its default program and watched, so a save there can be attached to a reply or update the draft it came from. Saved edits survive closing that program and quitting the app, and are offered again at the next start, also a file saved under a new name in that folder. Unchanged copies go after a day, changed ones when the user decides, at a sign-out they agreed to, at a wipe, or after 30 days and one last offer. A copy a program holds can't be deleted: it stays watched until that program lets go, a save in it is still offered, a notice says so, and a wipe doesn't count as done until it's gone. `shared/edit-rules.ts` lists the file types allowed in: Office without macros, ODF, pictures, PDF, plain text, CSV and geometry-only CAD. Everything else is Download only. `.doc`, `.xls`, `.ppt` and `.rtf` can hold macros, so they go on Windows only, with the mark from the internet written and read back, which is what makes Office use Protected View. The app lock stops new files opening and hides what was saved until the unlock, but it can't close another program: a file already open stays open there, and stays on disk until the user is done with it. **What the app can't clear:** the other program's own recovery files and its list of recent files, which can name this folder and keep a copy, whatever a sign-out or a wipe does here.

The composer's Attach menu lists the files the OS says were used last (`features/os-recent.ts`): the shortcuts in Windows' Recent folder, Spotlight's last-used date on macOS, GTK's `recently-used.xbel` on Linux. It's read when the menu opens, after a click main saw itself, and kept in memory for that window only. The page gets what the menu shows and an id per file; attaching takes the id, never a path, and goes through the same size limit as a file from "Open with". Every file system call runs in a utility process (`recent-files-worker.ts`), because a path on a share that's offline takes about 20 seconds to fail: each file gets 1.5 seconds, and what doesn't answer is left out. The `RecentFilesInAttach` policy turns it off. Test builds read `--bulwark-test-recent-dir=<folder of shortcuts>` instead of the real folder.

## Packaging

```sh
npm run pack:dir     # release/win-unpacked and so on, no installer
npm run dist:win     # NSIS and MSI, x64 and arm64
npm run dist:mac     # DMG and zip, universal. Run on a Mac.
npm run dist:linux   # AppImage, deb, rpm. Run on Linux.
```

`electron-builder.yml` is the config, `.github/workflows/release.yml` the builds. **Every push to `main` publishes a beta**, `<version in package.json>-beta.<run number>`, from a clean checkout, with the webmail built from its `main`. The notes and the app's About card say which webmail commit. A push that only touches docs makes no beta. A tag `v<version>` is a stable release: the same, with the webmail built from the tag in `config.webmailTag` in `package.json`. Provenance is a `.sha256` next to each installer and a signed attestation: `gh attestation verify <file> --repo bulwarkmail/desktop`. A hyphen in the tag makes it a prerelease, the beta channel.

- **The server is one file.** `scripts/before-pack.cjs` trims, guards and packs it into `server.asar`, about 3,100 files down to about 420 in the whole install, which is what a virus scanner reads at each update. Binaries the OS loads, `.next/static` and `public` stay loose in `server.asar.unpacked`. The server runs from inside the asar: `src/server/host.ts` answers `process.cwd()` with it, as an asar can't be a working directory.
- **The server is per target.** A webmail build holds sharp for its own machine only. For another architecture, `node scripts/fetch-webmail.mjs --native win32-arm64` adds that one's binaries. macOS always takes `darwin-x64,darwin-arm64`, also on an x64 or arm64 pack, since a universal build merges those two. `scripts/server-natives.mjs` keeps only what the target runs and fails the build if that's missing. esbuild and caniuse-lite go altogether: the embedded server has no use for them. So do Next's build and dev tools (`NEXT_BUILD_ONLY` there: Babel, the CSS and font tool chains, the dev overlay, the Turbopack and experimental page runtimes), about 13 MB.
- **The server's code is compiled ahead.** At pack time the build's own Electron runs the server once and renders the start pages (`src/server/code-cache-gen.ts`), and V8's compiled code for every file that ran goes into `server.asar` under `.code-cache`, covered by ASAR integrity like the rest. At start the host takes a file's code from there only when its bytes are the ones it was made from (`src/server/code-cache.ts`); anything else compiles as before, and nothing is written at run time. That saves the server most of its first second. It needs the target's binary to run, so a cross-architecture pack (Windows arm64 on x64) and macOS (whose universal halves must be the same bytes) ship without it.
- **The guard** (`scripts/package-guard.mjs`, run on the way in and out of the pack) fails the build on `data/`, `local-data/`, `.env*`, `repos/`, `plugin-signing.key`, in any case, links, anything unknown next to the server in `resources/`, or anything but the shell in `app.asar`. A build with test switches in it doesn't package either. It's tested in the real flow by `test/package-guard.spec.ts`.
- **Native modules** in the asar are unpacked next to it (`asarUnpack`). ASAR integrity stays on, and covers `server.asar` too. Unpacked files aren't covered by it: that's what signing is for.
- **macOS** is configured but has only been read, not run. Hardened runtime and notarization are driven by env, see the comments in `electron-builder.yml` and `build/entitlements.mac.plist`.
- **Icons** are in `build/`, made from the branding repo by `scripts/make-icons.mjs` and committed.
- **The Windows installer's window** is a borderless square like the app's splash: the logo, "Installing Bulwark…" ("Updating Bulwark…" when the app updates itself, "Removing Bulwark…" in the uninstaller), a line under it, a rounded progress bar in the accent colour and the percent. Dark or light as Windows' app mode is set, Windows' own colours with High Contrast on. It can be dragged anywhere and stays in the taskbar. The uninstaller shows it when a person starts it; with `/S` it stays silent. NSIS can't handle window messages from a script, so a small plugin paints it: `native/nsis-splash/splash.c`, built by `scripts/build-nsis-splash.mjs` (MSVC, 32-bit) into `build/x86-unicode/`, which `npm run dist:win` and the release do first. `build/installer-theme.nsh` calls it, `build/installer-strings.nsh` has the words for every installer language, `test/installer-look.spec.ts` checks them, runs the plugin and builds an installer. It takes no part in what gets installed.
- **The DMG's background** is `assets/dmg-background.svg`, rendered to `build/dmg-background.png` and `@2x` by `scripts/make-dmg-background.mjs`. The names under the icons are black in light mode and white in dark mode, so the field is a grey both read on.
- **The MSI** has no dialogs of its own: double-clicked, it shows Windows Installer's plain progress box, and IT runs it with `/qn`. There's nothing of ours to style there.

## Updates

electron-updater reads GitHub Releases of `bulwarkmail/desktop`. It looks 30 seconds after a start, then every 4 hours and after waking up, and downloads by itself. When an update is ready there's "Restart to Update" in the File menu, one notification and a row under Settings > General. It never asks during work. It installs at the next quit, silently, or on that item, through the normal quit, so open drafts are saved first and a page that asks to stay calls it off. "Restart to Update" shows the installer's progress, since someone is waiting. All update traffic goes to `github.com` and `*.githubusercontent.com` over https, redirects included. On Windows only the blocks of the installer that changed come down: each release has a `.blockmap` next to each installer, and the installer keeps a copy of itself in `%LOCALAPPDATA%\bulwark-desktop-updater` to build the next one from. If that fails for any reason, the whole installer comes down, and either way it's checked against the sha512 in `latest.yml`.

What a copy does depends on how it got there:

| Install | Updates |
| --- | --- |
| NSIS, per user | Replaces itself |
| AppImage | Replaces itself |
| MSI, per machine | Says a version exists. An administrator rolls out the new MSI. |
| deb, rpm | Says a version exists, with a link |
| macOS, unsigned | Says a version exists, with a link. Squirrel.Mac refuses unsigned apps. |
| macOS, signed | Replaces itself |

**Channels.** Stable, or beta for prereleases. Going to beta asks first. Going back to stable with a beta running does nothing by itself: the app stays on the beta until stable catches up. The settings page offers "Install older version…", which asks first and says what it can cost, and nothing older downloads without that yes. A download under way when the channel or a policy changes is given up. Stable never takes a prerelease. A copy stays on the channel it started on until someone chooses, also after it reaches a stable version. Beta reads the releases feed itself and takes the highest version, so a stable hotfix can't hide a newer beta, and it works while no stable release exists at all.

**Tests.** `node scripts/build-update-fixtures.mjs` builds three real installers with the test switches compiled in. `npx playwright test test/updater.spec.ts` installs them on this machine and runs electron-updater's real GitHub provider against a local stand-in. A normal build has no way to set another feed: `test/updater-rules.spec.ts` checks the string isn't there.

### Signing

- **Windows.** CI signs every build, betas included, through Azure Artifact Signing when the repository has the `AZURE_TENANT_ID`, `AZURE_CLIENT_ID` and `AZURE_CLIENT_SECRET` secrets. The publisher is **Rath & Blume GbR**. The installers, the MSI and the files in them are signed, and the job fails if an `.exe` or `.msi` lacks a valid signature by that name. Without the secrets, and in a local build, nothing is signed.
- **The updater checks the publisher.** A signed build's `app-update.yml` names the publisher, and electron-updater then refuses an installer that isn't signed by it. The first signed version installs fine over an unsigned one. Never change the publisher name without listing the old one too, or every signed install stops updating. Betas are signed for the same reason: a signed stable copy that moves to beta would refuse an unsigned beta.
- **Unsigned copies.** An unsigned Windows build skips that check and relies on the sha512 in `latest.yml`, which comes from the same release as the installer. So for those, **anyone who can publish a release on `bulwarkmail/desktop` can run code on every install that updates itself**. That's why a stable release waits for a reviewer.
- **SmartScreen.** A browser marks a downloaded file with its origin. Windows shows "Windows protected your PC" for an unsigned installer, and a signed one can still get it until the publisher has built up reputation. The user picks "More info", then "Run anyway". Updates aren't affected: the file the updater downloads has no such mark (checked by the test), and it needs no elevation.
- **macOS.** CI signs every build, betas included, with the Developer ID and notarizes it, when the `MAC_*` and `APPLE_*` secrets are there. The job fails if the app lacks a Developer ID signature, a stapled ticket or Gatekeeper's approval. Without the secrets, and in a local build, the app gets an ad-hoc signature, Gatekeeper warns (System Settings > Privacy & Security > Open Anyway the first time), and it can't update itself. An ad-hoc copy can't update itself to a signed one either: install the first signed build by hand.
- **Linux.** AppImage, deb and rpm have no such check. The AppImage updater has no signature check at all.

### Linux: use the deb or rpm

The deb and rpm are the recommended installs: they bring the SUID helper Chromium's sandbox needs.

An AppImage has no such helper, so it only runs where user namespaces work. Bulwark doesn't run unsandboxed: where they're blocked, it says so in a dialog pointing to the deb and exits. That includes Ubuntu 24.04 and later by default, which restrict them through AppArmor. An AppImage also needs FUSE 2, which Ubuntu 22.04 and later don't install by default (`libfuse2`, or `libfuse2t64` on 24.04).

### Betas

Nothing needs setting up: the first push to `main` that isn't only docs publishes the first beta. **Nobody reviews a beta before it goes out**, as was asked. So anyone who can push to `main`, or whose pull request gets merged, reaches every install on the beta channel within hours (each checks every four), with no signature to stop it. Protect `main`, and treat a merge as a release.

Stable installs never take a beta. A beta build stays on beta by itself unless a policy says otherwise. After a stable release, raise `version` in `package.json`: a beta of the same version sorts below it.

### First stable release

In this order:

1. Try a beta on all three systems.
2. Create the `release` environment with required reviewers (Settings > Environments). It doesn't exist yet and has to be there first. The publish job only waits for it on a stable tag once it does: without it GitHub creates one with no reviewers, and a pushed tag publishes straight to every install.
3. Protect `v*` tags (Settings > Rules), so that only maintainers can push one.
4. Release a webmail with `build:desktop` on a tag. Webmail tags have no `v`. Set `config.webmailTag` in `package.json` to that tag: it says `1.21.0` now, which doesn't exist yet, and a release fails at once until it does.
5. Set `version` in `package.json`, and push the tag `v<version>` on that commit.
6. A reviewer approves the publish job in the run. The release then goes out with its checksums and attestations, from a draft, in one step.

The macOS secrets (`MAC_CERTIFICATE`, `MAC_CERTIFICATE_PASSWORD`, `APPLE_API_KEY_BASE64`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`) are set, so every macOS build, betas included, is signed with the Developer ID and notarized. Without them the app goes out with an ad-hoc signature.

## For administrators

**MSI, per machine.** Installs to Program Files for everyone, writes nothing next to itself, and doesn't update itself. Each user's data stays in their own profile. A newer MSI replaces an older one: the upgrade code in `electron-builder.yml` never changes.

```bat
msiexec /i Bulwark-1.0.0-x64.msi /qn
msiexec /x Bulwark-1.0.0-x64.msi /qn
```

At its first start the app offers itself to each user under their own HKCU: Default apps, mail links, `.eml`, `.ics` and `.vcf`, Open with and Send to. Uninstalling the MSI runs `Bulwark.exe --uninstall-cleanup` as the user who uninstalls, which takes those entries away for that user. Windows Installer can't reach other users' HKCU, so their entries stay and point at the removed exe. To clean them up too, run `"C:\Program Files\Bulwark\Bulwark.exe" --uninstall-cleanup` as each user before you uninstall, for example from a logon script or an Intune script in user context. It opens no window.

The ARM64 MSI is marked x64 inside, because electron-builder's WiX has no arm64, though the files in it are arm64. Windows 11 on ARM should accept it. It hasn't been tried on one.

**NSIS, per user.** `Bulwark-Setup-1.0.0-x64.exe /S` needs no elevation. Uninstalling leaves the user's mail profile in `%APPDATA%\Bulwark` on purpose: delete the folder to remove it too. Under `%LOCALAPPDATA%\Bulwark` it leaves only copies of attachments someone still had open for editing and the folder sync's records, if there are any. Both uninstallers take the app out of Default apps, Open with and Send to.

**The Files drive.** The app only ever removes Files drives that its own profile registered. Earlier versions registered them with ids of the form `Bulwark!<user SID>!<24 hex digits>` (under `HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Explorer\SyncRootManager`), with nothing in them that says which profile they belong to. The app still takes such a drive as its own while the profile's settings name its account. One they don't name, for example after the profile folder was deleted, stays in Explorer's navigation pane, and nothing in the app removes it.

**Policies.** `packaging/bulwark-policies.sample.reg` is a sample to start from, with `AutoUpdate` and `UpdateChannel` set. Import it with `reg import`, or use the ADMX templates. `AutoUpdate=0` stops every request for updates, on any install. Values under `Software\Policies\Bulwark\Desktop` are forced, the same under `\Recommended` are defaults. `AutoUpdate` has no recommended form: nobody can choose it in the app, so there's nothing for it to be a default of.

**winget.** `packaging/winget/` holds the manifest templates. Fill in the version and the hashes from the release's `.sha256` files, then submit them to `microsoft/winget-pkgs`.

**Checking a download.** Each installer has a `.sha256` next to it, and `gh attestation verify <file> --repo bulwarkmail/desktop` shows which workflow built it from which commit.

## Policies

Admins set or force settings through `Software\Policies\Bulwark\Desktop` and its `Recommended` subkey, a macOS profile, or `/etc/bulwark/policies.json`. The schema and the ADMX, ADML and samples come from the webmail (`lib/desktop/policy-schema.ts`, `scripts/generate-desktop-policies.mjs`). `src/shared/policy-schema.ts` is a byte-for-byte copy: `node scripts/generate-desktop-policies.mjs --shell <this repo>` in the webmail refreshes it. `src/main/policy-read.ts` reads them, `src/main/features/policies.ts` keeps them live, and pages read them through the bridge's `policy` member. A page only gets what the webmail reads (`pagePolicySnapshot`), since it can be any server someone chose: not the auth lists or the certificate rules.

A forced value the app can't use fails closed and says so: in the log, in About, and on the error page if nothing is left to start with, such as an `AllowedJmapServers` nobody can read. `OfflineEnabled` is the exception to deleting anything for it: a typo stops keeping mail but leaves what's there.

The installers take the same values: `msiexec /i Bulwark.msi /qn ALLUSERS=1 INSTANCE_URL=https://mail.example.com FORCE_INSTANCE=1 UPDATE_CHANNEL=stable`, or `Bulwark-Setup.exe /S /INSTANCE_URL=https://mail.example.com /FORCE_INSTANCE=1` run as an administrator. Without `FORCE_INSTANCE=1` the values go under `Recommended`.

Limits: these settings stop people from changing them inside the app. The app isn't signed yet, so someone who can write to its folder, or run their own copy, can patch it. Admins who need a hard guarantee also limit what may run, with AppLocker or WDAC, and install per machine with the MSI so standard users can't write to the folder. `AllowedJmapServers` also applies to a Bulwark server the user picks, so list that too.

Which `WipeOfflineData` values were acted on is kept in the user's own profile, since the app has nowhere else to write. Someone who edits that file can skip a wipe they know is coming. This is on purpose: the wipe cleans up a device, and a person who can read their own profile already has the data.

A production build refuses switches that would script the page or move its traffic (`src/main/switch-guard.ts`), with or without a policy, and restarts itself without them. The same goes for the environment Electron, Node and Chromium read before any of its code runs, such as `ELECTRON_DISABLE_SANDBOX` and `NODE_OPTIONS`.

Tests use a stand-in root under `HKCU\Software\BulwarkTest\Policies`, only in a test build (`node build.mjs --test`, which `npm test` does). `scripts/after-pack.cjs` refuses to package one.

## Test

```sh
npm run dist:win          # for test/msi.spec.ts
node scripts/build-update-fixtures.mjs   # for test/updater.spec.ts and test/readonly-install.spec.ts
npm run pack:test         # test/fuses.spec.ts and friends: a package that takes --user-data-dir and Playwright
                          # it never registers itself with Windows (test/pack-registration.spec.ts)
npm run pack:strict       # test/policies-packaged.spec.ts: behaves as production, with its profile compiled in
IT_ENT_PASSWORD=<the test account's password> npm test
```

`test/` drives the real app with Playwright's Electron support, on a real webmail build.

**Start-up and idle check.** `scripts/perf-check.mjs` starts a packed test build (`BULWARK_TEST_PACK=1 node build.mjs --test`, then electron-builder) signed in to a real mail server, ten times cold, and reports the time to the first mail row and the shell's share of it, then leaves one start alone for five minutes and reports memory (PSS), CPU and wake-ups of every process (Linux). `scripts/perf-seed.mjs` fills the Inbox first. `.github/workflows/perf-nightly.yml` runs both every night against the webmail's test Stalwart and fails over the budgets in `test/perf-budgets.json`. Timings only mean something on a quiet machine, so compare a run with earlier runs on the same kind of machine.

`BULWARK_TEST_WEBMAIL=<dir>` runs the tests on another webmail build, made with `fetch-webmail.mjs --out <dir>`. `test/native-windows.spec.ts` and `test/menu-sections.spec.ts` need one from the same branch. `test/native-timing.spec.ts` is for the bench rig only, and `test/native-screenshots.spec.ts` takes pictures from a real, unlocked desktop.

## Licence

AGPL-3.0-only. See `LICENSE`.
