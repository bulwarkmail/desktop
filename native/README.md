# The native helper

What the app can't do from JavaScript: Windows Hello, the OS keystore for S/MIME, the macOS check for forced preferences, the Files drive on Windows (the Cloud Files API), and what main used to start Windows' own tools for (see below). Rust with [napi-rs](https://napi.rs). `npm run build:native` runs cargo and writes `native/dist/<platform>-<arch>/bulwark-native.node`. The binary isn't committed. On Windows it links the C runtime statically and loads its DLLs from System32 only (`native/.cargo/config.toml`). Node-API is stable across Electron versions, so there's no rebuild per Electron version.

Nothing in here can read a private key or hand one out.

## Exports

This is the whole surface. `test/native.spec.ts` fails if the binary exports anything else, or if this list and the binary differ.

<!-- exports -->
- `helloAvailable()`: promise of a boolean. Whether Windows says a Hello prompt can be shown. False elsewhere.
- `helloVerify(reason, hwnd, timeoutMs)`: shows the Hello prompt on a window. Promise of `verified`, `cancelled`, `busy`, `unavailable`, `timeout`, `invalid` or `failed`. A yes or no that gates the UI: it doesn't unlock or wrap a key. The timeout is required, at most 5 minutes.
- `helloKeyCreate(name, data, hwnd, timeoutMs)`: makes a Windows Hello key credential under `name` (replacing one there) and signs `data` with it, behind Hello's prompt. Promise of `{ result, signature?, publicKey? }`, `result` one of `ok`, `cancelled`, `busy`, `unavailable`, `timeout`, `invalid`, `missing`, `failed`. The public key is a DER SubjectPublicKeyInfo.
- `helloKeyOpen(name)`: promise of `ok`, `missing`, `unavailable` or `failed`: whether that key credential is there. Never prompts.
- `helloKeySign(name, data, hwnd, timeoutMs)`: signs `data` with that key credential, behind Hello's prompt. Promise of `{ result, signature? }`, the same words.
- `helloKeyDelete(name)`: promise of `ok`, `missing` or `failed`. Never prompts.
- `helloKeyCancel()`: ends a create or sign that waits for the user. It answers `cancelled` and its prompt is closed.
- `keystoreList()`: promise of the certificates fit for mail that have a private key. Never prompts, and doesn't touch a smart card.
- `keystoreSign(id, digest, scheme, hwnd?)`: signs a digest. RSA PKCS#1 v1.5 and PSS, ECDSA as DER. The page never picks this digest: main takes a CMS message's signed attributes, checks them and hashes them itself (`src/main/keystore-signed-attrs.ts`).
- `keystoreDecrypt(id, data, scheme, hwnd?)`: RSA key transport with OAEP or v1.5. v1.5 answers only with 16, 24 or 32 bytes, OAEP with up to 64.
- `keystoreAgree(id, peerPublicKey, hwnd?)`: ECDH, the raw shared secret.
- `policyIsForced(key)`: macOS, whether a configuration profile forces this preference. False elsewhere.
- `filesDriveRegister(options)`: registers a Files drive sync root with Windows, so Explorer lists it. Promise of its id, `<provider>!<user SID>!<account>`. Registering the same id again updates its name.
- `filesDriveUnregister(id)`: promise. Removes a sync root's registration, not its folder.
- `filesDriveRoots()`: promise of this user's sync roots, every provider's, with their folders.
- `filesDriveConnect(path, callback)`: connects to a registered sync root. Windows' FETCH_DATA and CANCEL_FETCH_DATA reach `callback` on the JS thread. Answers the connection key.
- `filesDriveDisconnect(connection)`: ends a connection.
- `filesDriveTransfer(connection, transferKey, requestKey, offset, data)`: promise. Bytes for a fetch, from a 4 KB aligned offset.
- `filesDriveTransferFailed(connection, transferKey, requestKey, offset, length, reason)`: ends a fetch with an error, so the program that opened the file gets one.
- `filesDrivePlace(parent, entries)`: placeholders in one folder, in sync, nothing fetched. One answer per entry.
- `filesDriveInfo(path)`: what a path under a sync root is: placeholder or not, identity, in sync, on disk, pin. Fetches nothing.
- `filesDriveUpdate(path, change)`: new metadata or identity for a placeholder, marks it in sync, drops its content.
- `filesDriveConvert(path, identity)`: makes a file made here a placeholder with this identity, in sync.
- `filesDriveHydrate(path)`: promise. Fetches all of a file through this process's own connection.
- `filesDriveDehydrate(path)`: drops a file's content from the disk. Refused for a pinned one.
- `filesUsedDriveLetters()`: the drive letters in use, as GetLogicalDrives' mask.
- `filesDriveLetterChanged(letter)`: tells Explorer a drive letter's name or icon changed (`SHChangeNotify`), so This PC shows it without a restart.
- `filesDriveStatusServe(clsid, icon, callback)`: serves the drive's status in Explorer (Windows 11) from this process under `clsid`. False where Windows has no such status. A click on the status line in Explorer calls `callback` with the sync root's id.
- `filesDriveStatusStop()`: stops serving it.
- `filesDriveStatusAttach(id, clsid)`: names the status class in a sync root's registration, where Explorer looks for it. Again after each `filesDriveRegister`.
- `filesDriveStatusSet(id, status)`: what Explorer shows for a sync root: state, short label, a longer line, the storage used and the limit, a notice. Undefined forgets it.
- `filesDriveStatusRead(id, waitMs)`: promise of the status as Explorer reads it, out of process; with `waitMs`, after the next change. For tests and for checking a machine.
- `registryRead(key, depth)`: a key under HKCU or HKLM and up to `depth` levels below it, as `{ path, values, subkeys }` per key. Each value has its `name` (empty for the default), its `kind` (`sz`, `expand_sz` not expanded, `multi_sz`, `dword`, `qword`, `binary`, `none`, `other`) and its data: `text` (a QWORD in decimal), `list` or `number`. Null when the key isn't there; throws `registry:<code>` when it is and can't be read.
- `registrySetString(key, name, data)`: a REG_SZ value, the key made if it isn't there. No name: the default value. Only under `HKCU\Software\<name>`.
- `registryDeleteKey(key)`: a key with everything below it. Only under `HKCU\Software\<name>`. False if it wasn't there.
- `registryDeleteValue(key, name)`: one value, the same way.
- `notificationQuietState()`: promise of `{ profile, notificationState }`: Do Not Disturb's profile (1 priority only, 2 alarms only) and `SHQueryUserNotificationState`. Zeros where Windows doesn't say, and elsewhere.
- `clipboardWriteFiles(paths)`: promise. Puts up to 200 files on the clipboard as Explorer copies them: `CF_HDROP` and `Preferred DropEffect` copy. Rejects with `clipboard:busy` when another program holds the clipboard throughout.
- `folderMakePrivate(path)`: promise. Full control for this user and SYSTEM on a folder and all in it, and nothing inherited from above.
- `driveLetterList()`: the drive letters mapped to a folder in this sign-in session, as `{ letter, target }`, as `subst` lists them.
- `driveLetterAdd(letter, target)`: promise. Maps a free letter to an existing folder, as `subst X: <folder>`.
- `driveLetterRemove(letter)`: promise. Takes a letter's mapping to a folder away, as `subst X: /D`. Refused for anything that isn't a mapped folder.
- `fileSetPin(path, pin)`: promise. The pin attributes, `pinned`, `unpinned` or `unspecified`, as `attrib +P -U`, `-P +U` and `-P -U` set them.
- `windowToFront(hwnd)`: puts one of this process's windows in front, as a click on its toast asks, where SetForegroundWindow alone would only flash its taskbar button: an empty mouse input first makes this process the one with the last input. True when the window is in front. False elsewhere.
- `codeSignatureCheck(path)`: promise of `{ status, code, subject? }`: a file's embedded Authenticode signature through WinVerifyTrust (`valid`, `unsigned` or `invalid`, with Windows' code) and its signer as .NET's X509Certificate.Subject shows it. No revocation check over the network. For an update's installer, where electron-updater would start PowerShell's Get-AuthenticodeSignature.
- `printDialog(hwnd, pdf, landscape?, title)`: Windows' print dialog over a window for a PDF, with the PDF's pages in the dialog's preview and in the job, drawn by Windows' own PDF renderer. `landscape` is the same document laid out for landscape, which the dialog's landscape uses. Opened on the JS thread, which owns the app's windows, as Windows requires. Promise of `printed`, `cancelled`, `failed`, `unavailable` (off Windows, or Windows wouldn't show the dialog) or `invalid` (no window).
<!-- /exports -->

macOS Touch ID needs no helper: Electron has `systemPreferences.promptTouchID`.

## In place of Windows' tools

Endpoint protection (lockdown and "living off the land" rules) blocks or flags an app that starts PowerShell, cmd, reg.exe, icacls and the like, and one such rule kept the installed app from starting. So main starts none of them (`test/no-system-tools-unit.spec.ts`), and the helper does their work in process:

- **The registry** (`registry*`), for Default apps, Open with, the Files drive letter's name, the uninstall cleanup and the policies. Reads take HKCU and HKLM; writes and deletes only `HKCU\Software\<name>`. A read answers the types the way reg.exe showed them: strings up to their first NUL, an EXPAND_SZ not expanded, a DWORD unsigned, a QWORD in decimal text. The policies count a REG_MULTI_SZ, a QWORD past 2^53, binary and a string with a line break as bad values, as they did through reg.exe. A key that's there and can't be read throws, so it never reads as "no policies"; without the helper the policies come through @vscode/policy-watcher, as when reg.exe was blocked.
- **Focus Assist** (`notificationQuietState`): Do Not Disturb's profile from WNF (`NtQueryWnfStateData`, found in ntdll at run time, so a Windows without it answers 0) and `SHQueryUserNotificationState`.
- **Files on the clipboard** (`clipboardWriteFiles`): `CF_HDROP` with wide paths and `Preferred DropEffect` copy, from a message-only window of its own on a pool thread, gone again once the data is set. Ten tries 30 ms apart while another program holds the clipboard.
- **A private folder** (`folderMakePrivate`): `SetNamedSecurityInfoW` with a protected DACL, full control inherited by folders and files for the user from the process token and for SYSTEM.
- **Drive letters** (`driveLetter*`): `QueryDosDeviceW` and `DefineDosDeviceW`, as subst. Only a mapping to a folder (`\??\...`) is listed or removed, by its exact target.
- **Pins** (`fileSetPin`): `FILE_ATTRIBUTE_PINNED` and `UNPINNED` with `SetFileAttributesW`, off the JS thread, since a pin can make the drive's fetch callbacks come.
- **An update's signature** (`codeSignatureCheck`): `WinVerifyTrust` and the signer's subject; main applies electron-updater's publisherName rule to it (`src/main/update-rules.ts`).

Without the helper each caller answers what it did when the tool failed: no registration, no letter, toasts shown, the folder private only under the home folder, the installer unchecked as when PowerShell couldn't run. These link `user32.dll`, `shell32.dll` and `wintrust.dll` from System32.

## The Files drive

Windows only: macOS and Linux have the same exports, which answer `files:unsupported` (`roots` an empty list). Main decides what goes in a drive (`src/main/files/drive-controller.ts`) and checks every path against its root before it gets here; these check lengths, absolute paths and names without separators again.

**Registration** goes through `StorageProviderSyncRootManager.Register`, so Explorer shows the drive in its navigation pane. Full hydration: a program that opens a file gets it whole, never the first bytes of one whose fetch then failed. Population is always full, since the page places every placeholder itself. Changing a file's last write time or its read-only, hidden or system attribute takes it out of sync. Pinning is allowed, which gives Explorer "Always keep on this device" and "Free up space". Listing reads the registry key Windows keeps the registrations in, because `GetCurrentSyncRoots` only lists a packaged app's own.

**Callbacks** come on Windows' threads and go to JS through a threadsafe function, without waiting. With nobody listening the fetch fails at once. Main's own reads never fetch (`CF_CONNECT_FLAG_BLOCK_SELF_IMPLICIT_HYDRATION`): only `filesDriveHydrate` does, on libuv's pool, since the JS thread has to answer the callback it causes.

**Errors** are in the message: `files:<code> (0x<hresult>)` with `missing`, `exists`, `busy`, `denied`, `name`, `full`, `changed`, `pinned`, `not-placeholder`, `outside`, `cancelled`, `unsupported`, `timeout`, `failed`, and `files:invalid (<what>)` for an argument main never sends. `src/main/files/drive-places.ts` turns them into the bridge's errors.

**Status in Explorer** (Windows 11 22H2 and later): the storage used of the account's limit and whether the drive is up to date, where OneDrive shows its own. Explorer reads a CLSID from the sync root's `StorageProviderStatusUISourceFactory` value and creates that class out of process. `filesDriveStatusServe` registers its class object with `CoRegisterClassObject` on a thread of its own in the multithreaded apartment; COM finds it without any CLSID in the registry, so nothing is left to clean up but that value, which goes with the sync root. With the app closed nobody answers and Explorer shows no status, which is true then. The words come from the page, in its language. The bar keeps Windows' colour: an `IReference<Color>` for `QuotaUsedColor` can't leave the process (Windows has no proxy for it), so nearly full is a notice line instead. On Windows without the status classes `filesDriveStatusServe` answers false and the rest of the drive works as before.

It links `cldapi.dll` and `shell32.dll` from System32. `scripts/files-drive-cleanup.mjs` removes the test sync roots a crashed test run leaves behind.

## Hello

Cancelling the WinRT operation doesn't close the Windows Security dialog, which stays up asking for a PIN. So on a timeout the helper posts a close message to a new dialog of class `Credential Dialog Xaml Host` owned by our window, or, with no owner, only to the one new dialog seen in the first seconds after asking. Another window's is never touched. The flag below logs which case applied. The class name isn't documented: if Windows renames it, a timed-out prompt stays open until the user closes it. `BULWARK_TEST_HELLO_PROMPT=1` runs the one test that shows a real prompt, for a few seconds.

**Key credentials** (`helloKey*`, for the app lock) go through `KeyCredentialManager`. The private key stays in the user's Hello container, in the TPM where there is one, and each use takes a Hello prompt. Main signs a fixed challenge and derives a key from the signature, so this only works because Windows signs with RSA PKCS#1 v1.5 and SHA-256, which gives the same signature for the same data every time. Main checks each new key's signature against its public key as PKCS#1 v1.5 before relying on it, and refuses the key otherwise. These calls take no owner window: Windows has no interop for them. So the window handle is checked to be a window, and the new dialog seen alone in the first seconds is brought to the front and closed on a timeout or `helloKeyCancel()`, as above. Names are letters, digits, spaces, `.`, `_` and `-`, at most 64 characters. With `BULWARK_TEST_HELLO_PROMPT=1`, `test/native.spec.ts` also makes a test key credential, signs with it twice, checks both signatures are the same and verify as PKCS#1 v1.5, and deletes it: four or five prompts.

## The keystore

**Consent isn't here.** The helper does what it's told. Who may ask is decided in main, in `src/main/keystore-consent.ts`, by origin, certificate and class of use, with a native dialog. Signing asks every time. A yes for unwrapping holds until 15 minutes pass without a use, the screen or the app locks, or the account changes. The plugin host's checks in the webmail are no boundary: a privileged plugin's frame is same-origin and reaches the bridge through `parent`.

**Which certificates.** Windows `CurrentUser\My`, including smart cards through their minidriver. macOS keychains and tokens. Only those fit for mail: with an extended key usage it has to name email protection or any use, and with a key usage it has to allow signing, key encipherment or key agreement. A CA is out, by `cA=true`, `keyCertSign` or `cRLSign`, whatever else it allows. A sign-in-only, code signing or CA key in the same store has no id, and can't be used. A key asks at each use unless its extended key usage is exactly email protection and it has no `nonRepudiation`, the mark of a qualified signing key: anything broader could also sign code or sign the user in. Names lose control and invisible characters, since the consent dialog shows them.

**Ids.** The SHA-256 of the certificate. Every call checks the id against the last `keystoreList()`.

**What's checked before the OS sees it.** Id format, digest length for the hash, scheme against key type, key usage against the operation, ciphertext length against the modulus, label size, and the peer key's curve, form and that its point is on the curve, here as well as in main, so nothing rests on a third-party provider. SHA-1 signatures are refused, and SHA-1 stays for OAEP, where old mail needs it.

**Errors** are in the message: `keystore:cancelled`, `keystore:not-found`, `keystore:unsupported`, `keystore:locked`, `keystore:invalid`, `keystore:failed`. Every decryption failure, a bad padding or an answer of the wrong size, reads the same, so the key can't be used as an oracle.

**Windows** goes through CNG. Listing opens only Microsoft's named software providers, with the silent flag, to skip certificates whose key is gone. Anything else may be a token and stays untouched. Sign, decrypt and agree call `CryptAcquireCertificatePrivateKey` with silent off, so the OS's prompts and a card's PIN dialog show as usual. A key behind an old CSP that has no CNG provider answers `keystore:unsupported`. A card's provider may not support OAEP or importing a peer's public key, which is the same answer.

**macOS** goes through `SecKey`. There's no OAEP label there: `keystore:unsupported`.

**Linux** has no keystore in scope. The exports are there and report nothing.

## Build

```sh
npm run build:native                        # this machine
node scripts/build-native.mjs --arch arm64  # needs the Rust target and the MSVC ARM64 libraries
cd native && cargo test                     # the DER reader and the input checks
```

The macOS and Linux code type-checks from any machine:

```sh
rustup target add aarch64-apple-darwin x86_64-unknown-linux-gnu
cd native && cargo check --target aarch64-apple-darwin && cargo check --target x86_64-unknown-linux-gnu
```

Crates: `napi`, `napi-derive`, `napi-build`, `windows` with `windows-core`, `windows-future` and the `windows-collections` it brings, and on macOS `security-framework` with the `security-framework-sys`, `core-foundation` and `core-foundation-sys` it's built on.
