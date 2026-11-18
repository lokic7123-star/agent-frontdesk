// The Windows twin of ax-driver.swift (+ claude-desktop.swift + codex-desktop.swift), speaking
// the same one-line-JSON protocol the server's core/desktop-automation.ts reads: one command per
// process, flags/arguments on the command line, optional message text on stdin, and exactly one
// JSON object as the last line of stdout.
//
// Profiles (src/server/native/profiles/<engine>.json) remain the single source of locator data:
//   win32.process            process name (falls back from ChatGPT to Codex)
//   locators.<key>           same schema as macOS (macOS-only `keys`/`subrole` ways are skipped)
//   spaces / chatRead / chatSend / effortNames / effortSteps / menuSigns / ...

using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Automation;
using AgentFrontdesk.UiaDriver;

Console.InputEncoding = Console.OutputEncoding = new UTF8Encoding(false);

var parsed = Driver.ParseArgs(args);
var profile = Driver.LoadProfile(Environment.GetEnvironmentVariable("AX_PROFILE"));
Driver.Setup(profile, parsed);

try
{
    var answer = Driver.Execute(parsed, profile, Console.In);
    var json = Driver.FinalizeAndSerialize(answer);
    Console.WriteLine(json);
    return answer.TryGetValue("ok", out var okVal) && okVal is false ? 1 : 0;
}
catch (DriverStopException stop)
{
    var answer = new Dictionary<string, object?> { ["ok"] = false, ["code"] = stop.Code, ["error"] = stop.Message };
    Console.WriteLine(Driver.FinalizeAndSerialize(answer));
    return 1;
}
catch (Exception err)
{
    var answer = new Dictionary<string, object?>
    {
        ["ok"] = false,
        ["code"] = "crashed",
        ["error"] = err.Message.Split('\n')[0].Trim(),
    };
    Console.WriteLine(Driver.FinalizeAndSerialize(answer));
    return 1;
}

namespace AgentFrontdesk.UiaDriver
{
    internal sealed class DriverStopException : Exception
    {
        internal string Code { get; }
        internal DriverStopException(string code, string message) : base(message) { Code = code; }
    }

    internal sealed class ParsedCli
    {
        internal List<string> Args { get; } = [];
        internal Dictionary<string, string> Wanted { get; } = new(StringComparer.Ordinal);
        internal string ParkedPrevious { get; set; } = "";
        internal string ParkedSpace { get; set; } = "";
        internal bool Staying { get; set; }
    }

    internal sealed class LocatorWay
    {
        internal string Key { get; init; } = "";
        internal JsonElement Raw { get; init; }
        internal string? Role { get; init; }
        internal List<string> Roles { get; init; } = [];
        internal List<string> Classes { get; init; } = [];
        internal string? Keys { get; init; }
        internal string? Id { get; init; }
        internal string? Subrole { get; init; }
        internal string? Url { get; init; }
        internal string? Inside { get; init; }
        internal string? Has { get; init; }
        internal string? After { get; init; }
        internal int? Index { get; init; }
        internal bool? Popup { get; init; }
        internal string? Name { get; init; }
        internal string? Prefix { get; init; }
        internal string? Contains { get; init; }
        internal bool Named { get; init; }

        internal bool Worded => Name != null || Prefix != null || Contains != null;
        internal bool Placed => Index != null || After != null;
        internal string Kind => Worded ? "name" : Placed ? "place" : "mark";
    }

    internal static class NativeMethods
    {
        internal delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

        [DllImport("user32.dll")] internal static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
        [DllImport("user32.dll")] internal static extern uint GetWindowThreadProcessId(IntPtr hWnd, out int lpdwProcessId);
        [DllImport("user32.dll")] internal static extern bool IsWindowVisible(IntPtr hWnd);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] internal static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);
        [DllImport("user32.dll")] internal static extern int GetWindowTextLength(IntPtr hWnd);
        [DllImport("user32.dll")] internal static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
        [DllImport("user32.dll")] internal static extern bool IsIconic(IntPtr hWnd);
        [DllImport("user32.dll")] internal static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] internal static extern bool SetForegroundWindow(IntPtr hWnd);
    }

    internal static class Driver
    {
        internal static readonly JsonSerializerOptions JsonOpts = new()
        {
            Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
        };

        static readonly Stopwatch Sw = Stopwatch.StartNew();
        static readonly bool Tracing = Environment.GetEnvironmentVariable("AX_TRACE") != null;
        static int _reads;
        static JsonElement _profile;
        static ParsedCli _cli = new();
        static Dictionary<string, List<LocatorWay>> _locators = new(StringComparer.Ordinal);
        static string _appName = "桌面版";
        static string? _modeTitleSuffix;
        static string _personSpace = "";
        static Func<string?>? _beforeExit;
        static IntPtr _hwnd;
        static AutomationElement? _root;
        static string _command = "";

        // Per-read cache (cleared on Stale() after actions/waits).
        static readonly Dictionary<string, List<AutomationElement>> ChildCache = new(StringComparer.Ordinal);
        static readonly Dictionary<string, AutomationElement.AutomationElementInformation> CurrentCache = new(StringComparer.Ordinal);
        static readonly Dictionary<string, string?> ValueCache = new(StringComparer.Ordinal);
        static readonly Dictionary<string, string?> UrlCache = new(StringComparer.Ordinal);
        static readonly Dictionary<string, (string Key, int Way)> Origin = new(StringComparer.Ordinal);
        static readonly Dictionary<string, int> Via = new(StringComparer.Ordinal);
        static readonly Dictionary<string, int> Refused = new(StringComparer.Ordinal);
        static readonly List<string> Unconfirmed = [];
        static readonly HashSet<string> SoleNow = new(StringComparer.Ordinal);
        static AutomationElement? _anchor;
        static string? _slotIdleName;

        internal static ParsedCli ParseArgs(string[] raw)
        {
            var cli = new ParsedCli();
            var i = 0;
            while (i < raw.Length)
            {
                var arg = raw[i];
                if ((arg is "--model" or "--effort" or "--mode" or "--space") && i + 1 < raw.Length)
                {
                    cli.Wanted[arg[2..]] = raw[i + 1];
                    i += 2;
                }
                else if (arg == "--previous" && i + 1 < raw.Length)
                {
                    cli.ParkedPrevious = raw[i + 1];
                    i += 2;
                }
                else if (arg == "--previous-space" && i + 1 < raw.Length)
                {
                    cli.ParkedSpace = raw[i + 1];
                    i += 2;
                }
                else if (arg == "--stay")
                {
                    cli.Staying = true;
                    i += 1;
                }
                else
                {
                    cli.Args.Add(arg);
                    i += 1;
                }
            }
            return cli;
        }

        internal static JsonElement LoadProfile(string? path)
        {
            if (!string.IsNullOrEmpty(path) && File.Exists(path))
            {
                try { return JsonDocument.Parse(File.ReadAllText(path)).RootElement.Clone(); }
                catch { }
            }
            return JsonDocument.Parse("{}").RootElement.Clone();
        }

        internal static void Setup(JsonElement profile, ParsedCli cli)
        {
            _profile = profile;
            _cli = cli;
            _command = cli.Args.Count > 0 ? cli.Args[0] : "";
            var name = ProfileString(profile, "name");
            _appName = string.IsNullOrEmpty(name) ? "桌面版" : name;
            _locators = ParseAllLocators(profile);
        }

        static void Trace(string what)
        {
            if (Tracing) Console.Error.WriteLine($"[uia +{Sw.ElapsedMilliseconds}ms {_reads}r] {what}");
        }

        internal static string FinalizeAndSerialize(Dictionary<string, object?> dict)
        {
            var staying = _cli.Staying;
            if (staying && dict.TryGetValue("stayed", out var stayed) && stayed is true && !string.IsNullOrEmpty(_personSpace))
            {
                dict["previousSpace"] = _personSpace;
            }
            else if (_beforeExit != null)
            {
                var undo = _beforeExit;
                _beforeExit = null;
                var problem = undo();
                if (!string.IsNullOrEmpty(problem)) dict["restore"] = problem;
            }

            Annotate(dict);
            dict["ms"] = (int)Sw.ElapsedMilliseconds;
            dict["reads"] = _reads;
            var failed = dict.TryGetValue("ok", out var ok) && ok is false;
            Trace($"done {(failed ? $"failed: {dict.GetValueOrDefault("code") ?? ""}" : "ok")}");
            return JsonSerializer.Serialize(dict, JsonOpts);
        }

        static void Annotate(Dictionary<string, object?> obj)
        {
            if (_command is not ("warm" or "probe" or "inspect"))
            {
                var other = new Dictionary<string, string>();
                foreach (var (key, wayIndex) in Via)
                {
                    if (wayIndex > 0 && _locators.TryGetValue(key, out var list) && wayIndex < list.Count)
                        other[key] = list[wayIndex].Kind;
                }
                if (other.Count > 0) obj["via"] = other;
            }

            var failed = obj.TryGetValue("ok", out var ok) && ok is false;
            void Because(string code, string message)
            {
                if (!failed) return;
                if (obj.TryGetValue("code", out var step) && step != null) obj["step"] = step;
                obj["code"] = code;
                obj["error"] = message;
            }

            if (Refused.Count > 0)
            {
                var first = Refused.OrderBy(kv => kv.Key, StringComparer.Ordinal).First();
                obj["ambiguous"] = new Dictionary<string, int>(Refused);
                Because("ambiguous", $"{_appName}的页面上有 {first.Value} 个控件都对得上「{first.Key}」，分不清该动哪一个，所以没有动手（桌面版可能改过界面，这个控件的认法要更新）");
            }
            else if (Unconfirmed.Count > 0)
            {
                var key = Unconfirmed[0];
                obj["unconfirmed"] = Unconfirmed.ToList();
                Because("unconfirmed", $"{_appName}里按位置找到的「{key}」打开的不是预期的菜单，所以什么都没有选（桌面版可能改过界面，这个控件的认法要更新）");
            }
        }

        internal static Dictionary<string, object?> Execute(ParsedCli cli, JsonElement profile, TextReader stdin)
        {
            var args = cli.Args;
            var cmd = _command;

            if (cmd == "check")
            {
                var found = FindAppRoot(profile);
                return new Dictionary<string, object?> { ["ok"] = true, ["trusted"] = true, ["running"] = found.Root != null };
            }

            if (string.IsNullOrEmpty(ProfileString(profile, "win32", "process")) && string.IsNullOrEmpty(ProfileString(profile, "bundleId")))
                return Fail("usage", "缺少桌面版的配置（AX_PROFILE）");

            var app = FindAppRoot(profile);
            if (app.Root == null) return Fail("not_running", "桌面版没有在运行");
            _root = app.Root;
            _hwnd = app.Hwnd;

            if (cmd == "warm") return RunWarm(args);
            if (cmd == "probe") return RunProbe(args);
            if (cmd == "inspect") return RunInspect(args);
            if (cmd == "space")
            {
                var shown = ShownSpace();
                return new Dictionary<string, object?> { ["ok"] = true, ["found"] = shown != null, ["space"] = shown ?? "" };
            }

            // Switch desktop mode before commands that act on a space, and restore on exit.
            var spaceEarly = MaybeApplyModeSwitch(cmd);
            if (spaceEarly != null) return spaceEarly;

            return cmd switch
            {
                "send" => RunSend(args, stdin),
                "send-now" => RunSendNow(args),
                "stop" => RunStop(args),
                "settings" => RunSettings(args),
                "show-session" => RunShowSession(args),
                "open-file" => RunOpenFile(args),
                "new-controls" or "new-pick" or "new-leave" => RunNewPageCommand(cmd, args),
                "new-shown" => RunNewShown(),
                "new" => RunNew(args, stdin),
                "answer" => RunAnswer(args),
                "card" or "action" => RunCardAction(cmd, args),
                "chat-status" or "read-chat" or "chat-new" or "chat-send" or "chat-stop" => RunChatCommand(cmd, args, stdin),
                _ => Fail("unknown", "未知命令"),
            };
        }

        // ---- window discovery ----

        static (AutomationElement? Root, IntPtr Hwnd) FindAppRoot(JsonElement profile)
        {
            var process = ProfileString(profile, "win32", "process");
            if (process.Length == 0) return (null, IntPtr.Zero);
            var candidates = process.Equals("ChatGPT", StringComparison.OrdinalIgnoreCase)
                ? new[] { process, "Codex" }
                : new[] { process };

            var pids = new HashSet<int>();
            foreach (var name in candidates)
            {
                var procs = Process.GetProcessesByName(name);
                try
                {
                    foreach (var p in procs)
                    {
                        pids.Add(p.Id);
                        try
                        {
                            var hwnd = p.MainWindowHandle;
                            if (hwnd != IntPtr.Zero)
                            {
                                if (WakeIfMinimized(hwnd)) Thread.Sleep(60);
                                return (AutomationElement.FromHandle(hwnd), hwnd);
                            }
                        }
                        catch { }
                    }
                }
                finally
                {
                    foreach (var p in procs) p.Dispose();
                }
            }

            if (pids.Count == 0) return (null, IntPtr.Zero);

            IntPtr visibleChrome = IntPtr.Zero;
            IntPtr visibleAny = IntPtr.Zero;
            IntPtr hiddenChrome = IntPtr.Zero;

            NativeMethods.EnumWindows((hWnd, _) =>
            {
                NativeMethods.GetWindowThreadProcessId(hWnd, out var pid);
                if (!pids.Contains(pid)) return true;

                var clsBuf = new StringBuilder(128);
                NativeMethods.GetClassName(hWnd, clsBuf, clsBuf.Capacity);
                var cls = clsBuf.ToString();
                var hasTitle = NativeMethods.GetWindowTextLength(hWnd) > 0;
                var visible = NativeMethods.IsWindowVisible(hWnd);
                var isChrome = cls.StartsWith("Chrome_WidgetWin_", StringComparison.Ordinal);

                if (visible && isChrome && hasTitle)
                {
                    visibleChrome = hWnd;
                    return false;
                }
                if (visible && isChrome && visibleChrome == IntPtr.Zero) visibleChrome = hWnd;
                else if (visible && hasTitle && visibleAny == IntPtr.Zero) visibleAny = hWnd;
                else if (!visible && isChrome && hasTitle && hiddenChrome == IntPtr.Zero) hiddenChrome = hWnd;
                return true;
            }, IntPtr.Zero);

            var picked = visibleChrome != IntPtr.Zero ? visibleChrome : visibleAny != IntPtr.Zero ? visibleAny : hiddenChrome;
            if (picked == IntPtr.Zero) return (null, IntPtr.Zero);
            try
            {
                if (WakeIfMinimized(picked)) Thread.Sleep(60);
                return (AutomationElement.FromHandle(picked), picked);
            }
            catch
            {
                return (null, IntPtr.Zero);
            }
        }

        static bool WakeIfMinimized(IntPtr hwnd)
        {
            if (hwnd == IntPtr.Zero || !NativeMethods.IsIconic(hwnd)) return false;
            NativeMethods.ShowWindow(hwnd, 4 /* SW_SHOWNOACTIVATE */);
            return true;
        }

        static void ActivateWindow(IntPtr hwnd)
        {
            if (hwnd == IntPtr.Zero) return;
            NativeMethods.ShowWindow(hwnd, NativeMethods.IsIconic(hwnd) ? 9 /* SW_RESTORE */ : 5 /* SW_SHOW */);
            NativeMethods.SetForegroundWindow(hwnd);
        }

        static bool IsAppForeground()
        {
            var fg = NativeMethods.GetForegroundWindow();
            if (fg == IntPtr.Zero || _hwnd == IntPtr.Zero) return false;
            if (fg == _hwnd) return true;
            NativeMethods.GetWindowThreadProcessId(fg, out var fgPid);
            NativeMethods.GetWindowThreadProcessId(_hwnd, out var ownPid);
            return fgPid != 0 && fgPid == ownPid;
        }

        // ---- profile helpers ----

        static string ProfileString(JsonElement obj, params string[] path)
        {
            var at = obj;
            foreach (var step in path)
            {
                if (at.ValueKind != JsonValueKind.Object || !at.TryGetProperty(step, out at)) return "";
            }
            return at.ValueKind == JsonValueKind.String ? at.GetString() ?? "" : "";
        }

        static List<string> ProfileStrings(JsonElement obj, params string[] path)
        {
            var at = obj;
            foreach (var step in path)
            {
                if (at.ValueKind != JsonValueKind.Object || !at.TryGetProperty(step, out at)) return [];
            }
            if (at.ValueKind != JsonValueKind.Array) return [];
            var outList = new List<string>();
            foreach (var item in at.EnumerateArray())
            {
                if (item.ValueKind == JsonValueKind.String)
                {
                    var s = item.GetString() ?? "";
                    if (s.Length > 0) outList.Add(s);
                }
            }
            return outList;
        }

        static Dictionary<string, string> ProfileMap(JsonElement obj, params string[] path)
        {
            var map = new Dictionary<string, string>(StringComparer.Ordinal);
            var at = obj;
            foreach (var step in path)
            {
                if (at.ValueKind != JsonValueKind.Object || !at.TryGetProperty(step, out at)) return map;
            }
            if (at.ValueKind != JsonValueKind.Object) return map;
            foreach (var prop in at.EnumerateObject())
            {
                if (prop.Value.ValueKind == JsonValueKind.String)
                    map[prop.Name] = prop.Value.GetString() ?? "";
            }
            return map;
        }

        static JsonElement? ProfileElement(JsonElement obj, params string[] path)
        {
            var at = obj;
            foreach (var step in path)
            {
                if (at.ValueKind != JsonValueKind.Object || !at.TryGetProperty(step, out at)) return null;
            }
            return at;
        }

        static LocatorWay ParseLocatorWay(string key, JsonElement spec)
        {
            string? GetStr(string f) => spec.TryGetProperty(f, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;
            bool? GetBool(string f) => spec.TryGetProperty(f, out var v) && v.ValueKind is JsonValueKind.True or JsonValueKind.False ? v.GetBoolean() : null;
            int? GetInt(string f) => spec.TryGetProperty(f, out var v) && v.ValueKind == JsonValueKind.Number && v.TryGetInt32(out var n) ? n : null;
            List<string> GetStrOrArr(string f)
            {
                var list = new List<string>();
                if (!spec.TryGetProperty(f, out var v)) return list;
                if (v.ValueKind == JsonValueKind.String)
                {
                    var s = v.GetString() ?? "";
                    if (s.Length > 0) list.Add(s);
                }
                else if (v.ValueKind == JsonValueKind.Array)
                {
                    foreach (var item in v.EnumerateArray())
                    {
                        if (item.ValueKind == JsonValueKind.String)
                        {
                            var s = item.GetString() ?? "";
                            if (s.Length > 0) list.Add(s);
                        }
                    }
                }
                return list;
            }

            return new LocatorWay
            {
                Key = key,
                Raw = spec,
                Role = GetStr("role"),
                Roles = GetStrOrArr("roles"),
                Classes = GetStrOrArr("class"),
                Keys = GetStr("keys"),
                Id = GetStr("id"),
                Subrole = GetStr("subrole"),
                Url = GetStr("url"),
                Inside = GetStr("inside"),
                Has = GetStr("has"),
                After = GetStr("after"),
                Index = GetInt("index"),
                Popup = GetBool("popup"),
                Name = GetStr("name"),
                Prefix = GetStr("prefix"),
                Contains = GetStr("contains"),
                Named = GetBool("named") ?? false,
            };
        }

        static List<LocatorWay> ParseLocatorList(string key, JsonElement val)
        {
            var ways = new List<LocatorWay>();
            if (val.ValueKind == JsonValueKind.Object) ways.Add(ParseLocatorWay(key, val));
            else if (val.ValueKind == JsonValueKind.Array)
            {
                foreach (var item in val.EnumerateArray())
                {
                    if (item.ValueKind == JsonValueKind.Object) ways.Add(ParseLocatorWay(key, item));
                }
            }
            return ways;
        }

        static Dictionary<string, List<LocatorWay>> ParseAllLocators(JsonElement profile)
        {
            var dict = new Dictionary<string, List<LocatorWay>>(StringComparer.Ordinal);
            if (profile.ValueKind == JsonValueKind.Object && profile.TryGetProperty("locators", out var locs) && locs.ValueKind == JsonValueKind.Object)
            {
                foreach (var prop in locs.EnumerateObject()) dict[prop.Name] = ParseLocatorList(prop.Name, prop.Value);
            }
            return dict;
        }

        static List<LocatorWay> WaysOf(string key) => _locators.TryGetValue(key, out var list) ? list : [];

        // ---- UIA element reading & cache ----

        static void Stale()
        {
            ChildCache.Clear();
            CurrentCache.Clear();
            ValueCache.Clear();
            UrlCache.Clear();
            SoleNow.Clear();
        }

        static string RuntimeKey(AutomationElement element)
        {
            try
            {
                var ids = element.GetRuntimeId();
                if (ids != null && ids.Length > 0) return string.Join(".", ids);
            }
            catch { }
            return element.GetHashCode().ToString();
        }

        static AutomationElement.AutomationElementInformation? Info(AutomationElement element)
        {
            var rk = RuntimeKey(element);
            if (CurrentCache.TryGetValue(rk, out var cached)) return cached;
            _reads++;
            try
            {
                var info = element.Current;
                CurrentCache[rk] = info;
                return info;
            }
            catch { return null; }
        }

        static List<AutomationElement> ChildrenOf(AutomationElement element)
        {
            var rk = RuntimeKey(element);
            if (ChildCache.TryGetValue(rk, out var cached)) return cached;
            _reads++;
            var list = new List<AutomationElement>();
            try
            {
                var found = element.FindAll(TreeScope.Children, Condition.TrueCondition);
                foreach (AutomationElement child in found) list.Add(child);
            }
            catch { }
            ChildCache[rk] = list;
            return list;
        }

        static ControlType? TypeOf(AutomationElement element) => Info(element)?.ControlType;
        static string NameOf(AutomationElement element) => Info(element)?.Name ?? "";
        static string ClassNameOf(AutomationElement element) => Info(element)?.ClassName ?? "";
        static string AutomationIdOf(AutomationElement element) => Info(element)?.AutomationId ?? "";

        static string RoleName(AutomationElement element)
        {
            var ct = TypeOf(element);
            if (ct == null) return "";
            if (ct == ControlType.Edit) return "AXTextArea";
            if (ct == ControlType.Button) return "AXButton";
            if (ct == ControlType.Group || ct == ControlType.Pane || ct == ControlType.Custom) return "AXGroup";
            if (ct == ControlType.Document) return "AXWebArea";
            if (ct == ControlType.ComboBox) return "AXPopUpButton";
            if (ct == ControlType.RadioButton) return "AXRadioButton";
            if (ct == ControlType.MenuItem) return "AXMenuItem";
            if (ct == ControlType.Menu) return "AXMenu";
            if (ct == ControlType.Header || ct == ControlType.HeaderItem) return "AXHeading";
            if (ct == ControlType.Text) return "AXStaticText";
            if (ct == ControlType.Hyperlink) return "AXLink";
            if (ct == ControlType.CheckBox) return "AXCheckBox";
            if (ct == ControlType.List) return "AXList";
            if (ct == ControlType.Image) return "AXImage";
            if (ct == ControlType.Table || ct == ControlType.DataGrid) return "AXTable";
            if (ct == ControlType.DataItem || ct == ControlType.ListItem) return "AXRow";
            return ct.ProgrammaticName.Replace("ControlType.", "");
        }

        static bool RoleMatches(AutomationElement element, string wantRole, LocatorWay? way = null)
        {
            var ct = TypeOf(element);
            if (ct == null) return false;
            return wantRole switch
            {
                "AXTextArea" or "AXTextField" => ct == ControlType.Edit,
                "AXButton" => ct == ControlType.Button,
                "AXGroup" => ct == ControlType.Group || ct == ControlType.Pane || ct == ControlType.Custom,
                "AXWebArea" => ct == ControlType.Document,
                "AXPopUpButton" => ct == ControlType.ComboBox || ct == ControlType.Button,
                "AXRadioButton" => ct == ControlType.RadioButton,
                "AXRadioGroup" => ct == ControlType.Group || ct == ControlType.Pane || ct == ControlType.Tab,
                "AXMenuItem" => ct == ControlType.MenuItem || ct == ControlType.Button || ct == ControlType.ListItem,
                "AXMenu" => ct == ControlType.Menu || ct == ControlType.List || ct == ControlType.Group || ct == ControlType.Pane,
                "AXHeading" => ct == ControlType.Header || ct == ControlType.HeaderItem || (ct == ControlType.Text && way != null && (way.Worded || way.Classes.Count > 0 || way.Id != null || way.Inside != null)),
                "AXStaticText" => ct == ControlType.Text,
                "AXLink" => ct == ControlType.Hyperlink,
                "AXCheckBox" => ct == ControlType.CheckBox || ct == ControlType.Button,
                "AXList" => ct == ControlType.List || ct == ControlType.Menu || ct == ControlType.Group,
                "AXImage" => ct == ControlType.Image,
                "AXTable" => ct == ControlType.Table || ct == ControlType.DataGrid,
                "AXRow" => ct == ControlType.DataItem || ct == ControlType.ListItem,
                _ => RoleName(element) == wantRole,
            };
        }

        static string ValueOf(AutomationElement element)
        {
            var rk = RuntimeKey(element);
            if (ValueCache.TryGetValue(rk, out var cached)) return cached ?? "";
            _reads++;
            string? val = null;
            try
            {
                if (element.TryGetCurrentPattern(ValuePattern.Pattern, out var pat) && pat is ValuePattern vp)
                    val = vp.Current.Value ?? "";
                else if (element.TryGetCurrentPattern(TextPattern.Pattern, out var tpat) && tpat is TextPattern tp)
                    val = tp.DocumentRange.GetText(4000) ?? "";
                else
                    val = NameOf(element);
            }
            catch { val = ""; }
            ValueCache[rk] = val;
            return val ?? "";
        }

        static string UrlOf(AutomationElement element)
        {
            var rk = RuntimeKey(element);
            if (UrlCache.TryGetValue(rk, out var cached)) return cached ?? "";
            _reads++;
            string? url = null;
            try
            {
                if (element.TryGetCurrentPattern(ValuePattern.Pattern, out var pat) && pat is ValuePattern vp)
                    url = vp.Current.Value ?? "";
            }
            catch { url = ""; }
            UrlCache[rk] = url;
            return url ?? "";
        }

        static bool Expanded(AutomationElement element)
        {
            try
            {
                if (element.TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out var pat) && pat is ExpandCollapsePattern ep)
                    return ep.Current.ExpandCollapseState is ExpandCollapseState.Expanded or ExpandCollapseState.PartiallyExpanded;
            }
            catch { }
            return false;
        }

        static bool Checked(AutomationElement element)
        {
            try
            {
                if (element.TryGetCurrentPattern(TogglePattern.Pattern, out var tpat) && tpat is TogglePattern tp)
                    return tp.Current.ToggleState == ToggleState.On;
                if (element.TryGetCurrentPattern(SelectionItemPattern.Pattern, out var spat) && spat is SelectionItemPattern sp)
                    return sp.Current.IsSelected;
            }
            catch { }
            return ValueOf(element) == "1";
        }

        static bool Enabled(AutomationElement element) => Info(element)?.IsEnabled ?? true;

        static bool HasPopup(AutomationElement element)
        {
            try { return element.TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out _); }
            catch { return false; }
        }

        static System.Windows.Rect FrameOf(AutomationElement element)
        {
            try { return Info(element)?.BoundingRectangle ?? System.Windows.Rect.Empty; }
            catch { return System.Windows.Rect.Empty; }
        }

        static bool SameElement(AutomationElement? a, AutomationElement? b)
        {
            if (a == null && b == null) return true;
            if (a == null || b == null) return false;
            try { return Automation.Compare(a, b); }
            catch { return RuntimeKey(a) == RuntimeKey(b); }
        }

        static bool Walk(AutomationElement element, Func<AutomationElement, bool> visit, int depth = 0, int maxDepth = 60)
        {
            if (depth > maxDepth) return false;
            if (visit(element)) return true;
            foreach (var child in ChildrenOf(element))
            {
                if (Walk(child, visit, depth + 1, maxDepth)) return true;
            }
            return false;
        }

        static AutomationElement? First(Func<AutomationElement, bool> match)
        {
            if (_root == null) return null;
            AutomationElement? hit = null;
            Walk(_root, e => { if (match(e)) { hit = e; return true; } return false; });
            return hit;
        }

        static List<AutomationElement> Every(Func<AutomationElement, bool> match)
        {
            if (_root == null) return [];
            var hits = new List<AutomationElement>();
            Walk(_root, e => { if (match(e)) hits.Add(e); return false; });
            return hits;
        }

        static List<AutomationElement> Within(AutomationElement box, Func<AutomationElement, bool> match)
        {
            var hits = new List<AutomationElement>();
            Walk(box, e => { if (match(e)) hits.Add(e); return false; });
            return hits;
        }

        static bool MatchClassToken(string actual, string want)
        {
            if (actual.Length == 0) return false;
            if (want.EndsWith('*'))
            {
                var prefix = want[..^1];
                return actual.StartsWith(prefix, StringComparison.Ordinal)
                    || actual.Split(' ', StringSplitOptions.RemoveEmptyEntries).Any(t => t.StartsWith(prefix, StringComparison.Ordinal));
            }
            return actual == want
                || actual.Split(' ', StringSplitOptions.RemoveEmptyEntries).Contains(want, StringComparer.Ordinal);
        }

        static bool Fits(AutomationElement element, LocatorWay way)
        {
            if (way.Keys != null || way.Subrole != null) return false;
            if (way.Role != null && !RoleMatches(element, way.Role, way)) return false;
            if (way.Roles.Count > 0 && !way.Roles.Any(r => RoleMatches(element, r, way))) return false;
            if (way.Id != null && AutomationIdOf(element) != way.Id) return false;

            if (way.Classes.Count > 0)
            {
                var cls = ClassNameOf(element);
                var aid = AutomationIdOf(element);
                if (!way.Classes.All(w => MatchClassToken(cls, w) || MatchClassToken(aid, w))) return false;
            }

            if (way.Popup != null && HasPopup(element) != way.Popup.Value) return false;

            if (way.Url != null)
            {
                var ownUrl = UrlOf(element);
                if (way.Url.EndsWith('*'))
                {
                    if (!ownUrl.StartsWith(way.Url[..^1], StringComparison.Ordinal)) return false;
                }
                else if (ownUrl != way.Url && !ownUrl.StartsWith(way.Url, StringComparison.Ordinal))
                {
                    return false;
                }
            }

            if (!way.Worded && !way.Named)
            {
                return way.Role != null || way.Roles.Count > 0 || way.Classes.Count > 0 || way.Id != null || way.Url != null || way.Popup != null;
            }

            var name = NameOf(element);
            if (way.Name != null && name != way.Name) return false;
            if (way.Prefix != null && !name.StartsWith(way.Prefix, StringComparison.Ordinal)) return false;
            if (way.Contains != null && !name.Contains(way.Contains, StringComparison.OrdinalIgnoreCase)) return false;
            if (way.Named && string.IsNullOrEmpty(name)) return false;
            return true;
        }

        static List<AutomationElement> Matches(LocatorWay way, int depth = 0)
        {
            if (depth >= 5 || _root == null) return [];
            if (way.Keys != null || way.Subrole != null) return [];

            var scope = _root;
            if (way.Inside != null)
            {
                var box = Find(way.Inside, depth + 1);
                if (box == null) return [];
                scope = box;
            }

            List<AutomationElement> hits;
            if (way.After != null)
            {
                var mark = Find(way.After, depth + 1);
                if (mark == null) return [];
                hits = [];
                var seen = false;
                Walk(scope, e =>
                {
                    if (!seen) seen = SameElement(e, mark);
                    else if (Fits(e, way)) hits.Add(e);
                    return false;
                });
            }
            else
            {
                hits = Within(scope, e => Fits(e, way));
            }

            if (way.Has != null)
            {
                var held = FindAll(way.Has, depth + 1);
                hits = hits.Where(box => held.Any(part => !SameElement(part, box) && Within(box, e => SameElement(e, part)).Count > 0)).ToList();
            }

            if (way.Index == null) return hits;
            var at = way.Index.Value < 0 ? hits.Count + way.Index.Value : way.Index.Value;
            return at >= 0 && at < hits.Count ? [hits[at]] : [];
        }

        static List<AutomationElement> FindAll(string key, int depth = 0)
        {
            foreach (var way in WaysOf(key))
            {
                var hits = Matches(way, depth);
                if (hits.Count > 0) return hits;
            }
            return [];
        }

        static AutomationElement? Find(string key, int depth = 0)
        {
            var ways = WaysOf(key);
            for (var index = 0; index < ways.Count; index++)
            {
                var way = ways[index];
                var hit = way.Inside == null && way.After == null && way.Index == null && way.Has == null
                    ? First(e => Fits(e, way))
                    : Matches(way, depth).FirstOrDefault();
                if (hit != null)
                {
                    var rk = RuntimeKey(hit);
                    Origin[rk] = (key, index);
                    Via[key] = index;
                    return hit;
                }
            }
            return null;
        }

        static bool FitsKey(AutomationElement element, string key) => WaysOf(key).Any(way => Fits(element, way));

        // ---- one control, or none ----

        static bool Sole(AutomationElement element, int depth = 0)
        {
            var rk = RuntimeKey(element);
            if (depth >= 5 || !Origin.TryGetValue(rk, out var from) || SoleNow.Contains(rk)) return true;
            var ways = WaysOf(from.Key);
            if (from.Way < 0 || from.Way >= ways.Count) return true;
            var way = ways[from.Way];
            if (!way.Placed)
            {
                var hits = Matches(way);
                if (hits.Count > 1)
                {
                    var singled = ways.Where((_, i) => i != from.Way && !ways[i].Placed)
                        .Any(other => { var f = Matches(other); return f.Count == 1 && SameElement(f[0], element); });
                    if (!singled)
                    {
                        Refused[from.Key] = hits.Count;
                        Trace($"held back: {hits.Count} controls answer to {from.Key}");
                        return false;
                    }
                }
            }
            foreach (var anchorKey in new[] { way.Inside, way.After }.Where(s => !string.IsNullOrEmpty(s))!)
            {
                var box = Find(anchorKey!, depth + 1);
                if (box != null && !Sole(box, depth + 1)) return false;
            }
            Origin[rk] = from;
            SoleNow.Add(rk);
            return true;
        }

        static bool HeldBack() => Refused.Count > 0;

        static (Dictionary<string, int> Found, Dictionary<string, List<int>> Ways, List<string> Differ, List<string> Drift, Dictionary<string, int> Several) ProfileCheck()
        {
            var found = new Dictionary<string, int>();
            var waysMap = new Dictionary<string, List<int>>();
            var differ = new List<string>();
            var drift = new List<string>();
            var several = new Dictionary<string, int>();

            foreach (var key in _locators.Keys.OrderBy(k => k, StringComparer.Ordinal))
            {
                var list = _locators[key];
                var each = list.Select(w => Matches(w)).ToList();
                var at = each.FindIndex(hits => hits.Count > 0);
                found[key] = at >= 0 ? each[at].Count : 0;

                if (at >= 0 && !list[at].Placed && each[at].Count > 1)
                {
                    var singled = each.Where((hits, i) => i != at && !list[i].Placed && hits.Count == 1 && SameElement(hits[0], each[at][0])).Any();
                    if (!singled) several[key] = each[at].Count;
                }

                if (each.Count <= 1) continue;
                waysMap[key] = each.Select(h => h.Count).ToList();
                var firsts = each.Where(h => h.Count > 0).Select(h => h[0]).ToList();
                if (firsts.Count > 0 && firsts.Any(e => !SameElement(e, firsts[0]))) differ.Add(key);

                if (at > 0 && each[at].Count > 0)
                {
                    var hit = each[at][0];
                    var lost = list.Take(at).Any(way =>
                    {
                        if (way.Kind != "mark") return false;
                        if (way.Role != null && !RoleMatches(hit, way.Role, way)) return false;
                        if (way.Roles.Count > 0 && !way.Roles.Any(r => RoleMatches(hit, r, way))) return false;
                        if (way.Inside != null)
                        {
                            var box = Find(way.Inside);
                            if (box != null) return Within(box, e => SameElement(e, hit)).Count > 0;
                        }
                        return true;
                    });
                    if (lost) drift.Add(key);
                }
            }
            return (found, waysMap, differ, drift, several);
        }

        // ---- warm / probe / inspect ----

        static bool TreeAtLeast(AutomationElement root, int targetCount, int maxDepth)
        {
            var seen = 0;
            Walk(root, _ => { seen++; return seen >= targetCount; }, 0, maxDepth);
            return seen >= targetCount;
        }

        static Dictionary<string, object?> RunWarm(List<string> args)
        {
            if (_root == null) return Fail("not_running", "桌面版没有在运行");
            var anchors = ProfileStrings(_profile, "refreshAnchors");
            var ready = anchors.Count == 0
                ? TreeAtLeast(_root, 40, 12)
                : anchors.Any(k => Find(k) != null);
            var answer = new Dictionary<string, object?>
            {
                ["ok"] = true,
                ["ready"] = ready,
                ["elements"] = CurrentCache.Count,
            };
            if (args.Contains("check") && ready)
            {
                var check = ProfileCheck();
                answer["checked"] = true;
                answer["drift"] = check.Drift;
                answer["differ"] = check.Differ;
            }
            return answer;
        }

        static Dictionary<string, object?> RunProbe(List<string> args)
        {
            if (_root == null) return Fail("not_running", "桌面版没有在运行");
            if (args.Count > 1 && !string.IsNullOrEmpty(args[1]))
            {
                var key = args[1];
                var ways = WaysOf(key);
                if (ways.Count == 0) return Fail("no_locator", $"profile 里没有 {key} 的认法");
                var report = ways.Select(way => new Dictionary<string, object?>
                {
                    ["way"] = way.Raw.ToString(),
                    ["hits"] = Matches(way).Select(Brief).ToList(),
                }).ToList();
                return new Dictionary<string, object?> { ["ok"] = true, ["key"] = key, ["ways"] = report };
            }

            var check = ProfileCheck();
            return new Dictionary<string, object?>
            {
                ["ok"] = true,
                ["onScreen"] = _hwnd != IntPtr.Zero && NativeMethods.IsWindowVisible(_hwnd),
                ["current"] = CurrentTitle(),
                ["found"] = check.Found,
                ["ways"] = check.Ways,
                ["differ"] = check.Differ,
                ["drift"] = check.Drift,
                ["several"] = check.Several,
            };
        }

        static Dictionary<string, object?> RunInspect(List<string> args)
        {
            if (_root == null) return Fail("not_running", "桌面版没有在运行");
            if (args.Count == 2 && int.TryParse(args[1], out var depth))
                return new Dictionary<string, object?> { ["ok"] = true, ["tree"] = Describe(_root, depth) };

            Dictionary<string, object?> Facts(AutomationElement e)
            {
                var info = new Dictionary<string, object?> { ["role"] = RoleName(e) };
                var n = NameOf(e);
                if (!string.IsNullOrEmpty(n)) info["name"] = n.Length > 80 ? n[..80] : n;
                var aid = AutomationIdOf(e);
                if (!string.IsNullOrEmpty(aid)) info["id"] = aid;
                var cls = ClassNameOf(e);
                if (!string.IsNullOrEmpty(cls)) info["class"] = cls.Split(' ', StringSplitOptions.RemoveEmptyEntries);
                return info;
            }

            var asked = args.Skip(1).ToList();
            var keys = asked.Count > 0 ? asked : _locators.Keys.OrderBy(k => k, StringComparer.Ordinal).ToList();
            var controls = new Dictionary<string, object?>();
            var walker = TreeWalker.RawViewWalker;
            foreach (var key in keys)
            {
                controls[key] = FindAll(key).Take(3).Select(hit =>
                {
                    var own = Facts(hit);
                    var boxes = new List<Dictionary<string, object?>>();
                    var at = hit;
                    for (var i = 0; i < 12; i++)
                    {
                        AutomationElement? up = null;
                        try { up = walker.GetParent(at); } catch { }
                        if (up == null || SameElement(up, _root)) break;
                        at = up;
                        var box = Facts(at);
                        if (box.Count > 1) boxes.Add(box);
                        if (TypeOf(at) == ControlType.Document) break;
                    }
                    own["in"] = boxes;
                    return own;
                }).ToList();
            }

            var res = new Dictionary<string, object?>
            {
                ["ok"] = true,
                ["current"] = CurrentTitle(),
                ["controls"] = controls,
            };
            if (args.Count == 1) res["tree"] = Describe(_root, 6);
            return res;
        }

        // ---- label & title ----

        static (string Label, string Value)? Labelled(string text)
        {
            var ascii = text.IndexOf(": ", StringComparison.Ordinal);
            var wide = text.IndexOf('：');
            if (ascii < 0 && wide < 0) return null;
            if (ascii >= 0 && (wide < 0 || ascii < wide))
                return (text[..ascii], text[(ascii + 2)..].Trim());
            return (text[..wide], text[(wide + 1)..].Trim());
        }

        static string CurrentTitle()
        {
            if (_root == null) return "";
            var suffix = _modeTitleSuffix ?? ProfileString(_profile, "titleSuffix");
            var blanks = ProfileStrings(_profile, "blankTitles");
            var candidates = new List<string>();

            Walk(_root, e =>
            {
                if (TypeOf(e) == ControlType.Document)
                {
                    var n = NameOf(e);
                    if (!string.IsNullOrEmpty(n)) candidates.Add(n);
                }
                return false;
            });
            var rootName = NameOf(_root);
            if (!string.IsNullOrEmpty(rootName)) candidates.Add(rootName);

            foreach (var title in candidates)
            {
                if (!string.IsNullOrEmpty(suffix))
                {
                    if (title.EndsWith(suffix, StringComparison.Ordinal)) return title[..^suffix.Length];
                    continue;
                }
                if (!blanks.Contains(title, StringComparer.Ordinal)) return title;
            }
            return "";
        }

        // ---- acting ----

        static bool Until(double seconds, Func<bool> done, double stepSeconds = 0.1)
        {
            var deadline = DateTime.UtcNow.AddSeconds(seconds);
            while (true)
            {
                if (done()) return true;
                if (DateTime.UtcNow >= deadline) return false;
                Thread.Sleep((int)(stepSeconds * 1000));
                Stale();
            }
        }

        static bool TryPress(AutomationElement element, bool checkSole = true)
        {
            if (checkSole && !Sole(element)) return false;
            try
            {
                if (element.TryGetCurrentPattern(InvokePattern.Pattern, out var ip) && ip is InvokePattern inv)
                {
                    inv.Invoke(); Stale(); return true;
                }
                if (element.TryGetCurrentPattern(SelectionItemPattern.Pattern, out var sp) && sp is SelectionItemPattern sel)
                {
                    sel.Select(); Stale(); return true;
                }
                if (element.TryGetCurrentPattern(TogglePattern.Pattern, out var tp) && tp is TogglePattern tog)
                {
                    tog.Toggle(); Stale(); return true;
                }
                if (element.TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out var ep) && ep is ExpandCollapsePattern exp)
                {
                    if (exp.Current.ExpandCollapseState == ExpandCollapseState.Collapsed) exp.Expand();
                    else exp.Collapse();
                    Stale();
                    return true;
                }
            }
            catch { }
            return false;
        }

        static bool SetValue(AutomationElement element, string text, bool checkSole = true)
        {
            if (checkSole && !Sole(element)) return false;
            try
            {
                if (element.TryGetCurrentPattern(ValuePattern.Pattern, out var pat) && pat is ValuePattern vp && !vp.Current.IsReadOnly)
                {
                    vp.SetValue(text);
                    Stale();
                    return true;
                }
            }
            catch { }
            return false;
        }

        static bool BorrowFocusAndPaste(AutomationElement composer, string text, bool checkSole = true)
        {
            if (checkSole && !Sole(composer)) return false;
            var before = NativeMethods.GetForegroundWindow();
            var pasted = false;
            try
            {
                composer.SetFocus();
                var thread = new Thread(() =>
                {
                    try
                    {
                        var copied = false;
                        for (var attempt = 0; attempt < 3; attempt++)
                        {
                            try { System.Windows.Clipboard.SetText(text); copied = true; break; }
                            catch { if (attempt < 2) Thread.Sleep(25); }
                        }
                        if (!copied) return;
                        System.Windows.Forms.SendKeys.SendWait("^a");
                        Thread.Sleep(20);
                        System.Windows.Forms.SendKeys.SendWait("^v");
                        Thread.Sleep(50);
                        pasted = true;
                    }
                    catch { }
                });
                thread.SetApartmentState(ApartmentState.STA);
                thread.Start();
                if (!thread.Join(2000)) return false;
            }
            catch { return false; }
            finally { if (before != IntPtr.Zero) NativeMethods.SetForegroundWindow(before); Stale(); }
            return pasted;
        }

        static bool BorrowFocusAndKey(AutomationElement? target, string keys, bool checkSole = true)
        {
            if (target != null && checkSole && !Sole(target)) return false;
            var before = NativeMethods.GetForegroundWindow();
            var sent = false;
            try
            {
                target?.SetFocus();
                var thread = new Thread(() =>
                {
                    try
                    {
                        System.Windows.Forms.SendKeys.SendWait(keys);
                        Thread.Sleep(50);
                        sent = true;
                    }
                    catch { }
                });
                thread.SetApartmentState(ApartmentState.STA);
                thread.Start();
                if (!thread.Join(2000)) return false;
            }
            catch { return false; }
            finally { if (before != IntPtr.Zero) NativeMethods.SetForegroundWindow(before); Stale(); }
            return sent;
        }

        static bool Key(string sendKeysToken)
        {
            if (HeldBack() && sendKeysToken != "{ESC}") { Trace($"key {sendKeysToken} held back"); return false; }
            return BorrowFocusAndKey(_root, sendKeysToken, checkSole: false);
        }

        static bool ClearField(string key)
        {
            var box = Find(key);
            if (box == null) return true;
            if (string.IsNullOrEmpty(ValueOf(box))) return true;
            if (SetValue(box, "")) return true;
            return BorrowFocusAndPaste(box, "");
        }

        static AutomationElement? SendButton(string key)
        {
            var hit = Find(key);
            if (hit != null) return hit;
            var slotKey = ProfileString(_profile, "sendSlot");
            if (string.IsNullOrEmpty(slotKey) || _slotIdleName == null) return null;
            var slot = Find(slotKey);
            if (slot == null) return null;
            var own = NameOf(slot);
            return !string.IsNullOrEmpty(own) && own != _slotIdleName ? slot : null;
        }

        static bool HoldsText(AutomationElement box)
        {
            var v = ValueOf(box).Trim();
            return !string.IsNullOrEmpty(v) && v != NameOf(box);
        }

        static bool FillField(string fieldKey, string text, string readyKey, ref bool tookFocus)
        {
            if (_slotIdleName == null)
            {
                var b0 = Find(fieldKey);
                var sKey = ProfileString(_profile, "sendSlot");
                if (b0 != null && !HoldsText(b0) && !string.IsNullOrEmpty(sKey))
                {
                    var slot = Find(sKey);
                    if (slot != null) _slotIdleName = NameOf(slot);
                }
            }
            for (var attempt = 0; attempt < 2; attempt++)
            {
                var box = Find(fieldKey);
                if (box == null) { Thread.Sleep(200); Stale(); continue; }
                var wrote = SetValue(box, text);
                if (!wrote) { tookFocus = true; wrote = BorrowFocusAndPaste(box, text); }
                if (wrote)
                {
                    var ok = Until(0.8, () =>
                    {
                        var b = Find(fieldKey);
                        if (b == null) return false;
                        return ValueOf(b).Trim() == text.Trim() || SendButton(readyKey) != null;
                    }, 0.2);
                    if (ok || SendButton(readyKey) != null) return true;
                }
            }
            return false;
        }

        // ---- menus & dialogs ----

        static List<AutomationElement> Items() => Every(e => TypeOf(e) == ControlType.MenuItem || TypeOf(e) == ControlType.ListItem);
        static bool Named(AutomationElement e, string text) { var n = NameOf(e); return n == text || n.StartsWith(text + " ", StringComparison.Ordinal); }
        static AutomationElement? Item(string text) => Items().FirstOrDefault(e => Named(e, text));

        static List<AutomationElement> MenuRows(AutomationElement? opener)
        {
            if (!_locators.ContainsKey("menuPopup")) return Items();
            var own = opener != null ? NameOf(opener) : "";
            if (string.IsNullOrEmpty(own)) return [];
            var box = FindAll("menuPopup").FirstOrDefault(e => NameOf(e) == own);
            return box != null ? Within(box, e => TypeOf(e) == ControlType.MenuItem || TypeOf(e) == ControlType.ListItem) : [];
        }

        static bool Wordless(List<AutomationElement> rows, IEnumerable<string> words)
            => !rows.Any(row => words.Any(w => !string.IsNullOrEmpty(w) && Named(row, w)));

        static bool OpenMenu(Func<AutomationElement?> getMenu, Func<bool>? opened = null)
        {
            Stale();
            var button = getMenu();
            if (button == null) return false;
            _anchor = button;
            if (!Expanded(button))
            {
                if (ProfileString(_profile, "offscreenMenu") == "key" && !(_hwnd != IntPtr.Zero && NativeMethods.IsWindowVisible(_hwnd)))
                {
                    if (!BorrowFocusAndKey(button, "{DOWN}", checkSole: true)) return false;
                }
                else if (!TryPress(button))
                {
                    return false;
                }
            }

            var shown = Until(3.0, () =>
            {
                var btn = getMenu();
                if (btn != null && Expanded(btn) && (opened?.Invoke() ?? Items().Count > 0)) { _anchor = btn; return true; }
                return false;
            }, 0.08);
            if (!shown) _anchor = null;
            if (shown)
            {
                var btn = getMenu();
                if (btn != null && !ConfirmedMenu(btn)) { CloseMenu(getMenu); return false; }
            }
            return shown;
        }

        static bool ConfirmedMenu(AutomationElement button)
        {
            var rk = RuntimeKey(button);
            if (!Origin.TryGetValue(rk, out var from)) return true;
            var ways = WaysOf(from.Key);
            if (from.Way < 0 || from.Way >= ways.Count || !ways[from.Way].Placed) return true;
            var signEl = ProfileElement(_profile, "menuSigns", from.Key);
            if (signEl == null) return true;
            var signs = ParseLocatorList(from.Key, signEl.Value);
            var holds = Until(1.2, () => MenuRows(button).Any(row => signs.Any(s => Fits(row, s))));
            if (!holds) Unconfirmed.Add(from.Key);
            return holds;
        }

        static void CloseMenu(Func<AutomationElement?> getMenu)
        {
            Stale();
            _anchor = null;
            var button = getMenu();
            if (button == null || !Expanded(button)) return;
            if (ProfileString(_profile, "offscreenMenu") == "key") TryPress(button, checkSole: false);
            else Key("{ESC}");
            Until(0.5, () => { var b = getMenu(); return b == null || !Expanded(b); }, 0.06);
        }

        static AutomationElement? Dialog() => First(e => TypeOf(e) == ControlType.Window && !SameElement(e, _root));
        static void DismissDialog()
        {
            var box = Dialog();
            if (box == null) return;
            var cancel = Within(box, e => !_locators.ContainsKey("cancel") ? (TypeOf(e) == ControlType.Button && NameOf(e) == "Cancel") : FitsKey(e, "cancel")).FirstOrDefault();
            if (cancel != null) { TryPress(cancel, checkSole: false); Thread.Sleep(400); Stale(); }
        }

        // ---- navigation & modes ----

        static AutomationElement? SidebarRow(string title)
        {
            var rows = Every(e => TypeOf(e) == ControlType.Button && NameOf(e).StartsWith(title, StringComparison.Ordinal));
            return rows.FirstOrDefault(r => NameOf(r) == title)
                ?? rows.FirstOrDefault(r => NameOf(r).StartsWith(title + " ", StringComparison.Ordinal))
                ?? rows.FirstOrDefault();
        }

        static void OpenSessionLink(string template, Dictionary<string, string> ids)
        {
            var link = template;
            foreach (var (k, v) in ids) link = link.Replace($"{{{k}}}", Uri.EscapeDataString(v));
            try
            {
                Process.Start(new ProcessStartInfo { FileName = link, UseShellExecute = true });
                Thread.Sleep(300);
                Stale();
            }
            catch { }
        }

        static bool ShowSession(string title, Dictionary<string, string>? ids = null)
        {
            if (string.IsNullOrEmpty(title)) return false;
            if (CurrentTitle() == title) return true;
            var link = ProfileString(_profile, "sessionLink");
            for (var attempt = 0; attempt < 4; attempt++)
            {
                var btn = SidebarRow(title);
                if (btn != null) TryPress(btn, checkSole: false);
                else if (attempt == 1 && !string.IsNullOrEmpty(link) && ids != null && ids.Count > 0 && !ids.Values.Any(string.IsNullOrEmpty))
                    OpenSessionLink(link, ids);
                if (Until(2.0, () => CurrentTitle() == title)) return true;
            }
            return false;
        }

        static string? ShownSpace()
        {
            var spec = ProfileElement(_profile, "spaces");
            if (spec == null || spec.Value.ValueKind != JsonValueKind.Object) return null;
            var controlKey = ProfileString(_profile, "spaces", "control");
            var names = ProfileMap(_profile, "spaces", "names");
            var isMenu = ProfileString(_profile, "spaces", "kind") == "menu";
            var control = string.IsNullOrEmpty(controlKey) ? null : Find(controlKey);
            if (control == null) return null;

            string word;
            if (isMenu)
            {
                var prefix = ProfileString(_profile, "spaces", "currentPrefix");
                var own = NameOf(control);
                word = !string.IsNullOrEmpty(prefix) && own.StartsWith(prefix, StringComparison.Ordinal)
                    ? own[prefix.Length..]
                    : Labelled(own)?.Value ?? "";
            }
            else
            {
                var radio = Within(control, e => TypeOf(e) == ControlType.RadioButton && Checked(e)).FirstOrDefault();
                var raw = radio != null ? NameOf(radio) : "";
                var comma = raw.IndexOfAny([',', '，']);
                word = (comma >= 0 ? raw[..comma] : raw).Trim();
            }
            return names.FirstOrDefault(kv => kv.Value == word).Key ?? "";
        }

        static (string Code, string Message)? SwitchSpace(string id)
        {
            var names = ProfileMap(_profile, "spaces", "names");
            if (!names.TryGetValue(id, out var word)) return ("unknown_space", $"{_appName}没有这个模式");
            var controlKey = ProfileString(_profile, "spaces", "control");
            if (string.IsNullOrEmpty(controlKey) || Find(controlKey) == null) return ("no_space_switch", $"没能在{_appName}上找到切换模式的地方");
            if (ShownSpace() == id) return null;

            var isMenu = ProfileString(_profile, "spaces", "kind") == "menu";
            if (isMenu)
            {
                if (!OpenMenu(() => Find(controlKey))) return ("no_space_switch", $"没能打开{_appName}切换模式的菜单");
                var entry = Item(word);
                if (entry == null) { CloseMenu(() => Find(controlKey)); return ("no_space_switch", $"{_appName}切换模式的菜单里没有「{word}」"); }
                TryPress(entry, checkSole: false);
                _anchor = null;
            }
            else
            {
                var ctrl = Find(controlKey);
                var option = ctrl != null
                    ? Within(ctrl, e => TypeOf(e) == ControlType.RadioButton && ((NameOf(e).IndexOfAny([',', '，']) is var c and >= 0 ? NameOf(e)[..c] : NameOf(e)).Trim() == word)).FirstOrDefault()
                    : null;
                if (option == null) return ("no_space_switch", $"{_appName}的模式切换里没有「{word}」");
                TryPress(option, checkSole: false);
            }

            if (Until(3.2, () => ShownSpace() == id, 0.2)) { Thread.Sleep(400); Stale(); return null; }
            return ("space_not_set", $"在{_appName}里切到「{word}」模式，但没有切过去");
        }

        static Dictionary<string, object?>? MaybeApplyModeSwitch(string cmd)
        {
            var spec = ProfileElement(_profile, "spaces");
            if (spec == null || spec.Value.ValueKind != JsonValueKind.Object) return null;
            var target = _cli.Wanted.TryGetValue("space", out var ws) && !string.IsNullOrEmpty(ws)
                ? ws
                : ProfileString(_profile, "spaces", "home");
            if (string.IsNullOrEmpty(target)) return null;

            var map = ProfileMap(_profile, "spaces", "titleSuffix");
            if (map.TryGetValue(target, out var sfx) && !string.IsNullOrEmpty(sfx)) _modeTitleSuffix = sfx;

            if (cmd == "chat-status") return null;
            var before = ShownSpace();
            if (before == null) return null;
            if (cmd == "new-leave" && before != target)
                return new Dictionary<string, object?> { ["ok"] = true, ["left"] = false, ["moved"] = true };

            var own = before != target ? before : _cli.ParkedSpace;
            if (before != target)
            {
                var err = SwitchSpace(target);
                if (err != null) return Fail(err.Value.Code, err.Value.Message);
            }
            if (cmd is not ("open-file" or "show-session") && !string.IsNullOrEmpty(own) && own != target)
            {
                _personSpace = own;
                _beforeExit = () => SwitchSpace(own)?.Message;
            }
            return null;
        }

        // ---- settings (model / effort / permission mode) ----

        static string NormSetting(string s) => s.ToLowerInvariant().Replace('-', ' ').Trim();

        static (List<string> Changed, List<string> Notes, Dictionary<string, string> Shown) ApplySettings()
        {
            var changed = new List<string>();
            var notes = new List<string>();
            var isCodexStyle = _profile.ValueKind == JsonValueKind.Object && _profile.TryGetProperty("effortNames", out _);
            var wantAny = _cli.Wanted.Where(kv => kv.Key != "space" && !string.IsNullOrEmpty(kv.Value)).Any();

            if (!wantAny)
            {
                return (changed, notes, ReadShownSettings(isCodexStyle));
            }

            if (isCodexStyle)
            {
                ApplyCodexSettings(changed);
            }
            else
            {
                ApplyClaudeSettings(changed, notes);
            }
            return (changed, notes, ReadShownSettings(isCodexStyle));
        }

        static Dictionary<string, string> ReadShownSettings(bool isCodexStyle)
        {
            var m = Find("modelMenu");
            var modelStr = "";
            if (m != null)
            {
                var raw = NameOf(m);
                modelStr = isCodexStyle ? raw : (Labelled(raw)?.Value ?? raw);
            }
            if (isCodexStyle) return new Dictionary<string, string> { ["model"] = modelStr };

            var modeBtn = ClaudeModeMenu();
            return new Dictionary<string, string> { ["model"] = modelStr, ["mode"] = modeBtn != null ? NameOf(modeBtn) : "" };
        }

        static void ApplyCodexSettings(List<string> changed)
        {
            Until(2.0, () => Find("modelMenu") != null, 0.2);
            AutomationElement? MenuBtn() => Find("modelMenu");
            if (MenuBtn() == null) throw new DriverStopException("no_model_menu", "Codex 桌面版的输入框下面没有模型菜单");

            try
            {
                if (_cli.Wanted.TryGetValue("model", out var model) && !string.IsNullOrEmpty(model))
                {
                    bool ShowsModel()
                    {
                        var btn = MenuBtn();
                        var s = NormSetting(btn != null ? NameOf(btn) : "");
                        var w = NormSetting(model);
                        return s == w || s.StartsWith(w + " ", StringComparison.Ordinal);
                    }
                    if (!ShowsModel())
                    {
                        if (!OpenMenu(MenuBtn)) throw new DriverStopException("no_model_menu", "没能打开 Codex 桌面版的模型菜单");
                        var selectRow = Find("selectModelRow") ?? Item(ProfileString(_profile, "selectModelItem"));
                        if (selectRow == null) throw new DriverStopException("no_model_menu", "Codex 桌面版的模型菜单里找不到选模型的入口");
                        TryPress(selectRow, checkSole: false);
                        AutomationElement? choice = null;
                        Until(2.4, () => { choice = Items().FirstOrDefault(e => NormSetting(NameOf(e)) == NormSetting(model)); return choice != null; }, 0.2);
                        if (choice == null) throw new DriverStopException("model_unavailable", $"Codex 桌面版的模型菜单里没有 {model}");
                        TryPress(choice, checkSole: false);
                        Until(2.4, () => { var b = MenuBtn(); return b == null || !Expanded(b); }, 0.2);
                        CloseMenu(MenuBtn);
                        Until(1.6, ShowsModel, 0.2);
                        if (!ShowsModel()) throw new DriverStopException("model_not_set", $"在 Codex 桌面版里选了 {model}，但它没有切换过去");
                        changed.Add("model");
                    }
                }

                if (_cli.Wanted.TryGetValue("effort", out var effort) && !string.IsNullOrEmpty(effort))
                {
                    var effortNames = ProfileMap(_profile, "effortNames");
                    if (!effortNames.TryGetValue(effort, out var label))
                        throw new DriverStopException("effort_unavailable", $"Codex 桌面版没有「{effort}」这一档推理强度");

                    bool ShowsEffort() { var b = MenuBtn(); return b != null && NameOf(b).EndsWith(" " + label, StringComparison.Ordinal); }
                    if (!ShowsEffort())
                    {
                        var steps = ProfileMap(_profile, "effortSteps");
                        var step = steps.GetValueOrDefault(label, label);
                        var order = ProfileStrings(_profile, "effortOrder");
                        if (!OpenMenu(MenuBtn)) throw new DriverStopException("no_effort_menu", "没能打开 Codex 桌面版的推理强度滑块");
                        var power = Find("effortRow") ?? Item(ProfileString(_profile, "effortItem"));
                        if (power == null) throw new DriverStopException("no_effort_menu", "没能打开 Codex 桌面版的推理强度滑块");
                        try { power.SetFocus(); } catch { }
                        Thread.Sleep(200); Stale();

                        (string Name, int Index, int Count)? At()
                        {
                            var status = string.Join("", Every(e => TypeOf(e) == ControlType.Text && NameOf(e).Contains(" of ", StringComparison.Ordinal)).Select(NameOf));
                            if (string.IsNullOrEmpty(status)) status = ValueOf(power);
                            var m = Regex.Match(status, @", (\d+) of (\d+)\.?$");
                            if (!m.Success) return null;
                            var idx = int.Parse(m.Groups[1].Value);
                            var cnt = int.Parse(m.Groups[2].Value);
                            var head = status[..m.Index];
                            var nm = head.EndsWith(" " + step, StringComparison.Ordinal) ? step : (head.Split(' ').LastOrDefault() ?? "");
                            return (nm, idx, cnt);
                        }

                        var start = At();
                        if (start == null) throw new DriverStopException("no_effort_menu", "读不到 Codex 桌面版推理强度滑块的位置");
                        var words = new HashSet<string>(effortNames.Values.Concat(steps.Values), StringComparer.Ordinal);
                        var place = order.IndexOf(effort) + 1;
                        var byPlace = !words.Contains(start.Value.Name) && place > 0 && start.Value.Count == order.Count;
                        bool There() { var now = At(); return now != null && (byPlace ? now.Value.Index == place : now.Value.Name == step); }

                        var found = There();
                        if (!found) { for (var i = 0; i < start.Value.Index; i++) Key("{LEFT}"); found = There(); }
                        for (var i = 0; i < start.Value.Count && !found; i++) { Key("{RIGHT}"); found = There(); }
                        var moved = At()?.Index != start.Value.Index;
                        CloseMenu(MenuBtn);
                        bool Worded() => effortNames.Values.Any(v => MenuBtn() is { } b && NameOf(b).EndsWith(" " + v, StringComparison.Ordinal));
                        Until(1.6, () => ShowsEffort() || !Worded(), 0.2);
                        if (!found || (!ShowsEffort() && Worded()))
                            throw new DriverStopException("effort_not_set", $"Codex 桌面版里这个模型没有「{label}」这一档推理强度");
                        if (moved) changed.Add("effort");
                    }
                }
            }
            finally { CloseMenu(MenuBtn); }
        }

        static AutomationElement? ClaudeModeMenu()
        {
            var model = Find("modelMenu");
            if (model == null) return null;
            var modes = ProfileStrings(_profile, "modes");
            var buttons = Every(e => RoleMatches(e, "AXPopUpButton"));
            var past = buttons.SkipWhile(b => !SameElement(b, model)).Skip(1).ToList();
            return past.FirstOrDefault(b => modes.Any(m => Named(b, m))) ?? past.FirstOrDefault();
        }

        static string ClaudeShownModel()
        {
            var btn = Find("modelMenu");
            if (btn == null) return "";
            var n = NameOf(btn);
            return Labelled(n)?.Value ?? n;
        }

        static void ApplyClaudeSettings(List<string> changed, List<string> notes)
        {
            Until(2.0, () => Find("modelMenu") != null, 0.2);
            AutomationElement? ModelBtn() => Find("modelMenu");
            AutomationElement? ModeBtn() => ClaudeModeMenu();
            try
            {
                if (_cli.Wanted.TryGetValue("model", out var model) && !string.IsNullOrEmpty(model))
                {
                    bool Shows() { var now = ClaudeShownModel(); return now == model || now.StartsWith(model + " ", StringComparison.Ordinal); }
                    if (!Shows())
                    {
                        if (!OpenMenu(ModelBtn)) throw new DriverStopException("no_model_menu", "没能打开 Claude 桌面版的模型菜单");
                        var choice = Item(model);
                        if (choice == null)
                        {
                            var more = Item(ProfileString(_profile, "moreModelsItem"));
                            if (more != null) { TryPress(more, checkSole: false); Thread.Sleep(250); Stale(); choice = Item(model); }
                        }
                        if (choice == null) throw new DriverStopException("model_unavailable", "Claude 桌面版的模型菜单里没有这个模型");
                        TryPress(choice, checkSole: false);

                        var confirmed = false;
                        var asked = "";
                        for (var i = 0; i < 16; i++)
                        {
                            Thread.Sleep(200); Stale();
                            if (!confirmed && Dialog() is { } box)
                            {
                                asked = Within(box, e => TypeOf(e) == ControlType.Text).Select(NameOf).OrderByDescending(s => s.Length).FirstOrDefault() ?? asked;
                                var confirms = Within(box, e => FitsKey(e, "dialogConfirm"));
                                if (confirms.Count == 1) { if (!string.IsNullOrEmpty(asked)) notes.Add(asked); TryPress(confirms[0], checkSole: false); confirmed = true; }
                            }
                            else if (Shows()) break;
                        }
                        if (!confirmed && Dialog() != null)
                        {
                            DismissDialog();
                            throw new DriverStopException("model_confirm", string.IsNullOrEmpty(asked)
                                ? "切换模型时 Claude 桌面版弹出了确认，请到桌面版里操作"
                                : $"切换模型时 Claude 桌面版弹出了确认，没能在里面确认，请到桌面版里操作。桌面版的提示：{asked}");
                        }
                        CloseMenu(ModelBtn);
                        if (!Shows()) throw new DriverStopException("model_not_set", "在 Claude 桌面版里选了这个模型，但它没有切换过去");
                        changed.Add("model");
                    }
                }

                if (_cli.Wanted.TryGetValue("effort", out var effort) && !string.IsNullOrEmpty(effort))
                {
                    if (!ClaudeShownModel().EndsWith(" " + effort, StringComparison.Ordinal))
                    {
                        var effortWord = ProfileString(_profile, "effortItem");
                        if (!OpenMenu(ModelBtn)) throw new DriverStopException("no_model_menu", "没能打开 Claude 桌面版的模型菜单");
                        var own = Item(effortWord);
                        if (own == null) throw new DriverStopException("effort_unavailable", "这个模型在 Claude 桌面版里不能调推理强度");
                        if (NameOf(own) != $"{effortWord} {effort}")
                        {
                            TryPress(own, checkSole: false);
                            Thread.Sleep(250); Stale();
                            var rows = MenuRows(own);
                            var choice = rows.FirstOrDefault(r => Named(r, effort)) ?? Item(effort);
                            if (choice == null)
                            {
                                var efforts = ProfileStrings(_profile, "efforts");
                                var idx = efforts.IndexOf(effort);
                                if (idx >= 0 && Wordless(rows, efforts) && idx < rows.Count) choice = rows[idx];
                            }
                            if (choice == null) throw new DriverStopException("effort_unavailable", "Claude 桌面版的推理强度菜单里没有这一档");
                            TryPress(choice, checkSole: false);
                            Thread.Sleep(400);
                            CloseMenu(ModelBtn);
                            if (!OpenMenu(ModelBtn) || (!(Item(effortWord) is { } checkRow && NameOf(checkRow) == $"{effortWord} {effort}") && !ClaudeShownModel().EndsWith(" " + effort, StringComparison.Ordinal)))
                                throw new DriverStopException("effort_not_set", "在 Claude 桌面版里选了这档推理强度，但它没有切换过去");
                            changed.Add("effort");
                        }
                        CloseMenu(ModelBtn);
                    }
                }

                if (_cli.Wanted.TryGetValue("mode", out var mode) && !string.IsNullOrEmpty(mode))
                {
                    var btn = ModeBtn();
                    if (btn == null) throw new DriverStopException("no_mode_menu", "没能打开 Claude 桌面版的权限菜单");
                    if (!Named(btn, mode))
                    {
                        if (!OpenMenu(ModeBtn)) throw new DriverStopException("no_mode_menu", "没能打开 Claude 桌面版的权限菜单");
                        var choice = Item(mode);
                        if (choice == null)
                        {
                            var modes = ProfileStrings(_profile, "modes");
                            var rows = MenuRows(ModeBtn());
                            var place = modes.IndexOf(mode);
                            if (place >= 0 && Wordless(rows, modes) && rows.Count == modes.Count) choice = rows[place];
                        }
                        if (choice == null) throw new DriverStopException("mode_unavailable", "Claude 桌面版的权限菜单里没有这个模式");
                        if (!Checked(choice))
                        {
                            var lockSuffix = ProfileString(_profile, "modeLockedSuffix");
                            if (string.IsNullOrEmpty(lockSuffix)) lockSuffix = "Enable";
                            if (NameOf(choice).EndsWith(" " + lockSuffix, StringComparison.Ordinal))
                                throw new DriverStopException("mode_locked", "Claude 桌面版里还没有启用这个权限模式，请先在桌面版里启用它");
                            TryPress(choice, checkSole: false);
                            Thread.Sleep(400); Stale();
                            if (Dialog() != null)
                            {
                                DismissDialog();
                                throw new DriverStopException("mode_confirm", "切换到这个权限模式需要在 Claude 桌面版里确认，请到桌面版里操作");
                            }
                            CloseMenu(ModeBtn);
                            if (ModeBtn() is { } after && !Named(after, mode))
                                throw new DriverStopException("mode_not_set", "在 Claude 桌面版里选了这个权限模式，但它没有切换过去");
                            changed.Add("mode");
                        }
                        CloseMenu(ModeBtn);
                    }
                }
            }
            catch { DismissDialog(); CloseMenu(ModelBtn); CloseMenu(ModeBtn); throw; }
        }

        // ---- send / send-now / stop / settings / open-file / show-session ----

        static Dictionary<string, object?> RunSend(List<string> args, TextReader stdin)
        {
            var text = stdin.ReadToEnd();
            if (string.IsNullOrEmpty(text)) return Fail("usage", "消息是空的");

            var title = args.Count > 1 ? args[1] : "";
            var localId = args.Count > 2 && args[2] != "-" ? args[2] : "";
            var steer = args.Skip(1).Any(a => a == "steer");
            var previous = CurrentTitle();
            if (string.IsNullOrEmpty(previous)) previous = _cli.ParkedPrevious;

            var targeted = false;
            if (!string.IsNullOrEmpty(title))
            {
                targeted = ShowSession(title, string.IsNullOrEmpty(localId) ? null : new Dictionary<string, string> { ["localId"] = localId });
                if (!targeted && !string.IsNullOrEmpty(localId))
                {
                    return Fail("not_found", $"没能在{_appName}里打开这个会话");
                }
            }

            if (!steer && FindControl("stop", "chatStop") != null)
            {
                if (targeted && !string.IsNullOrEmpty(previous) && previous != title) _ = ShowSession(previous);
                return Fail("busy", "这个会话正在 Claude 桌面版里运行，等这一轮结束再发");
            }

            (List<string> Changed, List<string> Notes, Dictionary<string, string> _) settings;
            try { settings = ApplySettings(); }
            catch (DriverStopException ex)
            {
                if (targeted && !string.IsNullOrEmpty(previous) && previous != title) _ = ShowSession(previous);
                return Fail(ex.Code, ex.Message);
            }

            var composerKey = Find("composer") != null ? "composer" : "chatComposer";
            var composer = FindControl(composerKey);
            if (composer == null) return Fail("no_composer", "没有找到输入框（profile 的 composer）");

            var tookFocus = false;
            if (!FillField(composerKey, text, "send", ref tookFocus))
            {
                if (targeted && !string.IsNullOrEmpty(previous) && previous != title) _ = ShowSession(previous);
                return Fail("no_fill", "输入框填不进文字");
            }

            var pressed = PressSend(composer, ref tookFocus);
            if (targeted && !string.IsNullOrEmpty(previous) && previous != title) _ = ShowSession(previous);

            var res = new Dictionary<string, object?>
            {
                ["ok"] = pressed,
                ["pressed"] = pressed,
                ["tookFocus"] = tookFocus,
                ["targeted"] = targeted,
                ["restored"] = previous,
            };
            if (settings.Changed.Count > 0) res["changed"] = settings.Changed;
            if (settings.Notes.Count > 0) res["notes"] = settings.Notes;
            return res;
        }

        static Dictionary<string, object?> RunSendNow(List<string> args)
        {
            if (args.Count < 2 || string.IsNullOrEmpty(args[1])) return Fail("usage", "缺少会话标题");
            var title = args[1];
            var localId = args.Count > 2 && args[2] != "-" ? args[2] : "";
            var previous = CurrentTitle();
            if (!ShowSession(title, string.IsNullOrEmpty(localId) ? null : new Dictionary<string, string> { ["localId"] = localId }))
                return Fail("not_found", $"没能在{_appName}里打开这个会话");
            var btn = Find("sendNow");
            if (btn == null || !TryPress(btn))
            {
                if (!string.IsNullOrEmpty(previous) && previous != title) _ = ShowSession(previous);
                return Fail("no_queue", "Claude 桌面版里没有排队中的消息");
            }
            Thread.Sleep(500);
            if (!string.IsNullOrEmpty(previous) && previous != title) _ = ShowSession(previous);
            return Ok();
        }

        static Dictionary<string, object?> RunStop(List<string> args)
        {
            var title = args.Count > 1 ? args[1] : "";
            var localId = args.Count > 2 && args[2] != "-" ? args[2] : "";
            var previous = CurrentTitle();
            var navigated = !string.IsNullOrEmpty(title) && ShowSession(title, string.IsNullOrEmpty(localId) ? null : new Dictionary<string, string> { ["localId"] = localId });

            var stop = FindControl("stop", "chatStop");
            if (stop != null && TryPress(stop))
            {
                if (navigated && !string.IsNullOrEmpty(previous) && previous != title) _ = ShowSession(previous);
                return new Dictionary<string, object?> { ["ok"] = true, ["pressed"] = true };
            }

            var composer = FindControl("composer", "chatComposer");
            if (composer != null && BorrowFocusAndKey(composer, "{ESC}"))
            {
                if (navigated && !string.IsNullOrEmpty(previous) && previous != title) _ = ShowSession(previous);
                return new Dictionary<string, object?> { ["ok"] = true, ["pressed"] = true, ["tookFocus"] = true };
            }
            if (navigated && !string.IsNullOrEmpty(previous) && previous != title) _ = ShowSession(previous);
            return Fail("no_stop", "没有找到停止控件，也按不到 Esc");
        }

        static Dictionary<string, object?> RunSettings(List<string> args)
        {
            if (args.Count < 2 || string.IsNullOrEmpty(args[1])) return Fail("usage", "缺少会话标题");
            var title = args[1];
            var localId = args.Count > 2 && args[2] != "-" ? args[2] : "";
            var previous = CurrentTitle();
            if (!ShowSession(title, string.IsNullOrEmpty(localId) ? null : new Dictionary<string, string> { ["localId"] = localId }))
                return Fail("not_found", $"没能在{_appName}里打开这个会话");
            try
            {
                var res = ApplySettings();
                if (!string.IsNullOrEmpty(previous) && previous != title) _ = ShowSession(previous);
                return new Dictionary<string, object?> { ["ok"] = true, ["changed"] = res.Changed, ["notes"] = res.Notes, ["shown"] = res.Shown };
            }
            catch (DriverStopException ex)
            {
                if (!string.IsNullOrEmpty(previous) && previous != title) _ = ShowSession(previous);
                return Fail(ex.Code, ex.Message);
            }
        }

        static Dictionary<string, object?> RunShowSession(List<string> args)
        {
            if (args.Count < 2 || string.IsNullOrEmpty(args[1])) return Fail("usage", "缺少会话标题");
            var title = args[1];
            var localId = args.Count > 2 && args[2] != "-" ? args[2] : "";
            if (!ShowSession(title, string.IsNullOrEmpty(localId) ? null : new Dictionary<string, string> { ["localId"] = localId }))
                return Fail("not_found", $"没能在{_appName}里打开这个会话");
            ActivateWindow(_hwnd);
            return Ok();
        }

        static Dictionary<string, object?> RunOpenFile(List<string> args)
        {
            if (args.Count < 5) return Fail("usage", "缺少会话标题或文件");
            var title = args[1];
            var localId = args[2] == "-" ? "" : args[2];
            if (!ShowSession(title, string.IsNullOrEmpty(localId) ? null : new Dictionary<string, string> { ["localId"] = localId }))
                return Fail("not_found", $"没能在{_appName}里打开这个会话");

            var rel = args[3];
            var abs = args[4];
            var label = args.Count > 5 ? args[5] : "";
            var bare = Regex.Replace(rel, @":\d+(:\d+)?$", "");
            var baseName = Path.GetFileName(bare);

            List<(AutomationElement Element, int Score)> FindLinks()
            {
                var hits = new List<(AutomationElement, int)>();
                if (_root == null) return hits;
                Walk(_root, e =>
                {
                    var ct = TypeOf(e);
                    if (ct != ControlType.Hyperlink && ct != ControlType.Button) return false;
                    var url = Uri.UnescapeDataString(UrlOf(e));
                    var own = NameOf(e).Trim();
                    var score = 0;
                    if (!string.IsNullOrEmpty(url) && ((!string.IsNullOrEmpty(abs) && url.EndsWith(abs, StringComparison.OrdinalIgnoreCase)) || url.EndsWith("/" + bare, StringComparison.OrdinalIgnoreCase) || url == bare)) score = 3;
                    else if (!string.IsNullOrEmpty(label) && own == label) score = 2;
                    else if (!string.IsNullOrEmpty(baseName) && (own == baseName || own == rel || own == bare)) score = 1;
                    if (score > 0) hits.Add((e, score));
                    return false;
                });
                return hits;
            }

            var hits = FindLinks();
            if (hits.Count == 0) Until(2.4, () => { hits = FindLinks(); return hits.Count > 0; }, 0.2);
            var best = hits.Count > 0 ? hits.Max(h => h.Score) : 0;
            var link = hits.LastOrDefault(h => h.Score == best).Element;
            if (link != null) { TryPress(link, checkSole: false); Thread.Sleep(300); }
            ActivateWindow(_hwnd);
            return new Dictionary<string, object?> { ["ok"] = true, ["pressed"] = link != null };
        }

        // ---- new-chat page (Codex & Claude) ----

        sealed record PageControl(AutomationElement Element, string Kind, string Label, string Value, string Title);
        sealed record PageChoice(AutomationElement Element, string Label, string Section, bool Selected);

        static List<PageControl> PageControls()
        {
            var outList = new List<PageControl>();
            if (_root == null) return outList;
            var heading = ProfileString(_profile, "newPageHeading");
            var skip = ProfileStrings(_profile, "newPageSkip");
            var skipToggles = ProfileStrings(_profile, "newPageSkipToggles");
            var startKey = ProfileString(_profile, "newPageStart");
            var menusEndKey = ProfileString(_profile, "newPageMenusBefore");
            var togglesAfterKey = ProfileString(_profile, "newPageTogglesAfter");
            var togglesInsideKey = ProfileString(_profile, "newPageSkipTogglesInside");

            var startAt = !string.IsNullOrEmpty(startKey) ? Find(startKey) : null;
            var menusEnd = !string.IsNullOrEmpty(menusEndKey) ? Find(menusEndKey) : null;
            var togglesAfter = !string.IsNullOrEmpty(togglesAfterKey) ? Find(togglesAfterKey) : null;
            var hasTogglesAfterLoc = !string.IsNullOrEmpty(togglesAfterKey) && _locators.ContainsKey(togglesAfterKey);
            var composerToggles = !string.IsNullOrEmpty(togglesInsideKey) && Find(togglesInsideKey) is { } box
                ? Within(box, e => TypeOf(e) == ControlType.CheckBox)
                : [];

            var started = false;
            var menusOver = false;
            var afterPrompt = !hasTogglesAfterLoc;
            AutomationElement? pageArea = null;

            void WalkPages(AutomationElement e, AutomationElement? area, int depth = 0)
            {
                if (depth > 60) return;
                var here = TypeOf(e) == ControlType.Document ? e : area;
                if (!started && (startAt != null ? SameElement(e, startAt) : (RoleMatches(e, "AXHeading") && !string.IsNullOrEmpty(heading) && NameOf(e).StartsWith(heading, StringComparison.Ordinal))))
                {
                    started = true;
                    pageArea = here;
                }
                if (started && SameElement(here, pageArea))
                {
                    if (togglesAfter != null && SameElement(e, togglesAfter)) afterPrompt = true;
                    if (menusEnd != null && SameElement(e, menusEnd)) menusOver = true;
                    var ct = TypeOf(e);
                    if ((ct == ControlType.ComboBox || (ct == ControlType.Button && HasPopup(e))) && Labelled(NameOf(e)) is (var k, var shown))
                    {
                        if (!menusOver && !skip.Contains(k, StringComparer.Ordinal))
                            outList.Add(new PageControl(e, "menu", k, shown, NameOf(e)));
                    }
                    else if (ct == ControlType.CheckBox && afterPrompt && !skipToggles.Any(s => NameOf(e).StartsWith(s, StringComparison.Ordinal)) && !composerToggles.Any(t => SameElement(t, e)))
                    {
                        outList.Add(new PageControl(e, "toggle", NameOf(e), Checked(e) ? "on" : "off", NameOf(e)));
                    }
                }
                foreach (var c in ChildrenOf(e)) WalkPages(c, here, depth + 1);
            }
            WalkPages(_root, null);
            return outList;
        }

        static PageControl? FindPageControl(string label) => PageControls().FirstOrDefault(c => c.Label == label);

        static List<PageChoice> PageChoices(PageControl control)
        {
            var title = control.Title;
            var box = First(e => RoleMatches(e, "AXGroup") && NameOf(e) == title);
            if (box == null) return [];
            var outList = new List<PageChoice>();
            var header = "";

            void Collect(AutomationElement e, string section)
            {
                foreach (var child in ChildrenOf(e))
                {
                    var ct = TypeOf(child);
                    if (ct == ControlType.MenuItem || ct == ControlType.ListItem)
                    {
                        if (!Enabled(child)) continue;
                        var full = NameOf(child);
                        var sep = full.IndexOf(" , ", StringComparison.Ordinal);
                        var shortLabel = (sep >= 0 ? full[..sep] : full).Trim();
                        outList.Add(new PageChoice(child, shortLabel, string.IsNullOrEmpty(section) ? header : section, Checked(child)));
                    }
                    else if (RoleMatches(child, "AXGroup") && !string.IsNullOrEmpty(NameOf(child)) && NameOf(child) != title)
                    {
                        if (Within(child, x => TypeOf(x) == ControlType.MenuItem || TypeOf(x) == ControlType.ListItem).Count > 0) Collect(child, NameOf(child));
                        else header = NameOf(child);
                    }
                    else Collect(child, section);
                }
            }
            Collect(box, "");
            return outList;
        }

        static bool OnClaudeNewPage()
        {
            var heading = ProfileString(_profile, "newPageHeading");
            return string.IsNullOrEmpty(CurrentTitle()) && Find("composer") != null
                && (Find("newPage") != null || (!string.IsNullOrEmpty(heading) && First(e => RoleMatches(e, "AXHeading") && NameOf(e).StartsWith(heading, StringComparison.Ordinal)) != null));
        }

        static Dictionary<string, object?>? OpenClaudeNewPage()
        {
            if (OnClaudeNewPage()) return null;
            var newBtn = Find("newChat");
            if (newBtn == null) return Fail("no_new_page", "Claude 桌面版的侧栏里没有找到新建按钮");
            TryPress(newBtn);
            var trustHeading = ProfileString(_profile, "trustHeading");
            var trust = false;
            var opened = Until(6.0, () =>
            {
                if (!string.IsNullOrEmpty(trustHeading) && First(e => RoleMatches(e, "AXHeading") && NameOf(e).StartsWith(trustHeading, StringComparison.Ordinal)) != null)
                {
                    trust = true;
                    if (Find("cancel") is { } c) TryPress(c, checkSole: false);
                    return true;
                }
                return OnClaudeNewPage();
            });
            if (trust) return Fail("trust", "Claude 桌面版要先确认信任这个文件夹：请在桌面版里用它新建一次会话");
            return opened ? null : Fail("no_new_page", "没能在 Claude 桌面版里打开新建会话页");
        }

        static bool OnCodexNewPage() => string.IsNullOrEmpty(CurrentTitle()) && FindControl("projectMenu", "projectChooser") != null && Find("composer") != null;

        static bool OpenCodexNewPage()
        {
            if (OnCodexNewPage()) return true;
            var btn = Find("newChat");
            if (btn == null || !TryPress(btn)) return false;
            return Until(6.0, OnCodexNewPage);
        }

        static (string Code, string Message)? PickOnNewPage(string label, string option)
        {
            var item = FindPageControl(label);
            if (item == null) return ("no_control", $"{_appName}的新建会话页上现在没有「{label}」这一项");
            if (item.Kind == "toggle")
            {
                if (option is not ("on" or "off")) return ("usage", "开关只能选 on 或 off");
                if (item.Value != option) { TryPress(item.Element, checkSole: false); Until(1.2, () => FindPageControl(label)?.Value == option); }
                return FindPageControl(label)?.Value == option ? null : ("not_set", $"在 {_appName}里按了「{label}」，但它没有变");
            }
            if (item.Value == option) return null;
            if (!OpenMenu(() => FindPageControl(label)?.Element)) return ("no_menu", $"没能打开 {_appName}新建会话页上的「{label}」菜单");
            var choices = FindPageControl(label) is { } pc ? PageChoices(pc) : [];
            var choice = choices.FirstOrDefault(c => c.Label == option || c.Label == Path.GetFileName(option.TrimEnd('\\', '/')));
            if (choice == null) { CloseMenu(() => FindPageControl(label)?.Element); return ("unavailable", $"{_appName}的「{label}」菜单里没有「{option}」"); }
            if (choice.Selected) { CloseMenu(() => FindPageControl(label)?.Element); return null; }
            TryPress(choice.Element, checkSole: false);
            var took = Until(3.2, () => { var now = FindPageControl(label); return now == null || now.Value != item.Value; });
            CloseMenu(() => FindPageControl(label)?.Element);
            return took ? null : ("not_set", $"在 {_appName}里选了「{option}」，但「{label}」没有变");
        }

        static Dictionary<string, object?> RunNewPageCommand(string cmd, List<string> args)
        {
            var cur = CurrentTitle();
            var previous = string.IsNullOrEmpty(cur) ? _cli.ParkedPrevious : cur;
            void GoBack() { if (!_cli.Staying && !string.IsNullOrEmpty(previous)) _ = ShowSession(previous); }

            if (cmd == "new-leave")
            {
                if (IsAppForeground()) return new Dictionary<string, object?> { ["ok"] = true, ["left"] = false, ["front"] = true };
                var onPage = string.IsNullOrEmpty(cur);
                var inUse = onPage && Find("composer") is { } box && HoldsText(box);
                if (onPage && inUse) return new Dictionary<string, object?> { ["ok"] = true, ["left"] = false, ["inUse"] = true };
                if (onPage && !string.IsNullOrEmpty(_cli.ParkedPrevious)) _ = ShowSession(_cli.ParkedPrevious);
                return new Dictionary<string, object?> { ["ok"] = true, ["left"] = onPage };
            }

            var err = OpenClaudeNewPage();
            if (err != null) { if (!string.IsNullOrEmpty(previous)) _ = ShowSession(previous); return err; }

            var controls = PageControls();
            var isCodex = _profile.TryGetProperty("effortNames", out _);
            var shownMenus = ReadShownSettings(isCodex);

            if (cmd == "new-pick")
            {
                var pairs = args.Skip(1).ToList();
                if (pairs.Count < 2 || pairs.Count % 2 != 0) { if (!string.IsNullOrEmpty(previous)) _ = ShowSession(previous); return Fail("usage", "缺少要选的项和选项"); }
                var picked = new List<string>();
                for (var i = 0; i < pairs.Count; i += 2)
                {
                    var pickErr = PickOnNewPage(pairs[i], pairs[i + 1]);
                    if (pickErr != null)
                    {
                        GoBack();
                        return new Dictionary<string, object?>
                        {
                            ["ok"] = false,
                            ["code"] = pickErr.Value.Code,
                            ["error"] = pickErr.Value.Message,
                            ["controls"] = PageControls().Select(c => new Dictionary<string, object?> { ["kind"] = c.Kind, ["label"] = c.Label, ["value"] = c.Value }).ToList(),
                            ["picked"] = picked,
                            ["shown"] = ReadShownSettings(isCodex),
                            ["previous"] = previous,
                            ["stayed"] = _cli.Staying,
                        };
                    }
                    picked.Add(pairs[i]);
                }
                controls = PageControls();
                GoBack();
                return new Dictionary<string, object?>
                {
                    ["ok"] = true,
                    ["controls"] = controls.Select(c => new Dictionary<string, object?> { ["kind"] = c.Kind, ["label"] = c.Label, ["value"] = c.Value }).ToList(),
                    ["picked"] = picked,
                    ["shown"] = ReadShownSettings(isCodex),
                    ["previous"] = previous,
                    ["stayed"] = _cli.Staying,
                };
            }

            var named = args.Skip(1).ToHashSet(StringComparer.Ordinal);
            var outControls = controls.Select(c =>
            {
                var entry = new Dictionary<string, object?> { ["kind"] = c.Kind, ["label"] = c.Label, ["value"] = c.Value };
                if (c.Kind == "menu" && (named.Contains(c.Label) || named.Contains("*")))
                {
                    if (OpenMenu(() => FindPageControl(c.Label)?.Element))
                    {
                        var ch = FindPageControl(c.Label) is { } pc ? PageChoices(pc) : [];
                        entry["options"] = ch.Select(x => new Dictionary<string, object?> { ["label"] = x.Label, ["section"] = x.Section, ["selected"] = x.Selected }).ToList();
                        CloseMenu(() => FindPageControl(c.Label)?.Element);
                    }
                }
                return entry;
            }).ToList();

            GoBack();
            return new Dictionary<string, object?>
            {
                ["ok"] = true,
                ["controls"] = outControls,
                ["shown"] = shownMenus,
                ["previous"] = previous,
                ["stayed"] = _cli.Staying,
            };
        }

        static Dictionary<string, object?> RunNewShown()
        {
            var previous = CurrentTitle();
            if (string.IsNullOrEmpty(previous)) previous = _cli.ParkedPrevious;
            if (!OpenCodexNewPage()) { if (!string.IsNullOrEmpty(previous)) _ = ShowSession(previous); return Fail("no_new_page", "没能在 Codex 桌面版里打开新建聊天页"); }
            Until(2.0, () => Find("modelMenu") != null, 0.2);
            var shown = Find("modelMenu") is { } m ? NameOf(m) : "";
            if (!_cli.Staying || string.IsNullOrEmpty(shown)) { if (!string.IsNullOrEmpty(previous)) _ = ShowSession(previous); }
            if (string.IsNullOrEmpty(shown)) return Fail("no_model_menu", "Codex 桌面版的新建页上没有模型菜单");
            return new Dictionary<string, object?>
            {
                ["ok"] = true,
                ["shown"] = new Dictionary<string, string> { ["model"] = shown },
                ["restored"] = previous,
                ["previous"] = previous,
                ["stayed"] = _cli.Staying,
            };
        }

        static Dictionary<string, object?> RunNew(List<string> args, TextReader stdin)
        {
            var text = stdin.ReadToEnd();
            if (string.IsNullOrEmpty(text)) return Fail("usage", "消息是空的");
            var isCodex = _profile.TryGetProperty("effortNames", out _);
            var previous = CurrentTitle();
            if (string.IsNullOrEmpty(previous)) previous = _cli.ParkedPrevious;
            void GiveUp(string code, string msg) { ClearField("composer"); if (!string.IsNullOrEmpty(previous)) _ = ShowSession(previous); throw new DriverStopException(code, msg); }

            if (isCodex)
            {
                var project = args.Count > 1 ? args[1] : "-";
                if (!OpenCodexNewPage()) { if (!string.IsNullOrEmpty(previous)) _ = ShowSession(previous); return Fail("no_new_page", "没能在 Codex 桌面版里打开新建聊天页"); }
                var changed = new List<string>();
                if (project != "-")
                {
                    if (project == ":none")
                    {
                        if (!(Find("projectMenu") == null && Find("projectChooser") != null))
                        {
                            var noneBtn = Find("noProject");
                            if (noneBtn == null) GiveUp("no_project_menu", "Codex 桌面版的新建页上没有「不在项目里」这一项");
                            TryPress(noneBtn!);
                            if (!Until(2.4, () => Find("projectMenu") == null && Find("projectChooser") != null, 0.2))
                                GiveUp("project_not_set", "在 Codex 桌面版里选了不在项目里，但项目没有切换过去");
                        }
                    }
                    else
                    {
                        var prefix = ProfileString(_profile, "projectPrefix");
                        var curProj = Find("projectMenu") is { } pm ? NameOf(pm) : "";
                        var shownProj = !string.IsNullOrEmpty(prefix) && curProj.StartsWith(prefix, StringComparison.Ordinal) ? curProj[prefix.Length..] : (Labelled(curProj)?.Value ?? "");
                        if (shownProj != project)
                        {
                            if (!OpenMenu(() => FindControl("projectMenu", "projectChooser"), () => Find("projectList") != null))
                                GiveUp("no_project_menu", "没能打开 Codex 桌面版的项目菜单");
                            var plist = Find("projectList");
                            var rows = plist != null ? ChildrenOf(plist) : [];
                            var row = rows.FirstOrDefault(r => NameOf(r) == project || Within(r, x => TypeOf(x) == ControlType.Text && NameOf(x) == project).Count > 0);
                            if (row == null) { CloseMenu(() => FindControl("projectMenu", "projectChooser")); GiveUp("project_unavailable", $"Codex 桌面版的项目菜单里没有「{project}」"); }
                            TryPress(row!, checkSole: false);
                            Until(2.4, () => Find("projectMenu") is { } p2 && (Labelled(NameOf(p2))?.Value == project || NameOf(p2).EndsWith(project, StringComparison.Ordinal)), 0.2);
                        }
                    }
                    changed.Add("project");
                }

                var settings = ApplySettings();
                changed.AddRange(settings.Changed);
                var tookFocus = false;
                if (!FillField("composer", text, "send", ref tookFocus) || !OnCodexNewPage())
                    GiveUp("fill_failed", "没能把消息填进 Codex 桌面版的输入框");
                var send = SendButton("send");
                if (send == null) GiveUp("no_send", "Codex 桌面版没有出现发送按钮");
                TryPress(send!);
                if (HeldBack()) GiveUp("no_send", "Codex 桌面版没有出现发送按钮");
                var started = Until(4.0, () => !OnCodexNewPage() || !string.IsNullOrEmpty(CurrentTitle()));
                var newTitle = CurrentTitle();
                if (!string.IsNullOrEmpty(previous)) _ = ShowSession(previous);
                return new Dictionary<string, object?> { ["ok"] = true, ["started"] = started, ["title"] = newTitle, ["restored"] = previous, ["changed"] = changed, ["tookFocus"] = tookFocus };
            }
            else
            {
                var err = OpenClaudeNewPage();
                if (err != null) { if (!string.IsNullOrEmpty(previous)) _ = ShowSession(previous); return err; }
                var folder = args.Count > 1 && args[1] != "-" ? args[1] : "";
                if (!string.IsNullOrEmpty(folder) && FindPageControl("Folder") != null)
                {
                    var pe = PickOnNewPage("Folder", folder);
                    if (pe != null) GiveUp(pe.Value.Code, pe.Value.Message);
                }
                var expected = args.Skip(2).ToList();
                for (var i = 0; i + 1 < expected.Count; i += 2)
                {
                    var pe = PickOnNewPage(expected[i], expected[i + 1]);
                    if (pe != null) GiveUp(pe.Value.Code, pe.Value.Message);
                }
                var settings = ApplySettings();
                var tookFocus = false;
                if (!FillField("composer", text, "send", ref tookFocus) || !OnClaudeNewPage())
                    GiveUp("fill_failed", "没能把消息填进 Claude 桌面版的输入框");
                var send = SendButton("send");
                if (send == null) GiveUp("no_send", "Claude 桌面版没有出现发送按钮");
                TryPress(send!);
                if (HeldBack()) GiveUp("no_send", "Claude 桌面版没有出现发送按钮");
                var started = Until(10.0, () => !string.IsNullOrEmpty(CurrentTitle()) || Find("stop") != null);
                if (!string.IsNullOrEmpty(previous)) _ = ShowSession(previous);
                return new Dictionary<string, object?> { ["ok"] = true, ["started"] = started, ["restored"] = previous, ["changed"] = settings.Changed, ["notes"] = settings.Notes, ["tookFocus"] = tookFocus };
            }
        }

        // ---- question cards & wrap-up cards ----

        static List<AutomationElement> QuestionCards()
        {
            var submit = ProfileString(_profile, "questionSubmit");
            var groups = Every(e => RoleMatches(e, "AXGroup") && Within(e, b => TypeOf(b) == ControlType.Button && NameOf(b) == submit).Count > 0);
            return groups.Where(g => !groups.Any(o => !SameElement(o, g) && Within(g, x => SameElement(x, o)).Count > 0)).ToList();
        }

        static Dictionary<string, object?> RunAnswer(List<string> args)
        {
            if (args.Count < 4) return Fail("usage", "缺少要回答的问题");
            var title = args[1];
            var localId = args[2] == "-" ? "" : args[2];
            var question = args[3];
            var option = args.Count > 4 ? args[4] : null;
            var previous = CurrentTitle();
            if (!ShowSession(title, string.IsNullOrEmpty(localId) ? null : new Dictionary<string, string> { ["localId"] = localId }))
                return Fail("not_found", $"没能在{_appName}里打开这个会话");

            var cards = QuestionCards();
            if (cards.Count == 0) Until(3.2, () => { cards = QuestionCards(); return cards.Count > 0; });
            var card = cards.FirstOrDefault(c => NameOf(c) == question) ?? (cards.Count == 1 ? cards[0] : null);
            if (card == null) { if (!string.IsNullOrEmpty(previous) && previous != title) _ = ShowSession(previous); return Fail("no_question", $"{_appName}里没有在等回答的这个问题"); }

            if (option != null)
            {
                AutomationElement? Choice() => Within(card, e => (TypeOf(e) == ControlType.CheckBox || TypeOf(e) == ControlType.RadioButton) && Named(e, option)).FirstOrDefault();
                var wanted = Choice();
                if (wanted == null) { if (!string.IsNullOrEmpty(previous) && previous != title) _ = ShowSession(previous); return Fail("no_option", $"{_appName}的这个问题里没有「{option}」这个选项"); }
                if (!Checked(wanted)) { TryPress(wanted, checkSole: false); Thread.Sleep(250); Stale(); }
                if (Choice() is not { } now || !Checked(now)) { if (!string.IsNullOrEmpty(previous) && previous != title) _ = ShowSession(previous); return Fail("not_picked", $"没能在{_appName}的问题卡片上选中「{option}」，没有提交"); }
            }

            var btnName = ProfileString(_profile, option == null ? "questionSkip" : "questionSubmit");
            var done = Within(card, e => TypeOf(e) == ControlType.Button && NameOf(e) == btnName).FirstOrDefault();
            if (done == null) { if (!string.IsNullOrEmpty(previous) && previous != title) _ = ShowSession(previous); return Fail("no_submit", $"{_appName}的问题卡片上没有找到提交按钮"); }
            TryPress(done, checkSole: false);
            var ok = Until(1.6, () => QuestionCards().Count < cards.Count);
            if (!string.IsNullOrEmpty(previous) && previous != title) _ = ShowSession(previous);
            return ok ? Ok() : Fail("not_taken", $"{_appName}没有收下这个回答");
        }

        static Dictionary<string, object?> RunCardAction(string cmd, List<string> args)
        {
            var reading = cmd == "card";
            var at = reading ? 3 : 4;
            if (args.Count <= at + 2 || (!reading && !int.TryParse(args[3], out _))) return Fail("usage", "缺少卡片的内容");
            var title = args[1];
            var localId = args[2] == "-" ? "" : args[2];
            var index = reading ? 0 : int.Parse(args[3]);
            var ask = args[at];
            var recap = args[at + 1];
            var replies = new HashSet<string>(StringComparer.Ordinal);
            try
            {
                using var doc = JsonDocument.Parse(args[at + 2]);
                if (doc.RootElement.ValueKind == JsonValueKind.Array)
                    foreach (var el in doc.RootElement.EnumerateArray()) if (el.ValueKind == JsonValueKind.String) replies.Add(el.GetString() ?? "");
            }
            catch { }
            var skip = ProfileStrings(_profile, "cardSkip").ToHashSet(StringComparer.Ordinal);

            var previous = CurrentTitle();
            if (!ShowSession(title, string.IsNullOrEmpty(localId) ? null : new Dictionary<string, string> { ["localId"] = localId }))
                return Fail("not_found", $"没能在{_appName}里打开这个会话");

            var walker = TreeWalker.RawViewWalker;
            AutomationElement? FindCard()
            {
                var texts = FindAll("transcript").SelectMany(t => Within(t, e => TypeOf(e) == ControlType.Text && ValueOf(e).Trim() is var s && !string.IsNullOrEmpty(s) && (s == ask || (string.IsNullOrEmpty(ask) && s == recap)))).ToList();
                for (var i = texts.Count - 1; i >= 0; i--)
                {
                    var box = texts[i];
                    for (var up = 0; up < 4; up++)
                    {
                        AutomationElement? parent = null;
                        try { parent = walker.GetParent(box); } catch { }
                        if (parent == null) break;
                        box = parent;
                        if (Within(box, e => TypeOf(e) == ControlType.Button).Count > 0) return box;
                    }
                }
                return null;
            }

            List<AutomationElement> CardActions(AutomationElement box)
                => Within(box, e => TypeOf(e) == ControlType.Button && NameOf(e) is var n && !string.IsNullOrEmpty(n) && !skip.Contains(n) && !replies.Contains(n));

            AutomationElement? found = null;
            Until(3.0, () => { found = FindCard(); return found != null && CardActions(found).Count > 0; });
            if (found == null) { if (!string.IsNullOrEmpty(previous) && previous != title) _ = ShowSession(previous); return Fail("no_card", "Claude 桌面版里没有找到这一轮的卡片"); }

            var drawn = CardActions(found);
            var names = drawn.Select(NameOf).ToList();
            if (reading) { if (!string.IsNullOrEmpty(previous) && previous != title) _ = ShowSession(previous); return new Dictionary<string, object?> { ["ok"] = true, ["actions"] = names }; }
            if (index < 0 || index >= drawn.Count)
            {
                if (!string.IsNullOrEmpty(previous) && previous != title) _ = ShowSession(previous);
                return new Dictionary<string, object?> { ["ok"] = false, ["code"] = "no_action", ["error"] = "Claude 桌面版的这张卡片上已经没有这个按钮了", ["actions"] = names };
            }
            var pressedName = names[index];
            TryPress(drawn[index], checkSole: false);
            Thread.Sleep(500);
            if (!string.IsNullOrEmpty(previous) && previous != title) _ = ShowSession(previous);
            return new Dictionary<string, object?> { ["ok"] = true, ["pressed"] = pressedName };
        }

        // ---- cloud chat modes (read-chat, chat-status, chat-new, chat-send, chat-stop) ----

        static string PageUrl()
        {
            foreach (var doc in Every(e => TypeOf(e) == ControlType.Document))
            {
                var u = UrlOf(doc);
                if (u.StartsWith("http", StringComparison.OrdinalIgnoreCase)) return u;
            }
            return "";
        }

        static Guid? ChatUuid()
        {
            if (!Uri.TryCreate(PageUrl(), UriKind.Absolute, out var uri)) return null;
            var parts = uri.AbsolutePath.Split('/', StringSplitOptions.RemoveEmptyEntries);
            if (parts.Length >= 2 && parts[^2] == "chat" && Guid.TryParse(parts[^1], out var id)) return id;
            return null;
        }

        static AutomationElement? ChatRegion()
        {
            var container = ProfileElement(_profile, "chatRead", "container");
            if (container == null) return null;
            if (container.Value.ValueKind == JsonValueKind.String)
                return Find(container.Value.GetString() ?? "");
            foreach (var way in ParseLocatorList("chatRead", container.Value))
            {
                var hit = Matches(way).FirstOrDefault();
                if (hit != null) return hit;
            }
            return null;
        }

        static bool ChatAnswering()
        {
            var stopKey = ProfileString(_profile, "chatSend", "stop");
            return !string.IsNullOrEmpty(stopKey) && FindAll(stopKey).Count > 0;
        }

        static List<Dictionary<string, string>> ExtractChatMessages()
        {
            var area = ChatRegion();
            if (area == null) return [];
            var speakers = ProfileMap(_profile, "chatRead", "speakers");
            var ignore = ProfileStrings(_profile, "chatRead", "ignore");
            var skipWays = ProfileElement(_profile, "chatRead", "skip") is { } se ? ParseLocatorList("skip", se) : [];
            var headingWays = ProfileElement(_profile, "chatRead", "speakerHeading") is { } he ? ParseLocatorList("speakerHeading", he) : [];
            var userMsgWays = ProfileElement(_profile, "chatRead", "userMessage") is { } ue ? ParseLocatorList("userMessage", ue) : [];

            var messages = new List<Dictionary<string, string>>();
            var text = new StringBuilder();
            var speaker = "";
            void Flush()
            {
                var body = text.ToString().Trim();
                if (!string.IsNullOrEmpty(speaker) && !string.IsNullOrEmpty(body))
                    messages.Add(new Dictionary<string, string> { ["role"] = speaker, ["text"] = body });
                text.Clear();
            }

            void Visit(AutomationElement e)
            {
                var ct = TypeOf(e);
                var n = NameOf(e);
                if (ct == ControlType.Button || ct == ControlType.ToolBar || ct == ControlType.CheckBox || ct == ControlType.ComboBox || ct == ControlType.Edit) return;
                if (ignore.Any(p => !string.IsNullOrEmpty(p) && (n.StartsWith(p, StringComparison.Ordinal) || ValueOf(e).StartsWith(p, StringComparison.Ordinal)))) return;
                if (skipWays.Any(w => Fits(e, w))) return;

                if (RoleMatches(e, "AXHeading"))
                {
                    var matchSpeaker = speakers.FirstOrDefault(kv => n.StartsWith(kv.Key, StringComparison.Ordinal));
                    if (!string.IsNullOrEmpty(matchSpeaker.Key))
                    {
                        Flush();
                        speaker = matchSpeaker.Value;
                        foreach (var c in ChildrenOf(e)) Visit(c);
                        return;
                    }
                    if (headingWays.Any(w => Fits(e, w)))
                    {
                        Flush();
                        var walker = TreeWalker.RawViewWalker;
                        AutomationElement? next = null;
                        try { next = walker.GetNextSibling(e); } catch { }
                        speaker = (next != null && userMsgWays.Any(w => Fits(next, w))) ? "user" : "assistant";
                        return;
                    }
                }

                if (ct == ControlType.Text && !string.IsNullOrEmpty(speaker))
                {
                    var v = ValueOf(e);
                    if (!string.IsNullOrEmpty(v) && !speakers.Keys.Any(k => v.StartsWith(k, StringComparison.Ordinal)))
                    {
                        if (text.Length > 0 && !text.ToString().EndsWith('\n')) text.AppendLine();
                        text.AppendLine(v);
                    }
                    return;
                }
                foreach (var c in ChildrenOf(e)) Visit(c);
            }
            Visit(area);
            Flush();
            return messages;
        }

        static Dictionary<string, object?> ChatAnswer(Dictionary<string, object?>? extra = null)
        {
            var ans = new Dictionary<string, object?>
            {
                ["ok"] = true,
                ["messages"] = ExtractChatMessages(),
                ["running"] = ChatAnswering(),
                ["title"] = CurrentTitle(),
                ["url"] = PageUrl(),
            };
            if (extra != null) foreach (var (k, v) in extra) ans[k] = v;
            return ans;
        }

        static Dictionary<string, object?> RunChatCommand(string cmd, List<string> args, TextReader stdin)
        {
            if (cmd == "chat-status")
            {
                if (args.Count < 2 || string.IsNullOrEmpty(args[1])) return Fail("usage", "缺少有效的会话 ID");
                var shown = Guid.TryParse(args[1], out var gid) && ChatUuid() == gid && ChatRegion() != null;
                return new Dictionary<string, object?> { ["ok"] = true, ["shown"] = shown, ["running"] = shown && ChatAnswering(), ["front"] = IsAppForeground() };
            }

            if (ProfileElement(_profile, "chatRead") == null) return Fail("usage", $"{_appName}的配置里没有 chatRead");
            var previous = CurrentTitle();
            var target = args.Count > 1 ? args[1] : "";
            var seconds = args.Count > 2 && double.TryParse(args[2], out var s) ? s : 60.0;
            void Back() { if (!string.IsNullOrEmpty(previous) && previous != target) _ = ShowSession(previous); }

            if (cmd == "chat-stop")
            {
                if (args.Count < 3 || string.IsNullOrEmpty(target) || !Guid.TryParse(args[2], out var sid)) return Fail("usage", "缺少有效的会话 ID 或标题");
                bool OnTarget() => ChatUuid() == sid;
                if (!OnTarget() && !ShowSession(target)) { Back(); return Fail("not_found", $"没能在{_appName}的侧栏里找到这个聊天"); }
                Until(3.2, () => OnTarget() && ChatRegion() != null, 0.2);
                if (!OnTarget() || ChatRegion() == null) { Back(); return Fail("wrong_chat", $"没能在{_appName}里确认打开的是要停止的聊天"); }
                var stopKey = ProfileString(_profile, "chatSend", "stop");
                var stops = string.IsNullOrEmpty(stopKey) ? [] : FindAll(stopKey);
                if (stops.Count == 0) { Back(); return Fail("not_running", $"这个会话在{_appName}里已经没有在回复"); }
                if (stops.Count > 1) { Back(); return Fail("ambiguous_stop", $"没能在{_appName}里确认哪个按钮会停止这条回复"); }
                if (!TryPress(stops[0], checkSole: false)) { Back(); return Fail("not_stopped", $"没能按下{_appName}的停止按钮"); }
                if (!Until(2.5, () => !ChatAnswering(), 0.2)) { Back(); return Fail("not_stopped", $"按了停止，但{_appName}还在回复"); }
                var ans = ChatAnswer(new Dictionary<string, object?> { ["interrupted"] = true });
                Back();
                return ans;
            }

            string? SendChatText(string text)
            {
                var cKey = ProfileString(_profile, "chatSend", "composer");
                var sKey = ProfileString(_profile, "chatSend", "send");
                if (string.IsNullOrEmpty(cKey) || string.IsNullOrEmpty(sKey)) return $"{_appName}的配置里没有 chatSend";
                var tf = false;
                if (!FillField(cKey, text, sKey, ref tf)) { ClearField(cKey); return $"没能把消息填进{_appName}的输入框"; }
                var sendBtn = SendButton(sKey);
                if (sendBtn == null || !TryPress(sendBtn) || HeldBack()) { ClearField(cKey); return $"{_appName}没有出现发送按钮"; }
                if (!Until(4.0, () => (Find(cKey) is { } bx && !HoldsText(bx)) || ChatAnswering())) return $"按了{_appName}的发送，但消息还留在输入框里";
                return null;
            }

            void AwaitReply()
            {
                if (seconds <= 0) return;
                Thread.Sleep(1500); Stale();
                Until(seconds, () => !ChatAnswering() && ChatRegion() != null && ExtractChatMessages().LastOrDefault()?["role"] == "assistant", 1.0);
            }

            if (cmd == "chat-new")
            {
                var text = stdin.ReadToEnd();
                if (string.IsNullOrEmpty(text)) return Fail("usage", "消息是空的");
                target = "";
                var project = args.Count > 1 && args[1] != "-" ? args[1] : "";
                var cKey = ProfileString(_profile, "chatSend", "composer");
                if (string.IsNullOrEmpty(project))
                {
                    var newBtn = Find(ProfileString(_profile, "chatSend", "newChat"));
                    if (newBtn == null) { Back(); return Fail("no_new_page", $"{_appName}的侧栏里没有找到新建聊天的按钮"); }
                    TryPress(newBtn);
                    if (!Until(5.0, () => Find(cKey) != null && ChatRegion() == null, 0.2)) { Back(); return Fail("no_new_page", $"没能在{_appName}里打开新聊天的页面"); }
                }
                else
                {
                    var names = ProfileStrings(_profile, "chatSend", "project").Select(p => p.Replace("{project}", project)).ToList();
                    var pBtn = names.SelectMany(w => Every(e => TypeOf(e) == ControlType.Button && NameOf(e) == w)).FirstOrDefault();
                    if (pBtn == null) { Back(); return Fail("no_project", $"{_appName}的侧栏里没有「{project}」这个项目，没能在里面新建聊天"); }
                    TryPress(pBtn, checkSole: false);
                    if (!Until(5.0, () => Find(cKey) != null && ChatRegion() == null, 0.2)) { Back(); return Fail("no_new_page", $"没能在{_appName}里打开「{project}」的新聊天页面"); }
                }
                var errMsg = SendChatText(text);
                if (errMsg != null) { Back(); return Fail("send_failed", errMsg); }
                Until(4.0, () => ChatRegion() != null);
                AwaitReply();
                target = CurrentTitle();
                var res = seconds > 0 ? ChatAnswer(new Dictionary<string, object?> { ["sent"] = true }) : new Dictionary<string, object?> { ["ok"] = true, ["sent"] = true, ["running"] = ChatAnswering(), ["title"] = target, ["url"] = PageUrl() };
                Back();
                return res;
            }

            if (cmd == "chat-send")
            {
                var text = stdin.ReadToEnd();
                if (string.IsNullOrEmpty(target) || string.IsNullOrEmpty(text)) return Fail("usage", "缺少会话标题或消息");
                if (!ShowSession(target)) { Back(); return Fail("not_found", $"没能在{_appName}的侧栏里找到这个聊天"); }
                Until(3.2, () => ChatRegion() != null, 0.2);
                if (ChatAnswering()) { Back(); return Fail("busy", $"这个聊天正在{_appName}里回复，等它回复完再发"); }
                var errMsg = SendChatText(text);
                if (errMsg != null) { Back(); return Fail("send_failed", errMsg); }
                AwaitReply();
                var res = seconds > 0 ? ChatAnswer(new Dictionary<string, object?> { ["sent"] = true }) : new Dictionary<string, object?> { ["ok"] = true, ["sent"] = true, ["running"] = ChatAnswering(), ["title"] = CurrentTitle(), ["url"] = PageUrl() };
                Back();
                return res;
            }

            // read-chat
            if (string.IsNullOrEmpty(target)) return Fail("usage", "缺少会话标题");
            var already = args.Count > 2 && Guid.TryParse(args[2], out var id2) && ChatUuid() == id2;
            if (!already && !ShowSession(target)) { Back(); return Fail("not_found", $"没能在{_appName}的侧栏里找到这个聊天"); }
            Until(3.2, () => ChatRegion() != null, 0.2);
            if (ChatRegion() == null) { Back(); return Fail("no_messages", $"{_appName}里这个聊天没有显示出消息"); }
            Thread.Sleep(600); Stale();
            var chatRes = ChatAnswer();
            Back();
            return chatRes;
        }

        // ---- shared helpers ----

        static AutomationElement? FindControl(params string[] keys)
        {
            foreach (var key in keys)
            {
                var hit = Find(key);
                if (hit != null) return hit;
            }
            return null;
        }

        static bool PressSend(AutomationElement composer, ref bool tookFocus)
        {
            foreach (var key in new[] { "send", "chatSendButton" })
            {
                var hit = Find(key);
                if (hit != null && TryPress(hit)) return true;
            }
            tookFocus = true;
            return BorrowFocusAndKey(composer, "{ENTER}");
        }

        static object Describe(AutomationElement element, int depth, int at = 0)
        {
            var info = Info(element);
            var said = new Dictionary<string, object>
            {
                ["type"] = info?.ControlType?.ProgrammaticName.Replace("ControlType.", "") ?? "",
                ["class"] = info?.ClassName ?? "",
                ["id"] = info?.AutomationId ?? "",
                ["name"] = info?.Name ?? "",
            };
            if (at < depth)
                said["children"] = ChildrenOf(element).Select(c => Describe(c, depth, at + 1)).ToList();
            return said;
        }

        static object Brief(AutomationElement element)
        {
            var info = Info(element);
            return new Dictionary<string, object>
            {
                ["type"] = info?.ControlType?.ProgrammaticName.Replace("ControlType.", "") ?? "",
                ["class"] = info?.ClassName ?? "",
                ["id"] = info?.AutomationId ?? "",
                ["name"] = info?.Name ?? "",
            };
        }

        static Dictionary<string, object?> Ok() => new() { ["ok"] = true };
        static Dictionary<string, object?> Fail(string code, string error) => new() { ["ok"] = false, ["code"] = code, ["error"] = error };
    }
}
