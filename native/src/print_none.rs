//! Off Windows there's no print dialog of the system's to show pages in: main keeps its own.

pub struct Dialog;

pub fn show(_hwnd: &[u8], _data: Vec<u8>, _landscape: Option<Vec<u8>>, _title: String) -> Result<Dialog, &'static str> {
    Err("unavailable")
}

impl Dialog {
    pub fn wait(&self) -> &'static str {
        "unavailable"
    }

    pub fn close(self) {}
}
