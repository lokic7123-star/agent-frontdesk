import fs from 'node:fs';
import path from 'node:path';
import { bag, get, list, parseJson } from '../../shared/guards.js';

export interface CodexProject { id: string; name: string; roots: string[]; position: number; legacyId: string }
interface DesktopProjects { assignments: Map<string, string>; projectless: Set<unknown>; order: unknown[]; legacy: Map<string, unknown> }

// Which project a Codex thread belongs to, as the Codex desktop app shows it.
// The project list comes from the app-server (project/list). Until the desktop app has moved
// its thread assignments there, they live in its own state file, which is read here (read-only,
// only the project keys below): thread → project, the threads that belong to no project, and
// the order the sidebar lists projects in.
class CodexProjects {
  file: string; stamp: string; state: DesktopProjects;
  constructor({ codexHome }: { codexHome: string }) { this.file = path.join(codexHome, '.codex-global-state.json'); this.stamp = ''; this.state = this.empty(); }
  empty(): DesktopProjects { return { assignments: new Map(), projectless: new Set(), order: [], legacy: new Map() }; }
  desktop(): DesktopProjects {
    try {
      const stat = fs.statSync(this.file), stamp = `${stat.mtimeMs}:${stat.size}`;
      if (stamp === this.stamp) return this.state;
      // The desktop's state file, narrowed key by key (only the project keys are read).
      const raw = bag(parseJson(fs.readFileSync(this.file, 'utf8'))) || {};
      const state = this.empty();
      for (const map of Object.values(bag(raw['app-server-project-id-by-legacy-project-id-by-host']) || {})) for (const [legacy, id] of Object.entries(bag(map) || {})) state.legacy.set(legacy, id);
      for (const [thread, entry] of Object.entries(bag(raw['thread-project-assignments']) || {})) { const projectId = get(entry, 'projectId'); if (projectId) state.assignments.set(thread, String(projectId)); }
      for (const thread of list(raw['projectless-thread-ids'])) state.projectless.add(thread);
      state.order = list(raw['project-order']);
      this.stamp = stamp; this.state = state;
    } catch { /* No desktop app (CLI only), or the file is mid-write: keep what was read last. */ }
    return this.state;
  }
  // rows: project/list data. Returns the projects in the desktop's order and resolve(thread).
  index(rows: unknown[] = []): { projects: CodexProject[]; resolve: (thread: { id: string; projectId?: unknown; cwd?: unknown }) => CodexProject | null | undefined } {
    const desktop = this.desktop();
    const stripTrail = (raw: string): string => {
      if (raw === '/' || /^[a-zA-Z]:[\\/]+$/.test(raw)) return `${raw.slice(0, 2)}${raw[2] === '\\' ? '\\' : '/'}`;
      return raw.replace(/[\\/]+$/, '');
    };
    const normPath = (raw: string): string => {
      const p = raw.replace(/\\/g, '/').replace(/^([A-Z]):/, (_, d: string) => `${d.toLowerCase()}:`);
      const trimmed = p === '/' || /^[a-z]:\/+$/.test(p) ? (p === '/' ? '/' : `${p.slice(0, 2)}/`) : p.replace(/\/+$/, '');
      return process.platform === 'win32' ? trimmed.toLowerCase() : trimmed;
    };
    const projects = rows.filter(row => get(row, 'id')).map((row): CodexProject => ({ id: String(get(row, 'id')), name: String(get(row, 'name') || ''), roots: list(get(row, 'roots')).map(root => stripTrail(String(get(root, 'path') || ''))).filter(Boolean), position: Number(get(row, 'position') ?? 0), legacyId: String(get(row, 'metadata', 'codex.localProjectId') || '') }));
    const byId = new Map(projects.map(project => [project.id, project]));
    const legacy = new Map<string, unknown>(desktop.legacy);
    for (const project of projects) if (project.legacyId) legacy.set(project.legacyId, project.id);
    const current = (id: unknown): string => { const key = String(id); if (byId.has(key)) return key; const mapped = legacy.get(key); return typeof mapped === 'string' && byId.has(mapped) ? mapped : ''; };
    // The desktop lists projects it has not ordered yet first (newest first), then its saved order.
    const rank = new Map(desktop.order.map(current).filter(Boolean).map((id, index) => [id, index]));
    const ordered = [...projects].sort((a, b) => (Number(rank.has(a.id)) - Number(rank.has(b.id))) || (rank.has(a.id) ? (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0) : desktop.order.length ? b.position - a.position : a.position - b.position));
    const byRoot = [...projects].sort((a, b) => a.position - b.position);
    const under = (cwd: string): CodexProject | null => {
      const c = normPath(cwd);
      if (!c) return null;
      let best: CodexProject | null = null, length = -1;
      for (const project of byRoot) for (const root of project.roots) {
        const r = normPath(root);
        if ((c === r || c.startsWith(r.endsWith('/') ? r : `${r}/`)) && r.length > length) { best = project; length = r.length; }
      }
      return best;
    };
    const resolve = (thread: { id: string; projectId?: unknown; cwd?: unknown }) => {
      const assigned = current(thread.projectId || '') || current(desktop.assignments.get(thread.id) || '');
      if (assigned) return byId.get(assigned);
      if (desktop.projectless.has(thread.id)) return null;
      return under(String(thread.cwd || ''));
    };
    return { projects: ordered, resolve };
  }
}
export { CodexProjects };
