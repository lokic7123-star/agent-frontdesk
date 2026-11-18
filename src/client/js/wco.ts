// The console can run as an app window in two ways: as an Edge --app with the manifest's
// window-controls-overlay (the system title bar is gone and the page's top strip is the title
// bar), or in the native shell (shell/, a frameless WebView2 window that marks itself with
// window.__fdShell and speaks over window.ipc). In both, the chat header drags the window and
// three caption buttons act on it. A plain browser tab has neither and none of this runs.
interface OverlayApi {
  visible: boolean;
  getTitlebarAreaRect(): DOMRect;
  addEventListener(type: 'geometrychange', listener: () => void): void;
}
type Ipc = { postMessage: (message: string) => void };
type WindowControls = { minimize?: () => void; maximize?: () => void };
const overlay = (navigator as unknown as { windowControlsOverlay?: OverlayApi }).windowControlsOverlay;
const ipc = (window as unknown as { ipc?: Ipc }).ipc;
const shell = (window as unknown as { __fdShell?: boolean }).__fdShell === true && !!ipc;
if (shell || overlay?.visible) {
  const root = document.documentElement;
  root.dataset.wco = '1';
  if (shell) {
    // The shell owns the window: a fixed title-bar strip and no system caption area.
    root.style.setProperty('--titlebar-h', '40px');
    root.style.setProperty('--caption-w', '0px');
    // The shell also edge-hits the frameless window for resizing, so it needs the pointer.
    document.addEventListener('mousedown', event => {
      ipc!.postMessage(`mousedown:${event.clientX},${event.clientY}`);
      const onTitlebar = (event.target as HTMLElement).closest('.chat-header, .control-brand');
      if (onTitlebar && event.button === 0 && !(event.target as HTMLElement).closest('button, a, input, select, .wco-buttons')) {
        event.detail === 2 ? ipc!.postMessage('maximize') : ipc!.postMessage('drag_window');
      }
    });
    document.addEventListener('mousemove', event => ipc!.postMessage(`mousemove:${event.clientX},${event.clientY}`));
  } else {
    const paint = () => {
      const rect = overlay!.getTitlebarAreaRect();
      root.style.setProperty('--titlebar-h', `${Math.max(rect.height, 32)}px`);
      root.style.setProperty('--caption-w', `${Math.max(innerWidth - rect.x - rect.width, 0)}px`);
    };
    paint();
    overlay!.addEventListener('geometrychange', paint);
  }
  const acts: Array<[string, () => void]> = [
    ['wco-min', () => shell ? ipc!.postMessage('minimize') : (window as unknown as WindowControls).minimize?.()],
    ['wco-max', () => {
      if (shell) { ipc!.postMessage('maximize'); return; }
      try { const maximize = (window as unknown as WindowControls).maximize; if (typeof maximize === 'function') { maximize(); return; } } catch { /* fall through */ }
      if (document.fullscreenElement) void document.exitFullscreen();
      else void document.documentElement.requestFullscreen();
    }],
    ['wco-close', () => shell ? ipc!.postMessage('close') : window.close()],
  ];
  for (const [id, action] of acts) document.getElementById(id)?.addEventListener('click', action);
}
