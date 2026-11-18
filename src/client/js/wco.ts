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
const root = document.documentElement;
const overlay = (navigator as unknown as { windowControlsOverlay?: OverlayApi }).windowControlsOverlay;
const ipc = (window as unknown as { ipc?: Ipc }).ipc;
const shell = (window as unknown as { __fdShell?: boolean }).__fdShell === true && !!ipc;
// The overlay may only become visible after this module ran (or flip on maximize), so the
// geometry and the flag are re-evaluated on every change rather than decided once.
const paint = () => {
  if (shell) {
    root.dataset.wco = '1';
    root.dataset.wcoShell = '1';
    // The shell owns the window: a fixed title-bar strip and no system caption area.
    root.style.setProperty('--titlebar-h', '40px');
    root.style.setProperty('--caption-w', '0px');
  } else if (overlay?.visible) {
    root.dataset.wco = '1';
    delete root.dataset.wcoShell;
    const rect = overlay.getTitlebarAreaRect();
    root.style.setProperty('--titlebar-h', `${Math.max(rect.height, 32)}px`);
    root.style.setProperty('--caption-w', `${Math.max(innerWidth - rect.x - rect.width, 0)}px`);
  } else {
    delete root.dataset.wco;
    delete root.dataset.wcoShell;
  }
};
paint();
overlay?.addEventListener('geometrychange', paint);

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
// Bound up front: the buttons exist in the document from the start, and the handlers are
// harmless while the strip is display:none (a plain browser tab).
for (const [id, action] of acts) document.getElementById(id)?.addEventListener('click', action);

if (shell) {
  // The shell edge-hits the frameless window for resizing, so it needs the pointer: every press
  // away from the title bar and the caption strip reports its coordinates, a press on the title
  // bar itself asks for drag or double-click maximize instead (the two are mutually exclusive,
  // as a drag press entering the edge modal loop would swallow the queued drag).
  const interactive = 'button, a, input, select, .wco-buttons';
  document.addEventListener('mousedown', event => {
    const target = event.target as HTMLElement;
    if (target.closest(interactive)) return;
    const onTitlebar = !!target.closest('.chat-header, .control-brand');
    if (onTitlebar && event.button === 0) {
      event.detail === 2 ? ipc!.postMessage('maximize') : ipc!.postMessage('drag_window');
      return;
    }
    if (event.button === 0) ipc!.postMessage(`mousedown:${event.clientX},${event.clientY}`);
  });
  document.addEventListener('mousemove', event => ipc!.postMessage(`mousemove:${event.clientX},${event.clientY}`));
}
