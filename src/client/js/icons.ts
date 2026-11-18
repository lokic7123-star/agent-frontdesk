// The icons the page draws. lucide has some three thousand, and its entry module carries all of
// them with it, so the page imports each icon it uses from that icon's own file, and lucide's
// function that puts one in the place of its <i data-lucide> placeholder. The names are the ones
// written in the page's sources as icon('…') and data-lucide="…"; a test checks that each of those
// is here. A name that is not (one a skin or a plugin's module asks for) is still drawn: the whole
// set is fetched then, once, as a chunk of its own.
import replaceElement from 'lucide/dist/esm/replaceElement.js';
import AppWindow from 'lucide/dist/esm/icons/app-window.js';
import ArrowDown from 'lucide/dist/esm/icons/arrow-down.js';
import ArrowUp from 'lucide/dist/esm/icons/arrow-up.js';
import ArrowUpRight from 'lucide/dist/esm/icons/arrow-up-right.js';
import BookOpen from 'lucide/dist/esm/icons/book-open.js';
import Check from 'lucide/dist/esm/icons/check.js';
import ChevronDown from 'lucide/dist/esm/icons/chevron-down.js';
import ChevronRight from 'lucide/dist/esm/icons/chevron-right.js';
import ChevronsRight from 'lucide/dist/esm/icons/chevrons-right.js';
import CircleAlert from 'lucide/dist/esm/icons/circle-alert.js';
import CircleStop from 'lucide/dist/esm/icons/circle-stop.js';
import Code from 'lucide/dist/esm/icons/code.js';
import Copy from 'lucide/dist/esm/icons/copy.js';
import Download from 'lucide/dist/esm/icons/download.js';
import Ellipsis from 'lucide/dist/esm/icons/ellipsis.js';
import ExternalLink from 'lucide/dist/esm/icons/external-link.js';
import File from 'lucide/dist/esm/icons/file.js';
import FileCheck2 from 'lucide/dist/esm/icons/file-check-2.js';
import FileText from 'lucide/dist/esm/icons/file-text.js';
import Folder from 'lucide/dist/esm/icons/folder.js';
import FolderOpen from 'lucide/dist/esm/icons/folder-open.js';
import FolderSearch from 'lucide/dist/esm/icons/folder-search.js';
import GripVertical from 'lucide/dist/esm/icons/grip-vertical.js';
import Info from 'lucide/dist/esm/icons/info.js';
import ListChecks from 'lucide/dist/esm/icons/list-checks.js';
import ListPlus from 'lucide/dist/esm/icons/list-plus.js';
import Mail from 'lucide/dist/esm/icons/mail.js';
import MessagesSquare from 'lucide/dist/esm/icons/messages-square.js';
import Mic from 'lucide/dist/esm/icons/mic.js';
import Minus from 'lucide/dist/esm/icons/minus.js';
import MonitorSmartphone from 'lucide/dist/esm/icons/monitor-smartphone.js';
import PanelLeft from 'lucide/dist/esm/icons/panel-left.js';
import PanelLeftClose from 'lucide/dist/esm/icons/panel-left-close.js';
import PanelRight from 'lucide/dist/esm/icons/panel-right.js';
import Pencil from 'lucide/dist/esm/icons/pencil.js';
import Plus from 'lucide/dist/esm/icons/plus.js';
import RefreshCw from 'lucide/dist/esm/icons/refresh-cw.js';
import ScanLine from 'lucide/dist/esm/icons/scan-line.js';
import Search from 'lucide/dist/esm/icons/search.js';
import Send from 'lucide/dist/esm/icons/send.js';
import Settings from 'lucide/dist/esm/icons/settings.js';
import Square from 'lucide/dist/esm/icons/square.js';
import SquarePen from 'lucide/dist/esm/icons/square-pen.js';
import Terminal from 'lucide/dist/esm/icons/terminal.js';
import Wrench from 'lucide/dist/esm/icons/wrench.js';
import X from 'lucide/dist/esm/icons/x.js';

// By the name lucide gives each icon ("file-check-2" is "FileCheck2"): replaceElement looks them up so.
const drawn: Record<string, unknown> = {
  AppWindow, ArrowDown, ArrowUp, ArrowUpRight, BookOpen, Check, ChevronDown, ChevronRight, ChevronsRight, CircleAlert, CircleStop, Code, Copy,
  Download, Ellipsis, ExternalLink, File, FileCheck2, FileText, Folder, FolderOpen, FolderSearch, GripVertical, Info, ListChecks, ListPlus,
  Mail, MessagesSquare, Mic, Minus, MonitorSmartphone, PanelLeft, PanelLeftClose, PanelRight, Pencil, Plus, RefreshCw, ScanLine, Search, Send,
  Settings, Square, SquarePen, Terminal, Wrench, X,
};
const named = (name: string): string => name.replace(/(\w)(\w*)(_|-|\s*)/g, (_all, first: string, rest: string) => first.toUpperCase() + rest.toLowerCase());
export const hasIcon = (name: string): boolean => named(name) in drawn;
let everything: Promise<void> | null = null, complete = false;
// Draws every <i data-lucide> placeholder in the document. `onMore`: called when the whole set
// has arrived for a name the page's own icons did not have, so the page can draw again.
export function drawIcons(onMore: () => void): void {
  let unknown = false;
  for (const node of document.querySelectorAll('i[data-lucide]')) {
    if (hasIcon(node.getAttribute('data-lucide') || '')) replaceElement(node, { nameAttr: 'data-lucide', icons: drawn, attrs: { 'stroke-width': 1.5 } });
    // A name lucide does not have at all is not asked for again.
    else if (complete) node.removeAttribute('data-lucide');
    else unknown = true;
  }
  if (!unknown || everything) return;
  everything = import('lucide/dist/esm/iconsAndAliases.js').then(module => { Object.assign(drawn, module); complete = true; onMore(); }, () => { everything = null; });
}
