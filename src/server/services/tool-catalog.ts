// Ordered rules are an extension point for tool summaries, independent of providers.
// A tool's input is the engine's native argument object: unknown until a rule reads a key of it.
import { get, list } from '../../shared/guards.js';

/** What a rule makes of one tool call. Values read from the native input stay unknown until shown. */
export interface ToolSummary { type: string; summary: unknown; detail?: unknown; command?: unknown; paths?: unknown[] }
export interface ToolRule { match: RegExp; map: (input: unknown, name: string) => ToolSummary }

const short = (value: unknown) => String(value || '').split(/[\\/]/).filter(Boolean).slice(-2).join('/');
const fileOf = (input: unknown) => get(input, 'file_path') || get(input, 'path') || get(input, 'Path') || get(input, 'TargetFile') || get(input, 'AbsolutePath') || get(input, 'notebook_path') || '';
const rules: ToolRule[] = [
  { match: /^mcp__/, map: (input, name) => { const [, server = '', ...tool] = name.split('__'); return { type: 'tool_call', summary: `${tool.join('_').replace(/_/g, ' ')} · ${server.replace(/_/g, ' ')}`, detail: JSON.stringify(input, null, 2) }; } },
  { match: /^(Bash|run_command|commandExecution|terminal)$/i, map: input => ({ type: 'command', command: get(input, 'command') || get(input, 'CommandLine') || '', summary: 'Ran command' }) },
  { match: /^(Edit|MultiEdit|Write|NotebookEdit|write_file|edit_file|write_to_file|apply_patch|replace_file_content|multi_replace_file_content)$/i, map: input => ({ type: 'file_change', summary: `Edited · ${short(fileOf(input)) || 'files'}`, paths: [fileOf(input)].filter(Boolean) }) },
  { match: /^(WebFetch|read_url_content)$/i, map: input => ({ type: 'web_search', summary: `Fetched · ${get(input, 'url') || get(input, 'Url') || 'page'}`, detail: get(input, 'url') || get(input, 'Url') || '' }) },
  { match: /^(Grep|Glob|grep_search|find_by_name)$/i, map: input => ({ type: 'tool_call', summary: `Searched · ${get(input, 'pattern') || get(input, 'Query') || get(input, 'Pattern') || 'files'}`, detail: [get(input, 'pattern') || get(input, 'Pattern'), get(input, 'path') || get(input, 'SearchPath')].filter(Boolean).join('  in  ') }) },
  { match: /search|browse|web/i, map: input => ({ type: 'web_search', summary: get(input, 'query') || get(input, 'Query') || 'Web search', detail: get(input, 'query') || get(input, 'Query') || '' }) },
  { match: /read|view|list/i, map: input => ({ type: 'tool_call', summary: `Read · ${short(fileOf(input) || get(input, 'DirectoryPath')) || 'context'}`, detail: fileOf(input) || get(input, 'DirectoryPath') || '' }) },
  { match: /^(Task|Agent|invoke_subagent)$/i, map: input => ({ type: 'tool_call', summary: `Subagent · ${get(input, 'description') || get(input, 'subagent_type') || 'task'}`, detail: get(input, 'prompt') || get(input, 'Prompt') || '' }) },
];
function classifyTool(name = '', input: unknown = {}): ToolSummary {
  const rule = rules.find(rule => rule.match.test(name));
  return rule ? rule.map(input || {}, name) : { type: 'tool_call', summary: name || 'Tool call', detail: JSON.stringify(input, null, 2) };
}
function registerTool(rule: ToolRule): () => void { rules.unshift(rule); return () => { rules.splice(rules.indexOf(rule), 1); }; }
/** A list read from a tool's input (for rules that walk one), empty when it is not an array. */
const inputList = (input: unknown, key: string): unknown[] => list(get(input, key));
export { classifyTool, registerTool, inputList };
