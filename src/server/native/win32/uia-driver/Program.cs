// The Windows twin of ax-driver.swift, speaking the same one-line-JSON protocol the server's
// core/desktop-automation.ts already reads: one command per process, arguments on the command
// line, the message text on stdin, and exactly one JSON object as the last line of stdout.
//
// What each piece answers to:
//   profiles/<engine>.json  locators (data): how a control is found — by its type, its class or
//                           automation id, its name, or its place — never by a translated label
//                           alone; the `win32` section names the app's process
//   this driver             finding by those marks, filling and pressing without bringing the
//                           app to the front (UIA patterns work on background windows)
//
// Commands (the ones the flows use first; anything else answers `unsupported` rather than guess):
//   check                       { ok, trusted, running } — trusted is always true on Windows
//   warm                        reads the page once, keeping the app's UIA tree built
//   send <title> <localId>…     fills the composer and presses Send (stdin: the text)
//   stop <title> <localId>      presses the profile's Stop control, or Escape into the composer
//   inspect [maxDepth]          dumps the control tree (type/class/id/name), for writing profiles
//   probe <locatorKey>          reports what a profile locator finds, without touching anything
//
// Filling prefers ValuePattern (no focus, no window brought forward). A contenteditable
// composer that offers no ValuePattern is filled through the clipboard with the focus borrowed
// for a moment and handed back; the answer says so with `tookFocus`.
// A way that does not narrow anything (or narrows by what only macOS reads: url, subrole,
// popup) finds nothing here — better nothing than the wrong control.

using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Windows.Automation;
using AgentFrontdesk.UiaDriver;

var profile = Driver.LoadProfile(Environment.GetEnvironmentVariable("AX_PROFILE"));
var command = args.Length > 0 ? args[0] : "";

try
{
    var answer = Driver.Run(command, args, profile, Console.In);
    Console.WriteLine(JsonSerializer.Serialize(answer, Driver.JsonOpts));
    return 0;
}
catch (Exception err)
{
    Console.WriteLine(JsonSerializer.Serialize(new Dictionary<string, object>
    {
        ["ok"] = false,
        ["code"] = "crashed",
        ["error"] = err.Message.Split('\n')[0],
    }, Driver.JsonOpts));
    return 1;
}

namespace AgentFrontdesk.UiaDriver
{
    internal static class NativeMethods
    {
        [DllImport("user32.dll")] internal static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
        [DllImport("user32.dll")] internal static extern bool IsIconic(IntPtr hWnd);
        [DllImport("user32.dll")] internal static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] internal static extern bool SetForegroundWindow(IntPtr hWnd);
    }

    internal static class Driver
    {
        internal static readonly JsonSerializerOptions JsonOpts = new() { Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping };

        internal static Dictionary<string, object> Run(string command, string[] args, JsonElement profile, TextReader stdin)
        {
            switch (command)
            {
                case "check":
                {
                    var root = FindAppRoot(profile);
                    return new Dictionary<string, object> { ["ok"] = true, ["trusted"] = true, ["running"] = root != null };
                }
                case "warm":
                {
                    var root = FindAppRoot(profile);
                    if (root == null) return Fail("not_running", "应用没有在运行");
                    _ = Read(root); // one pass keeps the tree built, as keepWarm asks
                    return Ok();
                }
                case "inspect":
                {
                    var root = FindAppRoot(profile);
                    if (root == null) return Fail("not_running", "应用没有在运行");
                    var depth = args.Length > 1 && int.TryParse(args[1], out var d) ? d : 12;
                    return new Dictionary<string, object> { ["ok"] = true, ["tree"] = Describe(root, depth) };
                }
                case "probe":
                {
                    var root = FindAppRoot(profile);
                    if (root == null) return Fail("not_running", "应用没有在运行");
                    var key = args.Length > 1 ? args[1] : "";
                    var ways = LocatorWays(profile, key);
                    if (ways.Count == 0) return Fail("no_locator", $"profile 里没有 {key} 的认法");
                    var report = new List<object>();
                    foreach (var way in ways) report.Add(new Dictionary<string, object>
                    {
                        ["way"] = way.ToString(),
                        ["hits"] = FindByWay(root, profile, way).Select(Brief).ToList(),
                    });
                    return new Dictionary<string, object> { ["ok"] = true, ["key"] = key, ["ways"] = report };
                }
                case "send":
                {
                    var root = FindAppRoot(profile);
                    if (root == null) return Fail("not_running", "应用没有在运行");
                    var text = stdin.ReadToEnd();
                    var composer = FindControl(root, profile, "composer", "chatComposer")
                        ?? FindControl(root, profile, "chatComposer", "composer");
                    if (composer == null) return Fail("no_composer", "没有找到输入框（profile 的 composer）");
                    var tookFocus = false;
                    if (!Fill(composer, text))
                    {
                        tookFocus = true;
                        if (!BorrowFocusAndPaste(composer, text)) return Fail("no_fill", "输入框填不进文字");
                    }
                    var pressed = PressSend(root, profile, composer);
                    return new Dictionary<string, object> { ["ok"] = pressed, ["pressed"] = pressed, ["tookFocus"] = tookFocus };
                }
                case "stop":
                {
                    var root = FindAppRoot(profile);
                    if (root == null) return Fail("not_running", "应用没有在运行");
                    var stop = FindControl(root, profile, "stop", "chatStop") ?? FindControl(root, profile, "chatStop", "stop");
                    if (stop != null && TryInvoke(stop)) return new Dictionary<string, object> { ["ok"] = true, ["pressed"] = true };
                    var composer = FindControl(root, profile, "composer", "chatComposer");
                    if (composer != null && BorrowFocusAndKey(composer, "{ESC}")) return new Dictionary<string, object> { ["ok"] = true, ["pressed"] = true, ["tookFocus"] = true };
                    return Fail("no_stop", "没有找到停止控件，也按不到 Esc");
                }
                default:
                    return Fail("unsupported", $"这个动作（{command}）的 Windows 支持还没写好");
            }
        }

        // ---- the profile ----

        internal static JsonElement LoadProfile(string? path)
        {
            if (path != null && File.Exists(path))
                return JsonDocument.Parse(File.ReadAllText(path)).RootElement.Clone();
            return JsonDocument.Parse("{}").RootElement.Clone();
        }

        static string ProfileString(JsonElement profile, params string[] path)
        {
            var at = profile;
            foreach (var step in path)
            {
                if (at.ValueKind != JsonValueKind.Object || !at.TryGetProperty(step, out at)) return "";
            }
            return at.ValueKind == JsonValueKind.String ? at.GetString() ?? "" : "";
        }

        // ---- finding the app ----

        static AutomationElement? FindAppRoot(JsonElement profile)
        {
            var process = ProfileString(profile, "win32", "process");
            if (process.Length == 0) return null;
            foreach (var p in Process.GetProcessesByName(process))
            {
                try
                {
                    if (p.MainWindowHandle != IntPtr.Zero)
                    {
                        var element = AutomationElement.FromHandle(p.MainWindowHandle);
                        WakeIfMinimized(p.MainWindowHandle);
                        return element;
                    }
                }
                catch { /* a process that left between listing and reading */ }
                finally { p.Dispose(); }
            }
            return null;
        }

        // A window minimized to the taskbar (or the tray) answers UIA with a half-built tree;
        // restoring it without activation — SW_SHOWNOACTIVATE — rebuilds the tree without
        // stealing the foreground.
        static void WakeIfMinimized(IntPtr hwnd)
        {
            if (NativeMethods.IsIconic(hwnd)) NativeMethods.ShowWindow(hwnd, 4 /* SW_SHOWNOACTIVATE */);
        }

        // ---- locators ----

        // What a profile way (a locator's object) may narrow by, mapped onto UIA. The macOS role
        // names are kept so one profile serves both platforms.
        static readonly Dictionary<string, ControlType> Roles = new()
        {
            ["AXTextArea"] = ControlType.Edit,
            ["AXTextField"] = ControlType.Edit,
            ["AXButton"] = ControlType.Button,
            ["AXGroup"] = ControlType.Group,
            ["AXWebArea"] = ControlType.Document,
            ["AXPopUpButton"] = ControlType.ComboBox,
            ["AXRadioButton"] = ControlType.RadioButton,
            ["AXRadioGroup"] = ControlType.Group,
            ["AXMenuItem"] = ControlType.MenuItem,
            ["AXMenu"] = ControlType.Menu,
            ["AXHeading"] = ControlType.Header,
            ["AXStaticText"] = ControlType.Text,
            ["AXLink"] = ControlType.Hyperlink,
            ["AXCheckBox"] = ControlType.CheckBox,
        };

        static List<JsonElement> LocatorWays(JsonElement profile, string key)
        {
            var ways = new List<JsonElement>();
            if (profile.ValueKind == JsonValueKind.Object && profile.TryGetProperty("locators", out var locators)
                && locators.ValueKind == JsonValueKind.Object && locators.TryGetProperty(key, out var list))
            {
                if (list.ValueKind == JsonValueKind.Array) ways.AddRange(list.EnumerateArray());
                else ways.Add(list);
            }
            return ways;
        }

        static bool WayString(JsonElement way, string field, out string value)
        {
            value = "";
            return way.ValueKind == JsonValueKind.Object && way.TryGetProperty(field, out var v) && v.ValueKind == JsonValueKind.String && (value = v.GetString() ?? "").Length > 0;
        }

        // A way is applied inside its `inside` container when `viaInside` is false; the second
        // pass over the container ignores `inside` (already resolved) so the walk cannot loop.
        static List<AutomationElement> FindByWay(AutomationElement scope, JsonElement profile, JsonElement way, bool viaInside = false)
        {
            var results = new List<AutomationElement>();
            if (way.ValueKind != JsonValueKind.Object) return results;

            if (!viaInside && WayString(way, "inside", out var inside))
            {
                foreach (var container in LocatorWays(profile, inside).SelectMany(w => FindByWay(scope, profile, w)))
                    results.AddRange(FindByWay(container, profile, way, viaInside: true));
                if (results.Count > 0) return Place(results, way);
            }

            var conditions = new List<Condition>();
            if (WayString(way, "role", out var role) && Roles.TryGetValue(role, out var type))
                conditions.Add(new PropertyCondition(AutomationElement.ControlTypeProperty, type));
            if (WayString(way, "id", out var id))
                conditions.Add(new PropertyCondition(AutomationElement.AutomationIdProperty, id));
            if (WayString(way, "name", out var name))
                conditions.Add(new PropertyCondition(AutomationElement.NameProperty, name));

            IEnumerable<AutomationElement> found;
            if (conditions.Count > 0)
            {
                found = scope.FindAll(TreeScope.Descendants, conditions.Count == 1 ? conditions[0] : new AndCondition(conditions.ToArray()))
                    .Cast<AutomationElement>();
            }
            else if (WayString(way, "class", out var classOnly))
            {
                // A class is tried against both places Chromium may expose it.
                found = scope.FindAll(TreeScope.Descendants, Condition.TrueCondition).Cast<AutomationElement>()
                    .Where(e => e.Current.ClassName == classOnly || e.Current.AutomationId == classOnly);
            }
            else
            {
                return []; // narrows by nothing this driver reads: rather nothing than the wrong control
            }

            if (WayString(way, "prefix", out var prefix))
                found = found.Where(e => e.Current.Name.StartsWith(prefix, StringComparison.Ordinal));
            if (WayString(way, "contains", out var contains))
                found = found.Where(e => e.Current.Name.Contains(contains, StringComparison.Ordinal));
            if (WayString(way, "class", out var cls) && conditions.Count > 0)
                found = found.Where(e => e.Current.ClassName == cls || e.Current.AutomationId == cls);

            results.AddRange(found);
            return Place(results, way);
        }

        // `index` counts from the end when negative (macOS habit: -1 is the last of the page).
        // `after` (a place relative to another locator's hit) is not resolved yet: a way that asks
        // for it finds nothing rather than something next to the wrong control.
        static List<AutomationElement> Place(List<AutomationElement> hits, JsonElement way)
        {
            if (way.ValueKind != JsonValueKind.Object || !way.TryGetProperty("index", out var rawIndex) || rawIndex.ValueKind != JsonValueKind.Number)
                return WayString(way, "after", out _) ? [] : hits;
            var index = rawIndex.GetInt32();
            if (hits.Count == 0) return hits;
            if (index < 0) index += hits.Count;
            return index >= 0 && index < hits.Count ? [hits[index]] : [];
        }

        static AutomationElement? FindControl(AutomationElement root, JsonElement profile, params string[] keys)
        {
            foreach (var key in keys)
                foreach (var way in LocatorWays(profile, key))
                {
                    var hits = FindByWay(root, profile, way);
                    // The same rule as macOS: only the one a way singles out is touched.
                    if (hits.Count == 1) return hits[0];
                }
            return null;
        }

        // ---- acting ----

        static bool Read(AutomationElement element)
        {
            _ = element.FindAll(TreeScope.Children, Condition.TrueCondition);
            return true;
        }

        static bool Fill(AutomationElement composer, string text)
        {
            try
            {
                var value = composer.GetCurrentPattern(ValuePattern.Pattern) as ValuePattern;
                if (value == null || value.Current.IsReadOnly) return false;
                value.SetValue(text);
                return true;
            }
            catch { return false; }
        }

        // The clipboard path for composers a ValuePattern cannot reach (a contenteditable). The
        // focus is borrowed and handed straight back: whoever had the foreground keeps it.
        static bool BorrowFocusAndPaste(AutomationElement composer, string text)
        {
            var before = NativeMethods.GetForegroundWindow();
            try
            {
                composer.SetFocus();
                var thread = new Thread(() =>
                {
                    try
                    {
                        System.Windows.Clipboard.SetText(text);
                        System.Windows.Forms.SendKeys.SendWait("^v");
                    }
                    catch { }
                });
                thread.SetApartmentState(ApartmentState.STA);
                thread.Start();
                thread.Join(2000);
            }
            catch { return false; }
            finally { if (before != IntPtr.Zero) NativeMethods.SetForegroundWindow(before); }
            return true;
        }

        static bool BorrowFocusAndKey(AutomationElement target, string keys)
        {
            var before = NativeMethods.GetForegroundWindow();
            try
            {
                target.SetFocus();
                var thread = new Thread(() =>
                {
                    try { System.Windows.Forms.SendKeys.SendWait(keys); } catch { }
                });
                thread.SetApartmentState(ApartmentState.STA);
                thread.Start();
                thread.Join(2000);
            }
            catch { return false; }
            finally { if (before != IntPtr.Zero) NativeMethods.SetForegroundWindow(before); }
            return true;
        }

        // Send prefers a button's InvokePattern — it works on a background window, no keys, no
        // focus. The composer's Enter is the fallback (the focus borrowed for one key).
        static bool PressSend(AutomationElement root, JsonElement profile, AutomationElement composer)
        {
            foreach (var key in new[] { "send", "chatSendButton" })
                foreach (var way in LocatorWays(profile, key))
                {
                    var hits = FindByWay(root, profile, way);
                    if (hits.Count == 1 && TryInvoke(hits[0])) return true;
                }
            return BorrowFocusAndKey(composer, "{ENTER}");
        }

        static bool TryInvoke(AutomationElement element)
        {
            try
            {
                if (element.TryGetCurrentPattern(InvokePattern.Pattern, out var pattern) && pattern is InvokePattern invoke)
                {
                    invoke.Invoke();
                    return true;
                }
            }
            catch { }
            return false;
        }

        // ---- describing (inspect / probe) ----

        static object Describe(AutomationElement element, int depth, int at = 0)
        {
            var current = element.Current;
            var said = new Dictionary<string, object>
            {
                ["type"] = current.ControlType?.ProgrammaticName.Replace("ControlType.", "") ?? "",
                ["class"] = current.ClassName ?? "",
                ["id"] = current.AutomationId ?? "",
                ["name"] = current.Name ?? "",
            };
            if (at < depth)
            {
                var children = new List<object>();
                foreach (AutomationElement child in element.FindAll(TreeScope.Children, Condition.TrueCondition))
                    children.Add(Describe(child, depth, at + 1));
                said["children"] = children;
            }
            return said;
        }

        static object Brief(AutomationElement element)
        {
            var current = element.Current;
            return new Dictionary<string, object>
            {
                ["type"] = current.ControlType?.ProgrammaticName.Replace("ControlType.", "") ?? "",
                ["class"] = current.ClassName ?? "",
                ["id"] = current.AutomationId ?? "",
                ["name"] = current.Name ?? "",
            };
        }

        static Dictionary<string, object> Ok() => new() { ["ok"] = true };
        static Dictionary<string, object> Fail(string code, string error) => new() { ["ok"] = false, ["code"] = code, ["error"] = error };
    }
}
