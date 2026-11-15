#[tauri::command]
pub fn system_locale() -> Option<String> {
    #[cfg(target_os = "windows")]
    {
        windows_locale()
    }
    #[cfg(not(target_os = "windows"))]
    {
        ["LC_ALL", "LC_MESSAGES", "LANG"]
            .iter()
            .filter_map(|key| std::env::var(key).ok())
            .find(|tag| !tag.is_empty())
            .map(|tag| {
                tag.split(['.', '@'])
                    .next()
                    .unwrap_or_default()
                    .replace('_', "-")
            })
    }
}

#[cfg(target_os = "windows")]
fn windows_locale() -> Option<String> {
    #[link(name = "kernel32")]
    extern "system" {
        fn GetUserPreferredUILanguages(
            flags: u32,
            languages: *mut u32,
            buffer: *mut u16,
            size: *mut u32,
        ) -> i32;
    }

    const MUI_LANGUAGE_NAME: u32 = 0x8;
    let mut count = 0;
    let mut size = 0;
    // A null buffer queries the size of the UTF-16 multi-string.
    if unsafe {
        GetUserPreferredUILanguages(
            MUI_LANGUAGE_NAME,
            &mut count,
            std::ptr::null_mut(),
            &mut size,
        )
    } == 0
        || size == 0
    {
        return None;
    }
    let mut buffer = vec![0_u16; size as usize];
    if unsafe {
        GetUserPreferredUILanguages(
            MUI_LANGUAGE_NAME,
            &mut count,
            buffer.as_mut_ptr(),
            &mut size,
        )
    } == 0
    {
        return None;
    }
    let first = buffer.split(|&character| character == 0).next()?;
    String::from_utf16(first)
        .ok()
        .filter(|locale| !locale.is_empty())
}
