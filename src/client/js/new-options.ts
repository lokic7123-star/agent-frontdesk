// A new chat's first message is sent by the desktop app's own "New session" page. What that page
// asks for first (an environment, then a folder, a worktree toggle…) is read live from the
// desktop and shown here as cards, one at a time: pick an option and the desktop picks it, then
// answers with what its page asks for next. Nothing here knows an engine's controls by name;
// the engine's adapter reports them ({ kind: 'menu'|'toggle', label, value, options }). Reading a
// menu's options means opening it in the desktop (about a second), so a menu comes without
// `options` until its card is about to be shown, and is read then.
//
// What was read and chosen is kept per engine: asking for a new chat again (after looking at
// another chat, or another engine) shows it at once, as it was left, while the desktop's page is
// read once more in the background; a control whose value changed there since comes up again as
// a card. What is shown as chosen goes out with the first message (`expect`), so the desktop
// checks its page against it before sending. A state older than KEEP_MS is read anew instead.
import { t, say } from './i18n.js';
import { escape, icon } from './renderers.js';
import { messageOf } from '../../shared/guards.js';
import type { DesktopSettings, NewControl, NewFolder, NewOption, NewOptionsResult } from '../../shared/contract.js';

const TOGGLE = [['on', '开'], ['off', '关']] as const;
const KEEP_MS = 10 * 60_000;
// A menu's options are shown from the last read for this long (one round of choosing); after
// that its card reads them again, so a list the desktop has added to since is seen.
const OPTIONS_MS = 60_000;
/** One engine's page as the console last had it (see NewOptions.open). */
interface Kept { controls: NewControl[] | null; settings: DesktopSettings | null; settled: Map<string, string>; error: string; at: number }
const basename = (path: unknown): string => String(path || '').split(/[\\/]/).filter(Boolean).at(-1) || '';

/** Where a project's "+" asks the new chat to go (see aim). */
export interface NewTarget extends NewFolder { engine: string; id?: string; name?: string; cwd: string }
/** The server's answer to /api/new-options (an error answer may carry the controls too). */
type OptionsAnswer = Partial<NewOptionsResult> & { error?: string };
/** A failed request, with the controls and picks the server still sent. */
class OptionsError extends Error { controls?: NewControl[] | undefined; picked?: string[] | undefined }
const controlsOf = (err: unknown) => err instanceof OptionsError ? err.controls : undefined;
const pickedOf = (err: unknown) => err instanceof OptionsError ? err.picked : undefined;

export class NewOptions {
  onChange: () => void; seq = 0; target: NewTarget | null = null;
  engine: string | null = null; controls: NewControl[] | null = null; error = ''; busy = ''; editing = '';
  settings: DesktopSettings | null = null; settled = new Map<string, string>();
  // When the controls were last read from the desktop; each engine's state while another is shown.
  at = 0; kept = new Map<string, Kept>(); changes = 0;
  // The background check that is still out (refresh), and when each menu's options were read.
  checking: Promise<void> | null = null; optionsAt = new Map<string, number>();
  constructor({ onChange = () => {} }: { onChange?: () => void } = {}) { this.onChange = onChange; this.reset(null); }
  reset(engine: string | null): void {
    this.engine = engine; this.controls = null; this.error = ''; this.busy = ''; this.editing = '';
    // { model, effort, permissionMode }: what the desktop's page shows in its own model and
    // permission menus, when the engine reports it; null until read.
    this.settings = null;
    // label → the value the person settled on; a control counts as done while it still shows it.
    this.settled = new Map(); this.at = 0;
    if (engine) this.kept.delete(engine);
    this.seq++;
  }
  // A new chat is asked for with this engine. What the console already has for it is shown as it
  // was left and checked against the desktop in the background; it is read first (with the
  // spinner) only when there is nothing to show, it is old, or a project's folder is to be picked.
  open(engine: string): void {
    if (this.engine !== engine) {
      if (this.engine && this.controls && !this.busy) this.kept.set(this.engine, { controls: this.controls, settings: this.settings, settled: this.settled, error: this.error, at: this.at });
      const back = this.kept.get(engine);
      this.seq++; this.busy = ''; this.editing = '';
      this.engine = engine; this.controls = back?.controls ?? null; this.settings = back?.settings ?? null; this.settled = back?.settled ?? new Map(); this.error = back?.error ?? ''; this.at = back?.at ?? 0;
    }
    if (this.busy) return;
    if (this.aiming || !this.controls || this.error || Date.now() - this.at > KEEP_MS) { void this.load(engine); return; }
    this.editing = ''; this.onChange();
    void this.refresh();
  }
  // The page read again without the cards going away; a pick made meanwhile wins over the answer.
  // When the desktop cannot be read the cards stay, with the reason under them: they are then
  // what was read before, not what the desktop shows now.
  refresh(): Promise<void> {
    const engine = this.engine;
    if (!engine || this.busy) return Promise.resolve();
    const seq = this.seq, changes = this.changes;
    const current = () => seq === this.seq && changes === this.changes && !this.busy;
    // The page's answer (the part the first message waits for), then the card it brings up.
    const read = async (): Promise<boolean> => {
      try {
        const data = await this.call(`/api/new-options/${encodeURIComponent(engine)}`);
        if (!current()) return false;
        this.take(data.controls); this.at = Date.now(); this.error = '';
        this.onChange();
        return true;
      } catch (err) {
        if (current()) { this.error = messageOf(err); this.onChange(); }
        return false;
      }
    };
    const answer = read();
    const check: Promise<void> = answer.then(() => { if (this.checking === check) this.checking = null; });
    this.checking = check;
    return answer.then(ok => (ok ? this.readCurrent() : undefined));
  }
  // Resolves once the check that is out has answered (or after `ms`): the first message waits for
  // it, so it goes out with what the desktop's page shows now, not with what was read last time.
  checked(ms = 4000): Promise<void> {
    const check = this.checking;
    return check ? Promise.race([check.catch(() => {}), new Promise<void>(resolve => setTimeout(resolve, ms))]) : Promise.resolve();
  }
  // The person asked to read the desktop again: nothing is answered from an earlier read.
  reload(): void { if (this.engine && !this.busy) void this.load(this.engine, { fresh: true }); }
  // The first message went out with these choices: they stay for the next new chat.
  sent(): void { this.target = null; this.editing = ''; this.error = ''; }
  // What is shown as chosen, in the page's order, for the first message to be checked against.
  expect(): Array<{ control: string; option: string }> {
    return (this.controls || []).filter(item => this.done(item)).map(item => ({ control: item.label, option: item.value }));
  }
  // A chat started from a project's "+": the folder the desktop's page should show, and how the
  // engine's page gets there (its newFolder capability, in the desktop's own names):
  //   { engine, id, name, cwd, control: 'Folder', via?: { control: 'Environment', option: 'This computer' } }
  // Both picks are made in one visit to the page, instead of reading it first; a pick that is
  // already in place costs nothing there. Picking something else on those controls by hand drops
  // the target, and the chat goes where the page then says.
  aim(target: NewTarget | null | undefined): void { this.target = target?.cwd ? target : null; }
  get aiming(): boolean { return !!this.target && this.target.engine === this.engine; }
  done(control: NewControl): boolean { return this.settled.get(control.label) === control.value; }
  get current(): NewControl | null {
    if (!this.controls) return null;
    return this.controls.find(item => item.label === this.editing) || this.controls.find(item => !this.done(item)) || null;
  }
  // The answer is JSON the server wrote from the contract's NewOptionsResult (trust boundary, as in api.ts).
  async call(url: string, options?: { method: string; body: string }): Promise<OptionsAnswer> {
    const seq = this.seq;
    const response = await fetch(url, { ...options, headers: options?.body ? { 'Content-Type': 'application/json' } : undefined });
    const data: OptionsAnswer = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new OptionsError(say(data.error) || `Request failed (${response.status})`), { controls: data.controls, picked: data.picked });
    if (data.settings && seq === this.seq) this.settings = data.settings;
    return data;
  }
  // New controls keep the options already read for a menu whose value did not change, while
  // that read is recent (OPTIONS_MS).
  take(controls: NewControl[] | null | undefined): void {
    const before = new Map((this.controls || []).map(item => [item.label, item])), now = Date.now();
    this.controls = (controls || []).map(item => {
      if (item.kind !== 'menu') return item;
      if (item.options) { this.optionsAt.set(item.label, now); return item; }
      const old = before.get(item.label);
      return old?.options && old.value === item.value && now - (this.optionsAt.get(item.label) || 0) < OPTIONS_MS ? { ...item, options: old.options } : item;
    });
  }
  settle(labels: string[] = []): void {
    for (const label of labels) { const now = this.controls?.find(item => item.label === label); if (now) this.settled.set(label, now.value); }
  }
  async load(engine: string, { fresh = false }: { fresh?: boolean } = {}): Promise<void> {
    this.reset(engine);
    const seq = this.seq;
    this.busy = 'load'; this.onChange();
    try {
      const want = this.aiming ? this.target : null;
      if (want) {
        const picks = [...(want.via ? [{ control: want.via.control, option: want.via.option }] : []), { control: want.control, option: want.cwd }];
        try {
          const data = await this.call(`/api/new-options/${encodeURIComponent(engine)}`, { method: 'POST', body: JSON.stringify({ picks }) });
          if (seq !== this.seq) return;
          this.take(data.controls); this.settle(data.picked); this.at = Date.now();
        } catch (err) {
          if (seq !== this.seq) return;
          this.error = messageOf(err); this.take(controlsOf(err) || []); this.settle(pickedOf(err));
        }
      } else {
        const data = await this.call(`/api/new-options/${encodeURIComponent(engine)}${fresh ? '?fresh=1' : ''}`);
        if (seq !== this.seq) return;
        this.take(data.controls); this.at = Date.now();
      }
    } catch (err) { if (seq === this.seq) { this.controls = []; this.error = messageOf(err); } }
    finally { if (seq === this.seq) { this.busy = ''; this.onChange(); } }
    if (seq === this.seq) await this.readCurrent();
  }
  // The card about to be shown is a menu not read yet: read just that one.
  async readCurrent(): Promise<void> {
    const current = this.current, engine = this.engine;
    if (!current || current.kind !== 'menu' || current.options || this.busy || engine === null) return;
    const seq = this.seq;
    this.busy = 'read'; this.onChange();
    try {
      const data = await this.call(`/api/new-options/${encodeURIComponent(engine)}?read=${encodeURIComponent(current.label)}`);
      if (seq !== this.seq) return;
      this.take(data.controls);
      const now = this.controls?.find(item => item.label === current.label);
      if (now?.kind === 'menu' && !now.options) now.options = [];
    } catch (err) { if (seq === this.seq) this.error = messageOf(err); }
    finally { if (seq === this.seq) { this.busy = ''; this.onChange(); } }
  }
  async pick(label: string, option: string): Promise<void> {
    const engine = this.engine;
    if (this.busy || !engine) return;
    if (this.target && (label === this.target.control || label === this.target.via?.control)) this.target = null;
    const seq = this.seq;
    this.changes++;
    this.busy = label; this.error = ''; this.onChange();
    try {
      const data = await this.call(`/api/new-options/${encodeURIComponent(engine)}`, { method: 'POST', body: JSON.stringify({ control: label, option }) });
      if (seq !== this.seq) return;
      this.take(data.controls); this.settle([label]); this.at = Date.now();
      this.editing = '';
    } catch (err) {
      if (seq !== this.seq) return;
      this.error = messageOf(err);
      const controls = controlsOf(err);
      if (controls) this.take(controls);
    } finally { if (seq === this.seq) { this.busy = ''; this.onChange(); } }
    if (seq === this.seq) await this.readCurrent();
  }
  edit(label: string): void {
    if (this.busy) return;
    // A menu read a while ago is read again before it is chosen from.
    const control = this.controls?.find(item => item.label === label);
    if (control?.kind === 'menu' && control.options && Date.now() - (this.optionsAt.get(label) || 0) >= OPTIONS_MS) delete control.options;
    this.editing = label; this.error = ''; this.onChange(); this.readCurrent();
  }
  html(appName: string): string {
    if (!this.engine) return '';
    if (this.busy === 'load' && this.aiming) return `<div class="new-options">${this.aimed()}<p class="new-options-status"><span class="activity-spinner" aria-hidden="true"></span>${escape(t('正在桌面版里选好这个项目…'))}</p></div>`;
    if (this.busy === 'load') return `<div class="new-options">${this.aimed()}<p class="new-options-status"><span class="activity-spinner" aria-hidden="true"></span>${escape(t('正在读取 {name} 的新建页…', { name: appName }))}</p></div>`;
    const controls = this.controls || [], current = this.current;
    const chips = controls.filter(item => item !== current && this.done(item)).map(item => `<button type="button" class="new-option-chip" data-new-edit="${escape(item.label)}" title="${escape(t('改这一项'))}"><span>${escape(item.label)}</span><strong>${escape(this.shown(item))}</strong>${icon('pencil')}</button>`).join('');
    const error = this.error ? `<p class="new-options-error" role="alert">${escape(this.error)}</p>` : '';
    const reload = `<button type="button" class="new-options-reload" data-new-reload title="${escape(t('从桌面版重新读取'))}" ${this.busy ? 'disabled' : ''}>${icon('refresh-cw')}</button>`;
    if (!controls.length) return error ? `<div class="new-options">${error}${reload}</div>` : '';
    const step = current ? controls.filter(item => this.done(item) && item !== current).length + 1 : 0;
    // "Read again" sits in the card's own head, or beside the line that says everything is picked.
    const card = current ? this.card(current, step, reload) : `<p class="new-options-ready">${icon('check')}<span>${escape(t('都选好了，在下面输入第一条消息。'))}</span>${reload}</p>`;
    return `<div class="new-options">${this.aimed()}${chips ? `<div class="new-option-chips">${chips}</div>` : ''}${card}${error}</div>`;
  }
  aimed(): string {
    const want = this.aiming ? this.target : null;
    return want ? `<p class="new-options-aim">${icon('folder')}<span>${escape(t('新聊天会放在项目「{name}」', { name: want.name || basename(want.cwd) }))}</span></p>` : '';
  }
  shown(control: NewControl): string {
    if (control.kind === 'toggle') return t(control.value === 'on' ? '开' : '关');
    return /[\\/]/.test(control.value) ? control.value.split(/[\\/]/).filter(Boolean).at(-1) || control.value : control.value;
  }
  card(control: NewControl, step: number, reload = ''): string {
    const busy = this.busy === control.label;
    const options = control.kind === 'toggle'
      ? TOGGLE.map(([value, text]): NewOption & { text: string } => ({ label: value, text: t(text), section: '', selected: control.value === value }))
      : (control.options || []).map(option => ({ ...option, text: option.label }));
    let section: string | null | undefined = null, rows = '';
    for (const option of options) {
      if (option.section !== section) { section = option.section; if (section) rows += `<p class="new-option-section">${escape(section)}</p>`; }
      rows += `<button type="button" class="new-option${option.selected ? ' is-selected' : ''}" data-new-control="${escape(control.label)}" data-new-option="${escape(option.label)}" ${this.busy ? 'disabled' : ''} aria-pressed="${option.selected}"><span>${escape(option.text)}</span>${option.selected ? icon('check') : ''}</button>`;
    }
    if (control.kind === 'menu' && !control.options) rows = `<p class="new-options-status"><span class="activity-spinner" aria-hidden="true"></span>${escape(t('正在读取桌面版的选项…'))}</p>`;
    else if (!options.length) rows = `<p class="new-option-section">${escape(t('桌面版没有列出可选项'))}</p>`;
    return `<section class="new-option-card" aria-label="${escape(control.label)}">
      <header><span class="new-option-step">${escape(t('第 {n} 步', { n: step }))}</span><h3>${escape(control.label)}</h3><span class="new-option-current">${escape(t('现在是 {value}', { value: this.shown(control) }))}</span>${reload}</header>
      <div class="new-option-list">${rows}</div>
      ${busy ? `<p class="new-options-status"><span class="activity-spinner" aria-hidden="true"></span>${escape(t('正在桌面版里选…'))}</p>` : ''}
    </section>`;
  }
}
