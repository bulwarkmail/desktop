//! Windows' own print dialog, with the pages in its preview. Windows shows the pages only for an
//! app that draws them itself through the WinRT print API (PrintManager): the dialog Chromium
//! opens says "This app doesn't support print preview". So main hands over the document as a
//! PDF, and this module is the document source Windows asks for pages: for the preview
//! (IPrintPreviewPageCollection, a DXGI surface per page) and for the job (MakeDocument, a
//! Direct2D command list per page). Windows' own PDF renderer (Windows.Data.Pdf) draws them.
//!
//! A PDF page goes onto the sheet the dialog chose at its own size, centred, and shrunk only
//! when it doesn't fit (another paper, or landscape for a portrait page). A page of the app's
//! own comes with a landscape copy as well, laid out again, which the dialog's landscape
//! uses. Page ranges are the dialog's "Pages" choice, read where Windows paginates.
//!
//! The dialog opens on the window's own thread. Windows calls the source from its own
//! threads, so each document's drawing sits behind a lock.

use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::thread::{self, sleep};
use std::time::Duration;

use core::ffi::c_void;

use windows::core::{factory, implement, s, w, IInspectable, IUnknown, IUnknownImpl, Interface, Ref, Result as WinResult, GUID, HRESULT, HSTRING, PCSTR, PCWSTR};
use windows::Data::Pdf::{PdfDocument, PdfPage};
use windows::Foundation::TypedEventHandler;
use windows::Graphics::Printing::{
    IPrintDocumentSource, IPrintDocumentSource_Impl, PrintManager, PrintOrientation, PrintTask, PrintTaskCompletedEventArgs, PrintTaskCompletion, PrintTaskOptions,
    PrintTaskRequestedEventArgs, PrintTaskSourceRequestedArgs, PrintTaskSourceRequestedHandler, StandardPrintTaskOptions,
};
use windows::Storage::Streams::{DataWriter, InMemoryRandomAccessStream};
use windows::Win32::Foundation::{E_INVALIDARG, HMODULE, HWND};
use windows::Win32::Graphics::Direct2D::Common::{D2D1_ALPHA_MODE_PREMULTIPLIED, D2D1_COLOR_F, D2D1_PIXEL_FORMAT, D2D_COLOR_F, D2D_RECT_F, D2D_SIZE_F};
use windows::Win32::Graphics::Direct2D::{
    D2D1_FACTORY_TYPE, ID2D1Device, ID2D1DeviceContext, ID2D1Factory1, D2D1_BITMAP_OPTIONS_CANNOT_DRAW, D2D1_BITMAP_OPTIONS_TARGET, D2D1_BITMAP_PROPERTIES1,
    D2D1_DEVICE_CONTEXT_OPTIONS_NONE, D2D1_FACTORY_OPTIONS, D2D1_FACTORY_TYPE_MULTI_THREADED, D2D1_PRINT_CONTROL_PROPERTIES, D2D1_PRINT_FONT_SUBSET_MODE_DEFAULT,
    D2D1_COLOR_SPACE_SRGB,
};
use windows::Win32::Graphics::Direct3D::{D3D_DRIVER_TYPE, D3D_DRIVER_TYPE_HARDWARE, D3D_DRIVER_TYPE_WARP};
use windows::Win32::Graphics::Direct3D11::{
    D3D11_CREATE_DEVICE_FLAG, ID3D11Device, ID3D11Texture2D, D3D11_BIND_RENDER_TARGET, D3D11_BIND_SHADER_RESOURCE, D3D11_CREATE_DEVICE_BGRA_SUPPORT, D3D11_SDK_VERSION,
    D3D11_TEXTURE2D_DESC, D3D11_USAGE_DEFAULT,
};
use windows::Win32::Graphics::Dxgi::Common::{DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_SAMPLE_DESC};
use windows::Win32::Graphics::Dxgi::{IDXGIDevice, IDXGISurface};
use windows::Win32::Graphics::Imaging::{CLSID_WICImagingFactory, IWICImagingFactory};
use windows::Win32::Graphics::Printing::{IPrintPreviewDxgiPackageTarget, FinalPageCount};
use windows::Win32::Storage::Xps::Printing::IPrintDocumentPackageTarget;
use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED};
use windows::Win32::System::LibraryLoader::{GetProcAddress, LoadLibraryExW, LOAD_LIBRARY_SEARCH_SYSTEM32};
use windows::Win32::System::WinRT::Pdf::{IPdfRendererNative, PDF_RENDER_PARAMS};
use windows::Win32::System::WinRT::Printing::{
    IPrintDocumentPageSource, IPrintDocumentPageSource_Impl, IPrintManagerInterop, IPrintPreviewPageCollection, IPrintPreviewPageCollection_Impl,
};
use windows::Win32::UI::WindowsAndMessaging::IsWindow;
use windows_future::{AsyncStatus, IAsyncOperation};

/// documentpackagetarget.h: the preview's package target, DXGI surfaces.
const ID_PREVIEWPACKAGETARGET_DXGI: GUID = GUID::from_u128(0x1a6dd0ad_1e2a_4e99_a5ba_91f17818290e);
/// "The page the app shows now", in MakePage.
const JOB_PAGE_APPLICATION_DEFINED: u32 = u32::MAX;
const POLL: Duration = Duration::from_millis(50);
/// After the dialog closed with Print, how long the job may take to be handed to the spooler.
const JOB_WAIT: Duration = Duration::from_secs(15 * 60);

// ─── Libraries, loaded when a dialog opens ───────────────────
//
// Direct3D, Direct2D and Windows' PDF renderer are looked up at run time, from
// System32 only: linked, they would load with the helper at every start of the app.

fn system_function(library: PCWSTR, name: PCSTR) -> WinResult<unsafe extern "system" fn() -> isize> {
    let module = unsafe { LoadLibraryExW(library, None, LOAD_LIBRARY_SEARCH_SYSTEM32) }?;
    unsafe { GetProcAddress(module, name) }.ok_or_else(windows::core::Error::from_thread)
}

type D3D11CreateDeviceFn = unsafe extern "system" fn(
    adapter: *mut c_void,
    driver: D3D_DRIVER_TYPE,
    software: HMODULE,
    flags: D3D11_CREATE_DEVICE_FLAG,
    levels: *const c_void,
    level_count: u32,
    sdk: u32,
    device: *mut *mut c_void,
    level: *mut c_void,
    context: *mut *mut c_void,
) -> HRESULT;
type D2D1CreateFactoryFn = unsafe extern "system" fn(kind: D2D1_FACTORY_TYPE, iid: *const GUID, options: *const D2D1_FACTORY_OPTIONS, factory: *mut *mut c_void) -> HRESULT;
type PdfCreateRendererFn = unsafe extern "system" fn(device: *mut c_void, renderer: *mut *mut c_void) -> HRESULT;
fn d3d11_create_device(driver: D3D_DRIVER_TYPE) -> WinResult<ID3D11Device> {
    let create: D3D11CreateDeviceFn = unsafe { std::mem::transmute(system_function(w!("d3d11.dll"), s!("D3D11CreateDevice"))?) };
    let mut device = std::ptr::null_mut();
    unsafe {
        create(std::ptr::null_mut(), driver, HMODULE::default(), D3D11_CREATE_DEVICE_BGRA_SUPPORT, std::ptr::null(), 0, D3D11_SDK_VERSION, &mut device, std::ptr::null_mut(), std::ptr::null_mut()).ok()?;
        Ok(ID3D11Device::from_raw(device))
    }
}

fn d2d1_create_factory() -> WinResult<ID2D1Factory1> {
    let create: D2D1CreateFactoryFn = unsafe { std::mem::transmute(system_function(w!("d2d1.dll"), s!("D2D1CreateFactory"))?) };
    let mut factory = std::ptr::null_mut();
    unsafe {
        create(D2D1_FACTORY_TYPE_MULTI_THREADED, &ID2D1Factory1::IID, &D2D1_FACTORY_OPTIONS::default(), &mut factory).ok()?;
        Ok(ID2D1Factory1::from_raw(factory))
    }
}

fn pdf_create_renderer(device: &IDXGIDevice) -> WinResult<IPdfRendererNative> {
    let create: PdfCreateRendererFn = unsafe { std::mem::transmute(system_function(w!("windows.data.pdf.dll"), s!("PdfCreateRenderer"))?) };
    let mut renderer = std::ptr::null_mut();
    unsafe {
        create(device.as_raw(), &mut renderer).ok()?;
        Ok(IPdfRendererNative::from_raw(renderer))
    }
}

fn trace(step: &str, detail: impl std::fmt::Debug) {
    if std::env::var_os("BULWARK_TEST_PRINT_DIALOG").is_some() {
        eprintln!("print dialog: {step}: {detail:?}");
    }
}

fn window_from(bytes: &[u8]) -> Option<HWND> {
    let value = match bytes.len() {
        8 => u64::from_le_bytes(bytes.try_into().ok()?) as usize,
        4 => u32::from_le_bytes(bytes.try_into().ok()?) as usize,
        _ => return None,
    };
    let window = HWND(value as *mut core::ffi::c_void);
    unsafe { IsWindow(Some(window)) }.as_bool().then_some(window)
}

fn wait_for<T>(op: &IAsyncOperation<T>, limit: Option<Duration>) -> WinResult<Option<T>>
where
    T: windows_core::RuntimeType + 'static,
{
    let start = std::time::Instant::now();
    loop {
        match op.Status()? {
            AsyncStatus::Started => {
                if limit.is_some_and(|limit| start.elapsed() >= limit) {
                    let _ = op.Cancel();
                    return Ok(None);
                }
                sleep(POLL);
            }
            AsyncStatus::Completed => return op.GetResults().map(Some),
            AsyncStatus::Canceled => return Ok(None),
            _ => return Err(op.ErrorCode().map(windows::core::Error::from_hresult).unwrap_or_else(|error| error)),
        }
    }
}

// ─── Drawing ─────────────────────────────────────────────────

struct Painter {
    document: PdfDocument,
    renderer: IPdfRendererNative,
    d3d: ID3D11Device,
    d2d: ID2D1Device,
}

// Created on the module's thread, used by Windows' threads one at a time (behind the lock).
// D2D's factory is multithreaded; the PDF renderer and the document are agile.
unsafe impl Send for Painter {}

fn create_d3d() -> WinResult<ID3D11Device> {
    // No graphics driver worth the name (a VM, a remote session): the software one.
    d3d11_create_device(D3D_DRIVER_TYPE_HARDWARE).or_else(|_| d3d11_create_device(D3D_DRIVER_TYPE_WARP))
}

impl Painter {
    fn new(document: PdfDocument) -> WinResult<Self> {
        let d3d = create_d3d()?;
        let dxgi: IDXGIDevice = d3d.cast()?;
        let factory = d2d1_create_factory()?;
        let d2d = unsafe { factory.CreateDevice(&dxgi) }?;
        let renderer = pdf_create_renderer(&dxgi)?;
        Ok(Self { document, renderer, d3d, d2d })
    }

    fn page(&self, index: u32) -> WinResult<PdfPage> {
        self.document.GetPage(index)
    }

    /// Draws a document page on a sheet of `sheet` DIPs, at `scale` device units per DIP: its
    /// own size and centred, shrunk to fit when it's bigger.
    fn draw(&self, context: &ID2D1DeviceContext, index: u32, sheet: (f32, f32), scale: f32) -> WinResult<()> {
        let page = self.page(index)?;
        let size = page.Size()?;
        let (width, height) = (size.Width.max(1.0), size.Height.max(1.0));
        let fit = (sheet.0 / width).min(sheet.1 / height).min(1.0);
        let (drawn_width, drawn_height) = (width * fit * scale, height * fit * scale);
        let left = ((sheet.0 * scale - drawn_width) / 2.0).max(0.0);
        let top = ((sheet.1 * scale - drawn_height) / 2.0).max(0.0);
        let params = PDF_RENDER_PARAMS {
            SourceRect: D2D_RECT_F { left: 0.0, top: 0.0, right: width, bottom: height },
            DestinationWidth: drawn_width.round().max(1.0) as u32,
            DestinationHeight: drawn_height.round().max(1.0) as u32,
            BackgroundColor: D2D_COLOR_F { r: 1.0, g: 1.0, b: 1.0, a: 1.0 },
            IgnoreHighContrast: true,
        };
        unsafe {
            context.BeginDraw();
            context.Clear(Some(&D2D1_COLOR_F { r: 1.0, g: 1.0, b: 1.0, a: 1.0 }));
            context.SetTransform([1.0f32, 0.0, 0.0, 1.0, left, top].as_ptr() as *const _);
            let drawn = self.renderer.RenderPageToDeviceContext(&page.cast::<IUnknown>()?, context, Some(&params));
            context.SetTransform([1.0f32, 0.0, 0.0, 1.0, 0.0, 0.0].as_ptr() as *const _);
            let ended = context.EndDraw(None, None);
            drawn?;
            ended?;
        }
        Ok(())
    }

    /// One preview page: a surface of `width` × `height` pixels.
    fn preview(&self, target: &IPrintPreviewDxgiPackageTarget, job_page: u32, index: u32, sheet: (f32, f32), width: f32, height: f32) -> WinResult<()> {
        let scale = (width / sheet.0.max(1.0)).min(height / sheet.1.max(1.0)).max(0.01);
        let pixels = ((sheet.0 * scale).ceil().max(1.0) as u32, (sheet.1 * scale).ceil().max(1.0) as u32);
        let description = D3D11_TEXTURE2D_DESC {
            Width: pixels.0,
            Height: pixels.1,
            MipLevels: 1,
            ArraySize: 1,
            Format: DXGI_FORMAT_B8G8R8A8_UNORM,
            SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
            Usage: D3D11_USAGE_DEFAULT,
            BindFlags: (D3D11_BIND_RENDER_TARGET.0 | D3D11_BIND_SHADER_RESOURCE.0) as u32,
            CPUAccessFlags: 0,
            MiscFlags: 0,
        };
        let mut texture: Option<ID3D11Texture2D> = None;
        unsafe { self.d3d.CreateTexture2D(&description, None, Some(&mut texture)) }?;
        let surface: IDXGISurface = texture.ok_or_else(|| windows::core::Error::from_hresult(E_INVALIDARG))?.cast()?;
        let context = unsafe { self.d2d.CreateDeviceContext(D2D1_DEVICE_CONTEXT_OPTIONS_NONE) }?;
        let properties = D2D1_BITMAP_PROPERTIES1 {
            pixelFormat: D2D1_PIXEL_FORMAT { format: DXGI_FORMAT_B8G8R8A8_UNORM, alphaMode: D2D1_ALPHA_MODE_PREMULTIPLIED },
            dpiX: 96.0,
            dpiY: 96.0,
            bitmapOptions: D2D1_BITMAP_OPTIONS_TARGET | D2D1_BITMAP_OPTIONS_CANNOT_DRAW,
            colorContext: std::mem::ManuallyDrop::new(None),
        };
        let bitmap = unsafe { context.CreateBitmapFromDxgiSurface(&surface, Some(&properties)) }?;
        unsafe { context.SetTarget(&bitmap) };
        self.draw(&context, index, sheet, scale)?;
        unsafe { context.SetTarget(None) };
        // The surface is the sheet at `scale`: Windows takes its DPI from that.
        let dpi = 96.0 * scale;
        unsafe { target.DrawPage(job_page, &surface, dpi, dpi) }
    }

    /// The job: one command list per page, to the printer's package target.
    fn print(&self, target: &IPrintDocumentPackageTarget, options: &PrintTaskOptions, pages: &[u32]) -> WinResult<()> {
        let wic: IWICImagingFactory = unsafe { CoCreateInstance(&CLSID_WICImagingFactory, None, CLSCTX_INPROC_SERVER) }?;
        let properties = D2D1_PRINT_CONTROL_PROPERTIES { fontSubset: D2D1_PRINT_FONT_SUBSET_MODE_DEFAULT, rasterDPI: 300.0, colorSpace: D2D1_COLOR_SPACE_SRGB };
        let control = unsafe { self.d2d.CreatePrintControl(&wic, target, Some(&properties)) }?;
        let context = unsafe { self.d2d.CreateDeviceContext(D2D1_DEVICE_CONTEXT_OPTIONS_NONE) }?;
        for (position, index) in pages.iter().enumerate() {
            let sheet = sheet_of(options, position as u32 + 1)?;
            let list = unsafe { context.CreateCommandList() }?;
            unsafe { context.SetTarget(&list) };
            self.draw(&context, *index, sheet, 1.0)?;
            unsafe { context.SetTarget(None) };
            unsafe { list.Close() }?;
            unsafe { control.AddPage(&list, D2D_SIZE_F { width: sheet.0, height: sheet.1 }, None, None, None) }?;
        }
        unsafe { control.Close() }
    }
}

/// The sheet of a job page in DIPs, as the dialog's paper and orientation make it.
fn sheet_of(options: &PrintTaskOptions, job_page: u32) -> WinResult<(f32, f32)> {
    let description = options.GetPageDescription(job_page)?;
    Ok((description.PageSize.Width.max(1.0), description.PageSize.Height.max(1.0)))
}

/// The document pages (0-based) the dialog's "Pages" choice picks. All of them when it names
/// none, or none that exist.
fn chosen_pages(options: Option<&PrintTaskOptions>, total: u32) -> Vec<u32> {
    let all: Vec<u32> = (0..total).collect();
    let Some(options) = options else { return all };
    let Ok(ranges) = options.CustomPageRanges() else { return all };
    let count = ranges.Size().unwrap_or(0);
    let mut pages = Vec::new();
    for at in 0..count {
        let Ok(range) = ranges.GetAt(at) else { continue };
        let first = range.FirstPageNumber().unwrap_or(0).max(1) as u32;
        let last = range.LastPageNumber().unwrap_or(0).max(first as i32) as u32;
        for page in first..=last.min(total) {
            pages.push(page - 1);
        }
    }
    if pages.is_empty() { all } else { pages }
}

// ─── The document source Windows asks ────────────────────────

struct Preview {
    target: Option<IPrintPreviewDxgiPackageTarget>,
    options: Option<PrintTaskOptions>,
    document: Option<Arc<Mutex<Document>>>,
    pages: Vec<u32>,
    current: u32,
}

unsafe impl Send for Preview {}

/// The PDF, drawn once it's loaded. Loading starts on a thread of its own as the dialog opens;
/// the first page Windows asks for waits for it.
struct Document {
    data: Option<Vec<u8>>,
    painter: Option<WinResult<(Painter, u32)>>,
}

impl Document {
    fn painter(&mut self) -> WinResult<(&Painter, u32)> {
        if self.painter.is_none() {
            let data = self.data.take().unwrap_or_default();
            let loaded = load_pdf(&data).and_then(|document| {
                let total = document.PageCount()?;
                if total == 0 {
                    return Err(windows::core::Error::from_hresult(E_INVALIDARG));
                }
                Ok((Painter::new(document)?, total))
            });
            if let Err(error) = &loaded {
                trace("load", error);
            }
            self.painter = Some(loaded);
        }
        match self.painter.as_ref() {
            Some(Ok((painter, total))) => Ok((painter, *total)),
            Some(Err(error)) => Err(error.clone()),
            None => Err(windows::core::Error::from_hresult(E_INVALIDARG)),
        }
    }
}

#[implement(IPrintDocumentSource, IPrintDocumentPageSource, IPrintPreviewPageCollection)]
struct Source {
    portrait: Arc<Mutex<Document>>,
    /// A page of the app's, laid out again for landscape. None for a PDF: its layout is its own.
    landscape: Option<Arc<Mutex<Document>>>,
    preview: Mutex<Preview>,
}

impl Source {
    /// The document for the dialog's orientation.
    fn document_for(&self, options: &PrintTaskOptions) -> Arc<Mutex<Document>> {
        let landscape = matches!(options.Orientation(), Ok(PrintOrientation::Landscape | PrintOrientation::LandscapeFlipped));
        match (&self.landscape, landscape) {
            (Some(document), true) => document.clone(),
            _ => self.portrait.clone(),
        }
    }
}

impl IPrintDocumentSource_Impl for Source_Impl {}

impl IPrintDocumentPageSource_Impl for Source_Impl {
    fn GetPreviewPageCollection(&self, target: Ref<IPrintDocumentPackageTarget>) -> WinResult<IPrintPreviewPageCollection> {
        let target = target.ok()?;
        let preview: IPrintPreviewDxgiPackageTarget = unsafe { target.GetPackageTarget(&ID_PREVIEWPACKAGETARGET_DXGI) }?;
        self.preview.lock().map_err(|_| E_INVALIDARG)?.target = Some(preview);
        self.to_interface::<IPrintPreviewPageCollection>().cast()
    }

    fn MakeDocument(&self, options: Ref<IInspectable>, target: Ref<IPrintDocumentPackageTarget>) -> WinResult<()> {
        let options: PrintTaskOptions = options.ok()?.cast()?;
        let document = self.document_for(&options);
        let mut document = document.lock().map_err(|_| E_INVALIDARG)?;
        let (painter, total) = document.painter()?;
        let pages = chosen_pages(Some(&options), total);
        let printed = painter.print(target.ok()?, &options, &pages);
        trace("make document", &printed);
        printed
    }
}

impl IPrintPreviewPageCollection_Impl for Source_Impl {
    fn Paginate(&self, current: u32, options: Ref<IInspectable>) -> WinResult<()> {
        let options: PrintTaskOptions = options.ok()?.cast()?;
        let document = self.document_for(&options);
        let total = document.lock().map_err(|_| E_INVALIDARG)?.painter()?.1;
        let pages = chosen_pages(Some(&options), total);
        let target = {
            let mut preview = self.preview.lock().map_err(|_| E_INVALIDARG)?;
            preview.pages = pages.clone();
            preview.options = Some(options);
            preview.document = Some(document);
            preview.current = if current == JOB_PAGE_APPLICATION_DEFINED || current == 0 { 1 } else { current.min(pages.len() as u32).max(1) };
            preview.target.clone()
        };
        trace("paginate", pages.len());
        if let Some(target) = target {
            unsafe {
                target.SetJobPageCount(FinalPageCount, pages.len() as u32)?;
                target.InvalidatePreview()?;
            }
        }
        Ok(())
    }

    fn MakePage(&self, desired: u32, width: f32, height: f32) -> WinResult<()> {
        let (target, options, document, index, job_page) = {
            let preview = self.preview.lock().map_err(|_| E_INVALIDARG)?;
            let job_page = if desired == JOB_PAGE_APPLICATION_DEFINED { preview.current } else { desired };
            let Some(index) = preview.pages.get(job_page.saturating_sub(1) as usize).copied() else { return Ok(()) };
            let (Some(target), Some(options), Some(document)) = (preview.target.clone(), preview.options.clone(), preview.document.clone()) else { return Ok(()) };
            (target, options, document, index, job_page)
        };
        let sheet = sheet_of(&options, job_page)?;
        let mut document = document.lock().map_err(|_| E_INVALIDARG)?;
        let (painter, _) = document.painter()?;
        let made = painter.preview(&target, job_page, index, sheet, width, height);
        trace("make page", (job_page, width, height, &made));
        made
    }
}

// ─── The dialog ──────────────────────────────────────────────

/// The source, for Windows' threads. Objects from #[implement] are agile (IAgileObject).
#[derive(Clone)]
struct Shared(IPrintDocumentSource);
unsafe impl Send for Shared {}
unsafe impl Sync for Shared {}

impl Shared {
    // A method, so a closure takes the whole wrapper and not its field.
    fn get(&self) -> &IPrintDocumentSource {
        &self.0
    }
}

fn load_pdf(data: &[u8]) -> WinResult<PdfDocument> {
    let stream = InMemoryRandomAccessStream::new()?;
    let writer = DataWriter::CreateDataWriter(&stream)?;
    writer.WriteBytes(data)?;
    wait_for(&writer.StoreAsync()?, Some(Duration::from_secs(30)))?;
    wait_for(&writer.FlushAsync()?, Some(Duration::from_secs(30)))?;
    writer.DetachStream()?;
    stream.Seek(0)?;
    wait_for(&PdfDocument::LoadFromStreamAsync(&stream)?, Some(Duration::from_secs(60)))?.ok_or_else(|| windows::core::Error::from_hresult(E_INVALIDARG))
}

/// The dialog while it's up. Opened on the window's own thread (Windows refuses it from any
/// other with E_INVALIDARG), waited for on a worker, and let go of on the window's thread.
pub struct Dialog {
    manager: PrintManager,
    token: i64,
    op: IAsyncOperation<bool>,
    requested: Receiver<()>,
    finished: Receiver<PrintTaskCompletion>,
}

// The operation is agile; the manager is only touched again in `close`, on the thread that made it.
unsafe impl Send for Dialog {}

/// Opens Windows' print dialog over `hwnd` for this PDF (and its landscape copy, if any). On the
/// thread that owns the window. Err is the word for the caller: `invalid` or `unavailable`.
pub fn show(hwnd: &[u8], data: Vec<u8>, landscape: Option<Vec<u8>>, title: String) -> Result<Dialog, &'static str> {
    let Some(window) = window_from(hwnd) else { return Err("invalid") };
    let portrait = Arc::new(Mutex::new(Document { data: Some(data), painter: None }));
    let landscape = landscape.map(|data| Arc::new(Mutex::new(Document { data: Some(data), painter: None })));
    let source: IPrintDocumentSource = Source {
        portrait: portrait.clone(),
        landscape: landscape.clone(),
        preview: Mutex::new(Preview { target: None, options: None, document: None, pages: Vec::new(), current: 1 }),
    }
    .into();
    // Loads the PDFs while the dialog comes up.
    let _ = thread::Builder::new().name("print-load".into()).spawn(move || {
        let initialised = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }.is_ok();
        for document in std::iter::once(portrait).chain(landscape) {
            if let Ok(mut document) = document.lock() {
                let _ = document.painter();
            }
        }
        if initialised {
            unsafe { CoUninitialize() };
        }
    });

    let interop = factory::<PrintManager, IPrintManagerInterop>().map_err(|error| {
        trace("interop", error);
        "unavailable"
    })?;
    let manager = unsafe { interop.GetForWindow::<PrintManager>(window) }.map_err(|error| {
        trace("GetForWindow", error);
        "unavailable"
    })?;

    let (done, finished) = channel::<PrintTaskCompletion>();
    let (asked, requested) = channel::<()>();
    let title = HSTRING::from(title);
    let handler = {
        let source = Shared(source);
        let done: Mutex<Sender<PrintTaskCompletion>> = Mutex::new(done);
        let asked: Mutex<Sender<()>> = Mutex::new(asked);
        TypedEventHandler::<PrintManager, PrintTaskRequestedEventArgs>::new(move |_, args| {
            let Some(args) = args.as_ref() else { return Ok(()) };
            trace("task requested", ());
            let request = args.Request()?;
            let source = source.clone();
            let task: PrintTask = request.CreatePrintTask(
                &title,
                &PrintTaskSourceRequestedHandler::new(move |args: Ref<PrintTaskSourceRequestedArgs>| {
                    if let Some(args) = args.as_ref() {
                        args.SetSource(source.get())?;
                    }
                    Ok(())
                }),
            )?;
            let options = task.Options()?;
            let shown = options.DisplayedOptions()?;
            for option in [
                StandardPrintTaskOptions::Copies()?,
                StandardPrintTaskOptions::Orientation()?,
                StandardPrintTaskOptions::MediaSize()?,
                StandardPrintTaskOptions::ColorMode()?,
                StandardPrintTaskOptions::CustomPageRanges()?,
            ] {
                let mut index = 0;
                if !shown.IndexOf(&option, &mut index).unwrap_or(false) {
                    let _ = shown.Append(&option);
                }
            }
            let ranges = options.PageRangeOptions()?;
            ranges.SetAllowAllPages(true)?;
            ranges.SetAllowCustomSetOfPages(true)?;
            ranges.SetAllowCurrentPage(false)?;
            let done = done.lock().map(|sender| sender.clone()).ok();
            task.Completed(&TypedEventHandler::<PrintTask, PrintTaskCompletedEventArgs>::new(move |_, args| {
                if let (Some(args), Some(done)) = (args.as_ref(), done.as_ref()) {
                    let _ = done.send(args.Completion()?);
                }
                Ok(())
            }))?;
            if let Ok(asked) = asked.lock() {
                let _ = asked.send(());
            }
            Ok(())
        })
    };
    let token = manager.PrintTaskRequested(&handler).map_err(|error| {
        trace("PrintTaskRequested", error);
        "unavailable"
    })?;
    match unsafe { interop.ShowPrintUIForWindowAsync::<IAsyncOperation<bool>>(window) } {
        Ok(op) => Ok(Dialog { manager, token, op, requested, finished }),
        Err(error) => {
            trace("ShowPrintUIForWindowAsync", error);
            let _ = manager.RemovePrintTaskRequested(token);
            Err("unavailable")
        }
    }
}

impl Dialog {
    /// Until the dialog is closed and a job, if any, is with the spooler: `printed`,
    /// `cancelled`, `failed` or `unavailable` (the dialog never came: the caller uses its own).
    pub fn wait(&self) -> &'static str {
        // Up until the user closes it: no time limit.
        let shown = wait_for(&self.op, None);
        trace("shown", &shown);
        if self.requested.try_recv().is_err() {
            return if matches!(shown, Ok(Some(true))) { "failed" } else { "unavailable" };
        }
        let completion = self.finished.recv_timeout(JOB_WAIT);
        trace("completion", &completion);
        match completion {
            Ok(PrintTaskCompletion::Submitted) => "printed",
            Ok(PrintTaskCompletion::Failed) => "failed",
            Ok(_) => "cancelled",
            // Closed without a word from the task: nothing was printed.
            Err(_) if !matches!(shown, Ok(Some(true))) => "cancelled",
            Err(_) => "failed",
        }
    }

    /// On the window's thread again.
    pub fn close(self) {
        let _ = self.manager.RemovePrintTaskRequested(self.token);
    }
}
