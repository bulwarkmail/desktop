//! The Bulwark desktop app's native helper. Everything exported is in this file and
//! listed in README.md. test/native.spec.ts fails if an export appears that isn't.
//!
//! Key operations run on libuv's pool, since an OS prompt can take a while. The JS
//! wrapper (src/main/native-loader.ts) runs them one at a time, so a PIN dialog holds
//! one pool thread and no more.

// Each OS uses a different part: CNG needs the ECDSA conversion, Linux none of it.
#[cfg_attr(not(windows), allow(dead_code))]
mod der;
#[cfg_attr(not(any(windows, target_os = "macos")), allow(dead_code))]
mod keystore;

#[cfg_attr(windows, path = "windows_os.rs")]
#[cfg_attr(target_os = "macos", path = "macos.rs")]
#[cfg_attr(not(any(windows, target_os = "macos")), path = "no_os.rs")]
mod os;

#[cfg_attr(windows, path = "files_windows.rs")]
#[cfg_attr(not(windows), path = "files_none.rs")]
mod files;

#[cfg_attr(windows, path = "files_status_windows.rs")]
#[cfg_attr(not(windows), path = "files_status_none.rs")]
mod files_status;

#[cfg_attr(windows, path = "print_windows.rs")]
#[cfg_attr(not(windows), path = "print_none.rs")]
mod print;

#[cfg_attr(windows, path = "system_windows.rs")]
#[cfg_attr(not(windows), path = "system_none.rs")]
mod system;

use std::time::Duration;

use napi::bindgen_prelude::{AsyncTask, Buffer, ToNapiValue, TypeName, Unknown};
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi::{Env, Error, Result, Status, Task};
use napi_derive::napi;

use keystore::{DecryptPlan, KeystoreError, Listed, PeerKey, SignPlan};

const MAX_REASON: usize = 256;
const MAX_HELLO_TIMEOUT_MS: u32 = 5 * 60_000;
const MAX_POLICY_KEY: usize = 128;

fn thrown(error: KeystoreError) -> Error {
    Error::from_reason(error.to_string())
}

// ─── Hello ───────────────────────────────────────────────────

pub struct HelloAvailableTask;

impl Task for HelloAvailableTask {
    type Output = bool;
    type JsValue = bool;

    fn compute(&mut self) -> Result<bool> {
        Ok(os::hello_available())
    }

    fn resolve(&mut self, _env: Env, output: bool) -> Result<bool> {
        Ok(output)
    }
}

/// Whether Windows says a Hello prompt can be shown. False on other systems.
#[napi]
pub fn hello_available() -> AsyncTask<HelloAvailableTask> {
    AsyncTask::new(HelloAvailableTask)
}

pub struct HelloVerifyTask {
    reason: String,
    hwnd: Vec<u8>,
    timeout: Duration,
}

impl Task for HelloVerifyTask {
    type Output = &'static str;
    type JsValue = String;

    fn compute(&mut self) -> Result<&'static str> {
        Ok(os::hello_verify(&self.reason, &self.hwnd, self.timeout))
    }

    fn resolve(&mut self, _env: Env, output: &'static str) -> Result<String> {
        Ok(output.to_string())
    }
}

/// Shows the Hello prompt on a window, and answers `verified`, `cancelled`, `busy`,
/// `unavailable`, `timeout`, `invalid` or `failed`. Unlocks nothing by itself. A
/// timeout is required, so no caller can leave a prompt waiting for ever.
#[napi]
pub fn hello_verify(reason: String, hwnd: Buffer, timeout_ms: u32) -> Result<AsyncTask<HelloVerifyTask>> {
    if reason.is_empty() || reason.chars().count() > MAX_REASON {
        return Err(Error::from_reason("hello: reason must be 1 to 256 characters"));
    }
    if timeout_ms == 0 || timeout_ms > MAX_HELLO_TIMEOUT_MS {
        return Err(Error::from_reason("hello: timeout out of range"));
    }
    Ok(AsyncTask::new(HelloVerifyTask { reason, hwnd: hwnd.to_vec(), timeout: Duration::from_millis(timeout_ms as u64) }))
}

// ─── Hello key credentials ───────────────────────────────────
//
// A key pair in the user's Windows Hello container (KeyCredentialManager). Using the
// private key takes a Hello prompt each time, and it never leaves Windows. Main signs a
// fixed challenge with it and derives the app lock's key from the signature, so a yes
// alone opens nothing.

const MAX_HELLO_KEY_NAME: usize = 64;
const MAX_HELLO_KEY_DATA: usize = 1024;

/// What a create or sign gave. `result` is one word: `ok`, `cancelled`, `busy`,
/// `unavailable`, `timeout`, `invalid`, `missing` or `failed`.
pub struct HelloKeyOutcome {
    pub result: &'static str,
    pub signature: Option<Vec<u8>>,
    pub public_key: Option<Vec<u8>>,
}

impl HelloKeyOutcome {
    pub fn word(result: &'static str) -> Self {
        HelloKeyOutcome { result, signature: None, public_key: None }
    }
}

#[napi(object)]
pub struct HelloKeyAnswer {
    pub result: String,
    pub signature: Option<Buffer>,
    /// From a create only: the key's public half, a DER SubjectPublicKeyInfo.
    pub public_key: Option<Buffer>,
}

type HelloKeyJob = Box<dyn FnOnce() -> HelloKeyOutcome + Send>;

pub struct HelloKeyTask {
    run: Option<HelloKeyJob>,
}

impl Task for HelloKeyTask {
    type Output = HelloKeyOutcome;
    type JsValue = HelloKeyAnswer;

    fn compute(&mut self) -> Result<HelloKeyOutcome> {
        Ok(self.run.take().map_or(HelloKeyOutcome::word("failed"), |run| run()))
    }

    fn resolve(&mut self, _env: Env, output: HelloKeyOutcome) -> Result<HelloKeyAnswer> {
        Ok(HelloKeyAnswer {
            result: output.result.to_string(),
            signature: output.signature.map(Buffer::from),
            public_key: output.public_key.map(Buffer::from),
        })
    }
}

type HelloKeyWordJob = Box<dyn FnOnce() -> &'static str + Send>;

pub struct HelloKeyWordTask {
    run: Option<HelloKeyWordJob>,
}

impl Task for HelloKeyWordTask {
    type Output = &'static str;
    type JsValue = String;

    fn compute(&mut self) -> Result<&'static str> {
        Ok(self.run.take().map_or("failed", |run| run()))
    }

    fn resolve(&mut self, _env: Env, output: &'static str) -> Result<String> {
        Ok(output.to_string())
    }
}

/// Letters, digits, spaces, `-`, `_` and `.`: the name shows nowhere, and it can't reach
/// another app's credential by a trick of spelling.
fn checked_key_name(name: &str) -> Result<()> {
    if name.is_empty() || name.len() > MAX_HELLO_KEY_NAME || !name.bytes().all(|byte| byte.is_ascii_alphanumeric() || b" ._-".contains(&byte)) {
        return Err(Error::from_reason("hello: bad key name"));
    }
    Ok(())
}

fn checked_key_data(data: &[u8]) -> Result<()> {
    if data.is_empty() || data.len() > MAX_HELLO_KEY_DATA {
        return Err(Error::from_reason("hello: data must be 1 to 1024 bytes"));
    }
    Ok(())
}

fn checked_timeout(timeout_ms: u32) -> Result<Duration> {
    if timeout_ms == 0 || timeout_ms > MAX_HELLO_TIMEOUT_MS {
        return Err(Error::from_reason("hello: timeout out of range"));
    }
    Ok(Duration::from_millis(timeout_ms as u64))
}

/// Makes a new key credential under this name, replacing one there, and signs `data` with
/// it: one Hello prompt, or two where Windows asks again to sign. The signature is RSA
/// PKCS#1 v1.5 with SHA-256 over `data`. Main checks that against the public key it gets
/// here before relying on it.
#[napi]
pub fn hello_key_create(name: String, data: Buffer, hwnd: Buffer, timeout_ms: u32) -> Result<AsyncTask<HelloKeyTask>> {
    checked_key_name(&name)?;
    checked_key_data(&data)?;
    let timeout = checked_timeout(timeout_ms)?;
    let (data, hwnd) = (data.to_vec(), hwnd.to_vec());
    Ok(AsyncTask::new(HelloKeyTask { run: Some(Box::new(move || os::hello_key_create(&name, &data, &hwnd, timeout))) }))
}

/// Whether a key credential of this name is there: `ok`, `missing`, `unavailable` or
/// `failed`. Never prompts.
#[napi]
pub fn hello_key_open(name: String) -> Result<AsyncTask<HelloKeyWordTask>> {
    checked_key_name(&name)?;
    Ok(AsyncTask::new(HelloKeyWordTask { run: Some(Box::new(move || os::hello_key_open(&name))) }))
}

/// Signs `data` with the named key credential, behind a Hello prompt on a window.
#[napi]
pub fn hello_key_sign(name: String, data: Buffer, hwnd: Buffer, timeout_ms: u32) -> Result<AsyncTask<HelloKeyTask>> {
    checked_key_name(&name)?;
    checked_key_data(&data)?;
    let timeout = checked_timeout(timeout_ms)?;
    let (data, hwnd) = (data.to_vec(), hwnd.to_vec());
    Ok(AsyncTask::new(HelloKeyTask { run: Some(Box::new(move || os::hello_key_sign(&name, &data, &hwnd, timeout))) }))
}

/// Deletes the named key credential: `ok`, `missing` or `failed`. Never prompts.
#[napi]
pub fn hello_key_delete(name: String) -> Result<AsyncTask<HelloKeyWordTask>> {
    checked_key_name(&name)?;
    Ok(AsyncTask::new(HelloKeyWordTask { run: Some(Box::new(move || os::hello_key_delete(&name))) }))
}

/// Ends a create or sign that is waiting for the user: it answers `cancelled`, and its
/// prompt is closed as on a timeout. Nothing waiting: nothing happens.
#[napi]
pub fn hello_key_cancel() {
    os::hello_key_cancel();
}

// ─── Keystore ────────────────────────────────────────────────

#[napi(object)]
pub struct KeystoreCertificate {
    /// SHA-256 of the certificate, lowercase hex.
    pub id: String,
    /// DER.
    pub certificate: Buffer,
    /// Intermediates, DER, without leaf and root. May be empty.
    pub chain: Vec<Buffer>,
    pub subject: String,
    pub issuer: String,
    /// Hex of the serial's bytes.
    pub serial: String,
    /// Milliseconds since 1970.
    pub not_before: f64,
    pub not_after: f64,
    /// keyUsage names. Empty if the certificate has no such extension.
    pub usages: Vec<String>,
    /// extendedKeyUsage OIDs. Empty if the certificate has no such extension.
    pub extended_usages: Vec<String>,
    /// The key's algorithm OID.
    pub algorithm: String,
    /// `rsa` or `ec`.
    pub key_type: String,
    pub curve: Option<String>,
    pub key_bits: u32,
    /// `software`, `smartcard`, `keychain` or `unknown`. A hint for the UI.
    pub source: String,
    pub sign_schemes: Vec<String>,
    pub decrypt_schemes: Vec<String>,
    pub can_agree: bool,
    /// The key can also sign the user in somewhere: consent per use, not per session.
    pub ask_each_use: bool,
}

fn to_js(listed: Listed) -> KeystoreCertificate {
    let (key_type, curve, key_bits) = match listed.certificate.key {
        der::KeyKind::Rsa { bits, .. } => ("rsa", None, bits),
        der::KeyKind::Ec { curve } => ("ec", Some(curve.name().to_string()), curve.bits()),
    };
    let usages = listed.certificate.usage_names();
    KeystoreCertificate {
        id: listed.found.id,
        certificate: listed.found.der.into(),
        chain: listed.found.chain.into_iter().map(Buffer::from).collect(),
        subject: listed.certificate.subject,
        issuer: listed.certificate.issuer,
        serial: listed.certificate.serial,
        not_before: listed.certificate.not_before,
        not_after: listed.certificate.not_after,
        usages,
        extended_usages: listed.certificate.extended_key_usage.unwrap_or_default(),
        algorithm: listed.certificate.algorithm,
        key_type: key_type.to_string(),
        curve,
        key_bits,
        source: listed.found.source.to_string(),
        sign_schemes: listed.sign_schemes,
        decrypt_schemes: listed.decrypt_schemes,
        can_agree: listed.can_agree,
        ask_each_use: listed.ask_each_use,
    }
}

pub struct ListTask;

impl Task for ListTask {
    type Output = Vec<Listed>;
    type JsValue = Vec<KeystoreCertificate>;

    fn compute(&mut self) -> Result<Vec<Listed>> {
        Ok(keystore::remember(os::enumerate(keystore::wanted).map_err(thrown)?))
    }

    fn resolve(&mut self, _env: Env, output: Vec<Listed>) -> Result<Vec<KeystoreCertificate>> {
        Ok(output.into_iter().map(to_js).collect())
    }
}

/// Certificates fit for mail that have a private key. Never prompts, and doesn't touch
/// a smart card. The ids it returns are the only ones the calls below accept.
#[napi]
pub fn keystore_list() -> AsyncTask<ListTask> {
    AsyncTask::new(ListTask)
}

type BytesJob = Box<dyn FnOnce() -> std::result::Result<Vec<u8>, KeystoreError> + Send>;

/// Runs off the JS thread and hands back bytes.
pub struct BytesTask {
    run: Option<BytesJob>,
}

impl Task for BytesTask {
    type Output = Vec<u8>;
    type JsValue = Buffer;

    fn compute(&mut self) -> Result<Vec<u8>> {
        match self.run.take() {
            Some(run) => run().map_err(thrown),
            None => Err(thrown(KeystoreError::Failed("ran twice".into()))),
        }
    }

    fn resolve(&mut self, _env: Env, output: Vec<u8>) -> Result<Buffer> {
        Ok(output.into())
    }
}

fn bytes_task(run: impl FnOnce() -> std::result::Result<Vec<u8>, KeystoreError> + Send + 'static) -> AsyncTask<BytesTask> {
    AsyncTask::new(BytesTask { run: Some(Box::new(run)) })
}

#[napi(object)]
pub struct SignScheme {
    /// `rsa-pkcs1`, `rsa-pss` (MGF1 with the same hash, salt as long as the hash) or
    /// `ecdsa`.
    pub scheme: String,
    /// `SHA-256`, `SHA-384` or `SHA-512`.
    pub hash: String,
}

/// Signs a digest, not data. RSA gives the raw signature, ECDSA a DER ECDSA-Sig-Value.
#[napi]
pub fn keystore_sign(id: String, digest: Buffer, scheme: SignScheme, hwnd: Option<Buffer>) -> Result<AsyncTask<BytesTask>> {
    let facts = keystore::known(&id).map_err(thrown)?;
    let digest = digest.to_vec();
    let plan: SignPlan = keystore::check_sign(&facts, &digest, &scheme.scheme, &scheme.hash).map_err(thrown)?;
    let hwnd = hwnd.map(|window| window.to_vec());
    Ok(bytes_task(move || os::sign(&id, &digest, plan, hwnd.as_deref())))
}

#[napi(object)]
pub struct DecryptScheme {
    /// `rsa-pkcs1` or `rsa-oaep`.
    pub scheme: String,
    /// For OAEP, with MGF1 on the same hash: `SHA-1`, `SHA-256`, `SHA-384`, `SHA-512`.
    pub hash: Option<String>,
    /// For OAEP.
    pub label: Option<Buffer>,
}

/// Unwraps a CMS content key with RSA. v1.5 answers only with 16, 24 or 32 bytes, OAEP
/// with up to 64, and every failure reads the same.
#[napi]
pub fn keystore_decrypt(id: String, data: Buffer, scheme: DecryptScheme, hwnd: Option<Buffer>) -> Result<AsyncTask<BytesTask>> {
    let facts = keystore::known(&id).map_err(thrown)?;
    let data = data.to_vec();
    let label = scheme.label.as_ref().map(|label| label.to_vec());
    let plan: DecryptPlan =
        keystore::check_decrypt(&facts, &data, &scheme.scheme, scheme.hash.as_deref(), label.as_deref()).map_err(thrown)?;
    let hwnd = hwnd.map(|window| window.to_vec());
    Ok(bytes_task(move || keystore::check_decrypted(os::decrypt(&id, &data, &plan, hwnd.as_deref()), &plan)))
}

/// ECDH: the raw shared secret Z, big-endian, as long as the curve's field, like
/// WebCrypto's deriveBits. The peer's key is an EC SubjectPublicKeyInfo on our curve.
#[napi]
pub fn keystore_agree(id: String, peer_public_key: Buffer, hwnd: Option<Buffer>) -> Result<AsyncTask<BytesTask>> {
    let facts = keystore::known(&id).map_err(thrown)?;
    let peer: PeerKey = keystore::check_agree(&facts, &peer_public_key).map_err(thrown)?;
    let hwnd = hwnd.map(|window| window.to_vec());
    Ok(bytes_task(move || os::agree(&id, &peer, hwnd.as_deref())))
}

// ─── Forced policy ───────────────────────────────────────────

/// macOS: whether a configuration profile forces this preference. False elsewhere.
#[napi]
pub fn policy_is_forced(key: String) -> Result<bool> {
    if key.is_empty() || key.len() > MAX_POLICY_KEY || !key.bytes().all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte)) {
        return Err(Error::from_reason("policy: bad key"));
    }
    Ok(os::policy_is_forced(&key))
}

// ─── Windows' print dialog ───────────────────────────────────

const MAX_PRINT_PDF: usize = 200 * 1024 * 1024;
const MAX_PRINT_TITLE: usize = 256;

pub struct PrintDialogTask {
    dialog: Option<print::Dialog>,
    refused: &'static str,
}

impl Task for PrintDialogTask {
    type Output = &'static str;
    type JsValue = String;

    fn compute(&mut self) -> Result<&'static str> {
        Ok(self.dialog.as_ref().map_or(self.refused, print::Dialog::wait))
    }

    fn resolve(&mut self, _env: Env, output: &'static str) -> Result<String> {
        // Back on the JS thread, the window's: the dialog's registration goes here.
        if let Some(dialog) = self.dialog.take() {
            dialog.close();
        }
        Ok(output.to_string())
    }
}

/// Windows' print dialog over a window, for a PDF, with its pages in the dialog's preview.
/// `landscape`: the same document laid out for landscape, used when the dialog picks it.
/// Opened right here, on the JS thread, which owns the app's windows: Windows wants that.
/// Resolves when the dialog is closed and a job is with the spooler: `printed`, `cancelled`,
/// `failed`, `unavailable` (no dialog: off Windows, or Windows wouldn't show one) or `invalid`.
#[napi]
pub fn print_dialog(hwnd: Buffer, pdf: Buffer, landscape: Option<Buffer>, title: String) -> Result<AsyncTask<PrintDialogTask>> {
    for data in std::iter::once(&pdf).chain(landscape.as_ref()) {
        if data.len() < 5 || data.len() > MAX_PRINT_PDF {
            return Err(Error::from_reason("print: a PDF must be 5 bytes to 200 MB"));
        }
    }
    let title: String = title.chars().take(MAX_PRINT_TITLE).collect();
    Ok(AsyncTask::new(match print::show(&hwnd, pdf.to_vec(), landscape.map(|data| data.to_vec()), title) {
        Ok(dialog) => PrintDialogTask { dialog: Some(dialog), refused: "" },
        Err(word) => PrintDialogTask { dialog: None, refused: word },
    }))
}

// ─── Window to the front ─────────────────────────────────────

/// Windows: puts this process's window in front, as a click on its toast asks. True when it
/// is. False elsewhere.
#[napi]
pub fn window_to_front(hwnd: Buffer) -> bool {
    os::window_to_front(&hwnd)
}

// ─── Files drive (Windows Cloud Files) ───────────────────────
//
// Main decides what to place and fetch, and checks every path against its root first. These
// check what they're given anyway: lengths, absolute paths, names without separators.

const MAX_PATH_CHARS: usize = 32_767;
const MAX_NAME_CHARS: usize = 255;
const MAX_IDENTITY_BYTES: usize = 4096;
const MAX_TRANSFER_BYTES: usize = 64 * 1024 * 1024;
const MAX_PLACE_BATCH: usize = 4096;
/// The largest integer a JS number holds exactly.
const MAX_SAFE: f64 = 9_007_199_254_740_991.0;

fn files_error(message: String) -> Error {
    Error::from_reason(message)
}

fn invalid(what: &str) -> Error {
    Error::from_reason(format!("files:invalid ({what})"))
}

fn checked_path(path: &str) -> Result<&str> {
    let bytes = path.as_bytes();
    let drive = bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && bytes[2] == b'\\';
    if !drive || path.chars().count() > MAX_PATH_CHARS || path.contains('\0') || path.contains('/') {
        return Err(invalid("path"));
    }
    Ok(path)
}

fn checked_name(name: &str) -> Result<&str> {
    if name.is_empty() || name.chars().count() > MAX_NAME_CHARS || name == "." || name == ".." || name.chars().any(|c| c == '\\' || c == '/' || c == '\0') {
        return Err(invalid("name"));
    }
    Ok(name)
}

fn checked_identity(identity: &str) -> Result<&str> {
    if identity.is_empty() || identity.len() > MAX_IDENTITY_BYTES {
        return Err(invalid("identity"));
    }
    Ok(identity)
}

fn checked_count(value: f64, what: &str) -> Result<i64> {
    if !value.is_finite() || !(0.0..=MAX_SAFE).contains(&value) || value.fract() != 0.0 {
        return Err(invalid(what));
    }
    Ok(value as i64)
}

fn checked_key(key: &str) -> Result<i64> {
    key.parse::<i64>().map_err(|_| invalid("key"))
}

fn checked_label(value: &str, max: usize, what: &str, allowed: impl Fn(char) -> bool) -> Result<()> {
    if value.is_empty() || value.chars().count() > max || !value.chars().all(allowed) {
        return Err(invalid(what));
    }
    Ok(())
}

type FilesJobRun<T> = Box<dyn FnOnce() -> std::result::Result<T, String> + Send>;

/// A files call off the JS thread.
pub struct FilesJob<T: Send + 'static> {
    run: Option<FilesJobRun<T>>,
}

impl<T: Send + ToNapiValue + TypeName + 'static> Task for FilesJob<T> {
    type Output = T;
    type JsValue = T;

    fn compute(&mut self) -> Result<T> {
        match self.run.take() {
            Some(run) => run().map_err(files_error),
            None => Err(Error::from_reason("files:failed (ran twice)")),
        }
    }

    fn resolve(&mut self, _env: Env, output: T) -> Result<T> {
        Ok(output)
    }
}

fn files_job<T: Send + ToNapiValue + TypeName + 'static>(run: impl FnOnce() -> std::result::Result<T, String> + Send + 'static) -> AsyncTask<FilesJob<T>> {
    AsyncTask::new(FilesJob { run: Some(Box::new(run)) })
}

#[napi(object)]
pub struct FilesRegistration {
    /// The provider part of the id: `Bulwark`, or `Bulwark Test <pid>` in tests.
    pub provider: String,
    /// The account part of the id: a hash main makes, never an address.
    pub account: String,
    /// The folder, absolute. It must exist.
    pub path: String,
    pub display_name: String,
    /// `<file>,<index>` as Explorer reads icons.
    pub icon: String,
    pub version: String,
}

#[napi(object)]
pub struct FilesSyncRoot {
    pub id: String,
    pub path: String,
    pub display_name: String,
    /// `<file>,<index>`, as it was registered.
    pub icon: String,
}

#[napi(object)]
pub struct FilesFetchEvent {
    /// `fetch` or `cancel`.
    pub kind: String,
    pub connection: String,
    pub transfer_key: String,
    pub request_key: String,
    /// The file's absolute path.
    pub path: String,
    pub identity: String,
    pub offset: f64,
    pub length: f64,
    pub total: f64,
    /// The process that opened it, 0 if Windows didn't say.
    pub pid: u32,
}

#[napi(object)]
pub struct FilesPlacement {
    /// One name, no separators: placed in the parent the call names.
    pub name: String,
    pub directory: bool,
    pub size: f64,
    pub mtime_ms: f64,
    pub identity: String,
}

#[napi(object)]
pub struct FilesPlaceholderInfo {
    pub placeholder: bool,
    pub directory: bool,
    pub identity: Option<String>,
    pub in_sync: bool,
    /// All of its content is on disk.
    pub hydrated: bool,
    /// Some of it is.
    pub partial: bool,
    /// `pinned`, `unpinned` or `unspecified`.
    pub pin: String,
    pub size: f64,
    pub on_disk: f64,
}

#[napi(object)]
pub struct FilesUpdate {
    pub size: Option<f64>,
    pub mtime_ms: Option<f64>,
    pub identity: Option<String>,
    pub mark_in_sync: bool,
    pub dehydrate: bool,
    /// Refuse (`files:changed`) if it isn't in sync now: someone changed it here.
    pub verify_in_sync: bool,
}

/// Registers a sync root with Windows, so Explorer shows it. Answers its id,
/// `<provider>!<user SID>!<account>`. Registering an id again updates it.
#[napi]
pub fn files_drive_register(options: FilesRegistration) -> Result<AsyncTask<FilesJob<String>>> {
    checked_label(&options.provider, 64, "provider", |c| c.is_ascii_alphanumeric() || " ._-".contains(c))?;
    checked_label(&options.account, 64, "account", |c| c.is_ascii_alphanumeric() || "_-".contains(c))?;
    checked_label(&options.display_name, 256, "display name", |c| !c.is_control())?;
    checked_label(&options.icon, 1024, "icon", |c| !c.is_control())?;
    checked_label(&options.version, 64, "version", |c| c.is_ascii_alphanumeric() || ".-+".contains(c))?;
    checked_path(&options.path)?;
    Ok(files_job(move || files::register(&options)))
}

#[napi]
pub fn files_drive_unregister(id: String) -> Result<AsyncTask<FilesJob<()>>> {
    checked_label(&id, 512, "id", |c| !c.is_control())?;
    Ok(files_job(move || files::unregister(&id)))
}

/// This user's sync roots, every provider's: main and the cleanup pick theirs by id.
#[napi]
pub fn files_drive_roots() -> AsyncTask<FilesJob<Vec<FilesSyncRoot>>> {
    files_job(files::roots)
}

type FetchCallback = ThreadsafeFunction<FilesFetchEvent, Unknown<'static>, FilesFetchEvent, Status, false, true>;

/// Connects to a registered sync root. Windows' FETCH_DATA and CANCEL_FETCH_DATA come to
/// `callback`, on the JS thread. Answers the connection key.
#[napi]
pub fn files_drive_connect(path: String, callback: FetchCallback) -> Result<String> {
    checked_path(&path)?;
    let sink: files::Sink = Box::new(move |event| callback.call(event, ThreadsafeFunctionCallMode::NonBlocking) == Status::Ok);
    files::connect(&path, sink).map_err(files_error)
}

#[napi]
pub fn files_drive_disconnect(connection: String) -> Result<()> {
    files::disconnect(checked_key(&connection)?).map_err(files_error)
}

/// Bytes for a fetch: from a 4 KB aligned offset, a multiple of 4 KB long unless they end
/// the file.
#[napi]
pub fn files_drive_transfer(connection: String, transfer_key: String, request_key: String, offset: f64, data: Buffer) -> Result<AsyncTask<FilesJob<()>>> {
    let (connection, transfer_key, request_key) = (checked_key(&connection)?, checked_key(&transfer_key)?, checked_key(&request_key)?);
    let offset = checked_count(offset, "offset")?;
    if offset % 4096 != 0 || data.is_empty() || data.len() > MAX_TRANSFER_BYTES {
        return Err(invalid("transfer"));
    }
    let data = data.to_vec();
    Ok(files_job(move || files::transfer(connection, transfer_key, request_key, offset, &data)))
}

/// Ends a fetch with an error: `offline`, `denied`, `timeout`, `not-running` or `failed`.
#[napi]
pub fn files_drive_transfer_failed(connection: String, transfer_key: String, request_key: String, offset: f64, length: f64, reason: String) -> Result<()> {
    let (connection, transfer_key, request_key) = (checked_key(&connection)?, checked_key(&transfer_key)?, checked_key(&request_key)?);
    let (offset, length) = (checked_count(offset, "offset")?, checked_count(length, "length")?);
    if !["offline", "denied", "timeout", "not-running", "failed"].contains(&reason.as_str()) {
        return Err(invalid("reason"));
    }
    files::transfer_failed(connection, transfer_key, request_key, offset, length, &reason).map_err(files_error)
}

/// Placeholders in one folder, in sync, with nothing fetched. One answer per entry: `""` for
/// placed, else a code (`exists`, `name`, ...).
#[napi]
pub fn files_drive_place(parent: String, entries: Vec<FilesPlacement>) -> Result<Vec<String>> {
    checked_path(&parent)?;
    if entries.len() > MAX_PLACE_BATCH {
        return Err(invalid("batch"));
    }
    for entry in &entries {
        checked_name(&entry.name)?;
        checked_identity(&entry.identity)?;
        checked_count(entry.size, "size")?;
        if !entry.mtime_ms.is_finite() {
            return Err(invalid("mtime"));
        }
    }
    files::place(&parent, &entries).map_err(files_error)
}

/// What a path under a sync root is now. Fetches nothing.
#[napi]
pub fn files_drive_info(path: String) -> Result<FilesPlaceholderInfo> {
    files::info(checked_path(&path)?).map_err(files_error)
}

#[napi]
pub fn files_drive_update(path: String, change: FilesUpdate) -> Result<()> {
    checked_path(&path)?;
    if let Some(identity) = &change.identity {
        checked_identity(identity)?;
    }
    if let Some(size) = change.size {
        checked_count(size, "size")?;
    }
    if change.mtime_ms.is_some_and(|ms| !ms.is_finite()) {
        return Err(invalid("mtime"));
    }
    files::update(&path, &change).map_err(files_error)
}

/// Makes something created here a placeholder with this identity, in sync.
#[napi]
pub fn files_drive_convert(path: String, identity: String) -> Result<()> {
    files::convert(checked_path(&path)?, checked_identity(&identity)?).map_err(files_error)
}

/// Fetches all of a file, through this process's own connection. Resolves when it's on disk.
#[napi]
pub fn files_drive_hydrate(path: String) -> Result<AsyncTask<FilesJob<()>>> {
    checked_path(&path)?;
    Ok(files_job(move || files::hydrate(&path)))
}

/// Drops a file's content from the disk. Refused (`files:pinned`) for a pinned one.
#[napi]
pub fn files_drive_dehydrate(path: String) -> Result<()> {
    files::dehydrate(checked_path(&path)?).map_err(files_error)
}

/// Drive letters in use now, A as bit 0. For picking a free one for the drive.
#[napi]
pub fn files_used_drive_letters() -> u32 {
    files::used_drive_letters()
}


// ─── The drive's status in Explorer (Windows 11) ─────────────

const MAX_STATUS_LABEL: usize = 200;
const MAX_STATUS_DETAIL: usize = 500;

#[napi(object)]
#[derive(Clone)]
pub struct FilesDriveQuota {
    pub used: f64,
    /// None: the server sets no limit, only what's used is shown.
    pub total: Option<f64>,
    /// "1.2 GB of 5 GB used", translated.
    pub label: String,
}

#[napi(object)]
#[derive(Clone)]
pub struct FilesDriveStatus {
    /// `synced`, `syncing`, `paused`, `offline` or `error`.
    pub state: String,
    /// Short, next to the state in Explorer.
    pub label: String,
    /// The longer line in Explorer's flyout.
    pub detail: String,
    pub quota: Option<FilesDriveQuota>,
    /// A line of its own in the flyout: storage nearly full, or full.
    pub notice: Option<String>,
}

#[napi(object)]
pub struct FilesDriveStatusSeen {
    pub state: String,
    pub label: String,
    pub detail: String,
    pub quota_used: Option<f64>,
    pub quota_total: Option<f64>,
    pub quota_label: Option<String>,
    pub notice: Option<String>,
    /// StatusUIChanged came while waiting.
    pub changed: bool,
}

fn checked_status(status: &FilesDriveStatus) -> Result<()> {
    if !["synced", "syncing", "paused", "offline", "error"].contains(&status.state.as_str()) {
        return Err(invalid("state"));
    }
    checked_label(&status.label, MAX_STATUS_LABEL, "label", |c| !c.is_control())?;
    if status.detail.chars().count() > MAX_STATUS_DETAIL || status.detail.chars().any(char::is_control) {
        return Err(invalid("detail"));
    }
    if let Some(quota) = &status.quota {
        checked_count(quota.used, "used")?;
        if let Some(total) = quota.total {
            checked_count(total, "total")?;
        }
        checked_label(&quota.label, MAX_STATUS_LABEL, "quota label", |c| !c.is_control())?;
    }
    if let Some(notice) = &status.notice {
        if notice.chars().count() > MAX_STATUS_DETAIL || notice.chars().any(char::is_control) {
            return Err(invalid("notice"));
        }
    }
    Ok(())
}

fn checked_clsid(clsid: &str) -> Result<()> {
    checked_label(clsid, 38, "clsid", |c| c.is_ascii_hexdigit() || "{}-".contains(c))
}

/// A sync root's id as the registry key's name: no backslash, which would reach another key.
fn checked_root_id(id: &str) -> Result<()> {
    checked_label(id, 512, "id", |c| !c.is_control() && c != '\\')
}

type StatusCommandCallback = ThreadsafeFunction<String, Unknown<'static>, String, Status, false, true>;

/// Serves Explorer's status for the drive from this process, under `clsid`, until
/// `filesDriveStatusStop`. False: this Windows has no status in Explorer (before Windows 11
/// 22H2). `icon` is a file: URL Explorer shows next to the state. A click on the state line
/// in Explorer calls `callback` with the sync root's id.
#[napi]
pub fn files_drive_status_serve(clsid: String, icon: String, callback: StatusCommandCallback) -> Result<bool> {
    checked_clsid(&clsid)?;
    checked_label(&icon, MAX_PATH_CHARS, "icon", |c| !c.is_control())?;
    if !icon.starts_with("file:///") {
        return Err(invalid("icon"));
    }
    let sink: files_status::CommandSink = Box::new(move |root| {
        callback.call(root, ThreadsafeFunctionCallMode::NonBlocking);
    });
    files_status::serve(&clsid, &icon, sink).map_err(files_error)
}

/// Stops serving the status. Nothing in the registry changes.
#[napi]
pub fn files_drive_status_stop() {
    files_status::stop()
}

/// Names the status class in a registered sync root's key, where Explorer looks for it.
/// Again after each `filesDriveRegister` of that root. Unregistering removes it with the key.
#[napi]
pub fn files_drive_status_attach(id: String, clsid: String) -> Result<()> {
    checked_root_id(&id)?;
    checked_clsid(&clsid)?;
    files_status::attach(&id, &clsid).map_err(files_error)
}

/// What Explorer shows for a sync root from now on, and tells Explorer windows showing it.
/// Null forgets the root.
#[napi]
pub fn files_drive_status_set(id: String, status: Option<FilesDriveStatus>) -> Result<()> {
    checked_root_id(&id)?;
    if let Some(status) = &status {
        checked_status(status)?;
    }
    files_status::set(&id, status);
    Ok(())
}

/// The status as Explorer reads it: the class named in the root's key, created out of
/// process. With `waitMs`, waits up to that long for a change and answers the status after it.
#[napi]
pub fn files_drive_status_read(id: String, wait_ms: u32) -> Result<AsyncTask<FilesJob<FilesDriveStatusSeen>>> {
    checked_root_id(&id)?;
    let wait = wait_ms.min(60_000);
    Ok(files_job(move || files_status::read(&id, wait)))
}
/// Tells Explorer a drive letter's name or icon changed, so "This PC" shows the new ones.
#[napi]
pub fn files_drive_letter_changed(letter: String) -> Result<()> {
    checked_label(&letter, 1, "letter", |c| c.is_ascii_uppercase())?;
    files::letter_changed(&letter);
    Ok(())
}

// ─── What Windows' own tools did (reg, PowerShell, icacls, subst, attrib) ───
//
// Main started System32's tools for these, and endpoint protection blocks or flags an app
// that does. Same results, in process. See system_windows.rs.

const MAX_REGISTRY_KEY: usize = 2048;
const MAX_REGISTRY_NAME: usize = 16_383;
const MAX_REGISTRY_DATA: usize = 1024 * 1024;
const MAX_REGISTRY_DEPTH: u32 = 16;
/// More than main ever puts on the clipboard at once (os-files.ts, MAX_FILES).
const MAX_CLIPBOARD_FILES: usize = 200;

fn system_invalid(area: &str, what: &str) -> Error {
    Error::from_reason(format!("{area}:invalid ({what})"))
}

/// `HKCU\...` or `HKLM\...`: no empty part, none longer than a key's name can be.
fn checked_registry_key(key: &str) -> Result<&str> {
    if key.is_empty() || key.chars().count() > MAX_REGISTRY_KEY || key.contains('\0') || key.split('\\').any(|part| part.is_empty() || part.chars().count() > 255) {
        return Err(system_invalid("registry", "key"));
    }
    Ok(key)
}

fn checked_registry_text(text: &str, max: usize, what: &str) -> Result<()> {
    if text.chars().count() > max || text.contains('\0') {
        return Err(system_invalid("registry", what));
    }
    Ok(())
}

/// A drive path, or a share's (`\\server\share\...`) for the clipboard.
fn checked_any_path(path: &str) -> Result<&str> {
    if path.starts_with(r"\\") && !path.starts_with(r"\\?\") && !path.starts_with(r"\\.\") && path.len() > 2 && !path.contains('\0') && !path.contains('/') && path.chars().count() <= MAX_PATH_CHARS {
        return Ok(path);
    }
    checked_path(path)
}

fn checked_letter(letter: &str) -> Result<char> {
    let mut chars = letter.chars();
    match (chars.next(), chars.next()) {
        (Some(c), None) if c.is_ascii_uppercase() => Ok(c),
        _ => Err(system_invalid("system", "letter")),
    }
}

#[napi(object)]
pub struct RegistryValue {
    /// Empty for the key's default value.
    pub name: String,
    /// `sz`, `expand_sz` (not expanded), `multi_sz`, `dword`, `qword`, `binary`, `none` or `other`.
    pub kind: String,
    /// A string's text, up to its first NUL. A QWORD's number, in decimal.
    pub text: Option<String>,
    /// A REG_MULTI_SZ's strings.
    pub list: Option<Vec<String>>,
    /// A DWORD, unsigned.
    pub number: Option<f64>,
}

#[napi(object)]
pub struct RegistryNode {
    /// Below the key that was read, `\` between names. Empty for that key itself.
    pub path: String,
    pub values: Vec<RegistryValue>,
    /// The names of the keys right below it, read or not.
    pub subkeys: Vec<String>,
}

/// A key and up to `depth` levels of keys below it, under HKCU or HKLM. Null if the key isn't
/// there. Throws `registry:<code>` when it is and can't be read: never an empty answer then.
#[napi]
pub fn registry_read(key: String, depth: u32) -> Result<Option<Vec<RegistryNode>>> {
    checked_registry_key(&key)?;
    if depth > MAX_REGISTRY_DEPTH {
        return Err(system_invalid("registry", "depth"));
    }
    system::registry_read(&key, depth).map_err(Error::from_reason)
}

/// A REG_SZ value, the key made if it isn't there. Only under `HKCU\Software\<name>`. No name
/// sets the key's default value.
#[napi]
pub fn registry_set_string(key: String, name: Option<String>, data: String) -> Result<()> {
    checked_registry_key(&key)?;
    if let Some(name) = &name {
        checked_registry_text(name, MAX_REGISTRY_NAME, "name")?;
    }
    checked_registry_text(&data, MAX_REGISTRY_DATA, "data")?;
    system::registry_set_string(&key, name.as_deref(), &data).map_err(Error::from_reason)
}

/// A key with everything below it. Only under `HKCU\Software\<name>`. False if it wasn't there.
#[napi]
pub fn registry_delete_key(key: String) -> Result<bool> {
    checked_registry_key(&key)?;
    system::registry_delete_key(&key).map_err(Error::from_reason)
}

/// One value. Only under `HKCU\Software\<name>`. False if it, or its key, wasn't there.
#[napi]
pub fn registry_delete_value(key: String, name: String) -> Result<bool> {
    checked_registry_key(&key)?;
    checked_registry_text(&name, MAX_REGISTRY_NAME, "name")?;
    system::registry_delete_value(&key, &name).map_err(Error::from_reason)
}

#[napi(object)]
pub struct QuietState {
    /// Do Not Disturb's profile: 1 priority only, 2 alarms only, 0 off or unknown.
    pub profile: i32,
    /// SHQueryUserNotificationState: 2 busy, 3 Direct3D full screen, 4 presentation, 6 quiet time. 0 unknown.
    pub notification_state: i32,
}

/// Whether Windows holds back notifications now: Do Not Disturb (Focus Assist) and the
/// shell's own state. Zeros where Windows doesn't say, and on other systems.
#[napi]
pub fn notification_quiet_state() -> AsyncTask<FilesJob<QuietState>> {
    files_job(|| Ok(system::quiet_state()))
}

/// Puts files on the clipboard as Explorer copies them (CF_HDROP, as a copy). Rejects with
/// `clipboard:busy` when another program holds the clipboard the whole time.
#[napi]
pub fn clipboard_write_files(paths: Vec<String>) -> Result<AsyncTask<FilesJob<()>>> {
    if paths.is_empty() || paths.len() > MAX_CLIPBOARD_FILES {
        return Err(system_invalid("clipboard", "paths"));
    }
    for path in &paths {
        checked_any_path(path)?;
    }
    Ok(files_job(move || system::clipboard_write_files(&paths)))
}

/// A folder only this user and SYSTEM can open, with what's in it: full control for both and
/// nothing inherited from the folders above.
#[napi]
pub fn folder_make_private(path: String) -> Result<AsyncTask<FilesJob<()>>> {
    checked_path(&path)?;
    Ok(files_job(move || system::folder_make_private(&path)))
}

#[napi(object)]
pub struct DriveLetterMapping {
    pub letter: String,
    pub target: String,
}

/// The drive letters mapped to a folder in this sign-in session, as `subst` lists them.
#[napi]
pub fn drive_letter_list() -> Vec<DriveLetterMapping> {
    system::drive_letters()
}

/// Maps a free letter to a folder, as `subst X: <folder>`. Promise.
#[napi]
pub fn drive_letter_add(letter: String, target: String) -> Result<AsyncTask<FilesJob<()>>> {
    let letter = checked_letter(&letter)?;
    checked_path(&target)?;
    Ok(files_job(move || system::drive_letter_add(letter, &target)))
}

/// Takes a letter's mapping to a folder away, as `subst X: /D`. Never a disk's. Promise.
#[napi]
pub fn drive_letter_remove(letter: String) -> Result<AsyncTask<FilesJob<()>>> {
    let letter = checked_letter(&letter)?;
    Ok(files_job(move || system::drive_letter_remove(letter)))
}

/// The pin attributes of a file or folder: `pinned` ("Always keep on this device"),
/// `unpinned` ("Free up space") or `unspecified`, as `attrib` sets them. Promise: off the JS
/// thread, since the drive's fetch callbacks come to it.
#[napi]
pub fn file_set_pin(path: String, pin: String) -> Result<AsyncTask<FilesJob<()>>> {
    checked_path(&path)?;
    if !["pinned", "unpinned", "unspecified"].contains(&pin.as_str()) {
        return Err(system_invalid("system", "pin"));
    }
    Ok(files_job(move || system::set_pin(&path, &pin)))
}

#[napi(object)]
pub struct CodeSignature {
    /// `valid`, `unsigned` or `invalid`; `unsupported` off Windows.
    pub status: String,
    /// WinVerifyTrust's answer, `0x...`, for a log.
    pub code: String,
    /// The signer's subject, `CN=..., O=..., C=...` as .NET shows it, where Windows found one.
    pub subject: Option<String>,
}

/// A file's embedded Authenticode signature and its signer, through WinVerifyTrust, for an
/// update's installer: what electron-updater asked PowerShell for. Promise.
#[napi]
pub fn code_signature_check(path: String) -> Result<AsyncTask<FilesJob<CodeSignature>>> {
    checked_path(&path)?;
    Ok(files_job(move || Ok(system::code_signature(&path))))
}
