// The Agent Frontdesk window, as a native program: a frameless WebView2 window that loads the
// console the local server serves (the packaged `Agent Frontdesk.exe`, or the Node build). The
// title bar is the page's own (js/wco.ts draws it under data-wco="1"); this shell supplies the
// window actions over wry's IPC and the edge hit-testing for resizing, after wry's own
// custom_titlebar example. Built with `cargo build --release` in shell/; the exe goes to the
// project root so start-frontdesk.vbs finds it.
use image::GenericImageView;
use tao::{
    dpi::PhysicalSize,
    event::{Event, WindowEvent},
    event_loop::{ControlFlow, EventLoopBuilder},
    window::{CursorIcon, Icon, ResizeDirection, Window, WindowBuilder},
};
use wry::{WebViewBuilder, WebViewBuilderExtWindows, http::Request};

const URL: &str = "http://127.0.0.1:4100";
const LOGO: &[u8] = include_bytes!("../../src/client/public/assets/logo/logo-512.png");

#[derive(Debug)]
enum HitTestResult {
    Client,
    Left,
    Right,
    Top,
    Bottom,
    TopLeft,
    TopRight,
    BottomLeft,
    BottomRight,
    NoWhere,
}

impl HitTestResult {
    fn drag_resize_window(&self, window: &Window) {
        let _ = window.drag_resize_window(match self {
            HitTestResult::Left => ResizeDirection::West,
            HitTestResult::Right => ResizeDirection::East,
            HitTestResult::Top => ResizeDirection::North,
            HitTestResult::Bottom => ResizeDirection::South,
            HitTestResult::TopLeft => ResizeDirection::NorthWest,
            HitTestResult::TopRight => ResizeDirection::NorthEast,
            HitTestResult::BottomLeft => ResizeDirection::SouthWest,
            HitTestResult::BottomRight => ResizeDirection::SouthEast,
            _ => unreachable!(),
        });
    }

    fn change_cursor(&self, window: &Window) {
        window.set_cursor_icon(match self {
            HitTestResult::Left => CursorIcon::WResize,
            HitTestResult::Right => CursorIcon::EResize,
            HitTestResult::Top => CursorIcon::NResize,
            HitTestResult::Bottom => CursorIcon::SResize,
            HitTestResult::TopLeft => CursorIcon::NwResize,
            HitTestResult::TopRight => CursorIcon::NeResize,
            HitTestResult::BottomLeft => CursorIcon::SwResize,
            HitTestResult::BottomRight => CursorIcon::SeResize,
            _ => CursorIcon::Default,
        });
    }
}

// Where on the frameless window the edges begin (resize handles, wry's example).
fn hit_test(window_size: PhysicalSize<u32>, x: i32, y: i32, scale: f64) -> HitTestResult {
    const INSET: f64 = 5.0;
    const CLIENT: isize = 0b0000;
    const LEFT: isize = 0b0001;
    const RIGHT: isize = 0b0010;
    const TOP: isize = 0b0100;
    const BOTTOM: isize = 0b1000;
    const TOPLEFT: isize = TOP | LEFT;
    const TOPRIGHT: isize = TOP | RIGHT;
    const BOTTOMLEFT: isize = BOTTOM | LEFT;
    const BOTTOMRIGHT: isize = BOTTOM | RIGHT;
    let (top, left) = (0, 0);
    let bottom = top + window_size.height as i32;
    let right = left + window_size.width as i32;
    let inset = (INSET * scale) as i32;
    #[rustfmt::skip]
    let result =
          (LEFT * (if x < (left + inset) { 1 } else { 0 }))
        | (RIGHT * (if x >= (right - inset) { 1 } else { 0 }))
        | (TOP * (if y < (top + inset) { 1 } else { 0 }))
        | (BOTTOM * (if y >= (bottom - inset) { 1 } else { 0 }));
    match result {
        CLIENT => HitTestResult::Client,
        LEFT => HitTestResult::Left,
        RIGHT => HitTestResult::Right,
        TOP => HitTestResult::Top,
        BOTTOM => HitTestResult::Bottom,
        TOPLEFT => HitTestResult::TopLeft,
        TOPRIGHT => HitTestResult::TopRight,
        BOTTOMLEFT => HitTestResult::BottomLeft,
        BOTTOMRIGHT => HitTestResult::BottomRight,
        _ => HitTestResult::NoWhere,
    }
}

#[derive(Debug)]
enum UserEvent {
    Minimize,
    Maximize,
    DragWindow,
    CloseWindow,
    MouseDown(i32, i32),
    MouseMove(i32, i32),
}

fn icon() -> Option<Icon> {
    let img = image::load_from_memory(LOGO).ok()?.to_rgba8();
    let (w, h) = img.dimensions();
    Icon::from_rgba(img.into_raw(), w, h).ok()
}

// The page lives behind the local server; give it a moment rather than showing an error page.
fn wait_for_server() {
    use std::net::{TcpStream, SocketAddr};
    use std::time::Duration;
    let addr: SocketAddr = "127.0.0.1:4100".parse().unwrap();
    for _ in 0..60 {
        if TcpStream::connect_timeout(&addr, Duration::from_millis(400)).is_ok() { return; }
        std::thread::sleep(Duration::from_millis(500));
    }
}

fn main() -> wry::Result<()> {
    let event_loop = EventLoopBuilder::<UserEvent>::with_user_event().build();
    let window = WindowBuilder::new()
        .with_title("Agent Frontdesk")
        .with_inner_size(PhysicalSize::new(1560, 1024))
        .with_decorations(false)
        .with_resizable(true)
        .with_window_icon(icon())
        .build(&event_loop)
        .unwrap();

    wait_for_server();

    let proxy = event_loop.create_proxy();
    let handler = move |req: Request<String>| {
        match req.body().as_str() {
            "minimize" => { let _ = proxy.send_event(UserEvent::Minimize); }
            "maximize" => { let _ = proxy.send_event(UserEvent::Maximize); }
            "drag_window" => { let _ = proxy.send_event(UserEvent::DragWindow); }
            "close" => { let _ = proxy.send_event(UserEvent::CloseWindow); }
            other => {
                let mut parts = other.split([':', ',']);
                match (parts.next().unwrap(), parts.next(), parts.next()) {
                    ("mousedown", Some(x), Some(y)) => {
                        let _ = proxy.send_event(UserEvent::MouseDown(x.parse().unwrap(), y.parse().unwrap()));
                    }
                    ("mousemove", Some(x), Some(y)) => {
                        let _ = proxy.send_event(UserEvent::MouseMove(x.parse().unwrap(), y.parse().unwrap()));
                    }
                    _ => {}
                }
            }
        }
    };

    // Browser data lives beside the other local caches, not next to the exe.
    let data_dir = std::env::var("LOCALAPPDATA").ok()
        .map(|local| std::path::PathBuf::from(local).join("agent-frontdesk").join("webview"));
    let mut context = wry::WebContext::new(data_dir);
    let webview = WebViewBuilder::new_with_web_context(&mut context)
        .with_url(URL)
        .with_ipc_handler(handler)
        .with_accept_first_mouse(true)
        .with_initialization_script("window.__fdShell = true;")
        .build(&window)?;

    let mut webview = Some(webview);

    event_loop.run(move |event, _, control_flow| {
        *control_flow = ControlFlow::Wait;
        match event {
            Event::WindowEvent { event: WindowEvent::CloseRequested, .. }
            | Event::UserEvent(UserEvent::CloseWindow) => {
                let _ = webview.take();
                *control_flow = ControlFlow::Exit;
            }
            Event::UserEvent(UserEvent::Minimize) => window.set_minimized(true),
            Event::UserEvent(UserEvent::Maximize) => window.set_maximized(!window.is_maximized()),
            Event::UserEvent(UserEvent::DragWindow) => { let _ = window.drag_window(); }
            Event::UserEvent(UserEvent::MouseDown(x, y)) => {
                let res = hit_test(window.inner_size(), x, y, window.scale_factor());
                match res {
                    HitTestResult::Client | HitTestResult::NoWhere => {}
                    _ => res.drag_resize_window(&window),
                }
            }
            Event::UserEvent(UserEvent::MouseMove(x, y)) => {
                hit_test(window.inner_size(), x, y, window.scale_factor()).change_cursor(&window);
            }
            _ => (),
        }
    });
}
