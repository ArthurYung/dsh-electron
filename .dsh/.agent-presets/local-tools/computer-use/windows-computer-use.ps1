param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('observe', 'action')]
    [string]$Operation,

    [Parameter(Mandatory = $true)]
    [string]$PayloadBase64
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Drawing

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class DshComputerUseNative
{
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

    [StructLayout(LayoutKind.Sequential)]
    private struct INPUT { public uint type; public InputUnion U; }

    [StructLayout(LayoutKind.Explicit)]
    private struct InputUnion
    {
        [FieldOffset(0)] public MOUSEINPUT mi;
        [FieldOffset(0)] public KEYBDINPUT ki;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MOUSEINPUT
    {
        public int dx;
        public int dy;
        public uint mouseData;
        public uint dwFlags;
        public uint time;
        public UIntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct KEYBDINPUT
    {
        public ushort wVk;
        public ushort wScan;
        public uint dwFlags;
        public uint time;
        public UIntPtr dwExtraInfo;
    }

    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdcBlt, uint flags);
    [DllImport("user32.dll")] private static extern uint SendInput(uint nInputs, INPUT[] inputs, int cbSize);
    [DllImport("user32.dll")] private static extern short VkKeyScan(char ch);

    private const uint INPUT_MOUSE = 0;
    private const uint INPUT_KEYBOARD = 1;
    private const uint KEYEVENTF_KEYUP = 0x0002;
    private const uint KEYEVENTF_UNICODE = 0x0004;
    private const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
    private const uint MOUSEEVENTF_LEFTUP = 0x0004;
    private const uint MOUSEEVENTF_RIGHTDOWN = 0x0008;
    private const uint MOUSEEVENTF_RIGHTUP = 0x0010;
    private const uint MOUSEEVENTF_WHEEL = 0x0800;

    private static void Send(params INPUT[] inputs)
    {
        if (SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT))) == 0)
            throw new InvalidOperationException("SendInput failed with Win32 error " + Marshal.GetLastWin32Error());
    }

    private static INPUT KeyInput(ushort vk, ushort scan, uint flags)
    {
        var input = new INPUT();
        input.type = INPUT_KEYBOARD;
        input.U.ki.wVk = vk;
        input.U.ki.wScan = scan;
        input.U.ki.dwFlags = flags;
        return input;
    }

    private static INPUT MouseInput(uint flags, uint data)
    {
        var input = new INPUT();
        input.type = INPUT_MOUSE;
        input.U.mi.dwFlags = flags;
        input.U.mi.mouseData = data;
        return input;
    }

    public static void Activate(IntPtr hwnd)
    {
        if (hwnd == IntPtr.Zero) return;
        ShowWindow(hwnd, 9);
        BringWindowToTop(hwnd);
        SetForegroundWindow(hwnd);
    }

    public static void MouseClick(int x, int y, string button, int count)
    {
        SetCursorPos(x, y);
        uint down = button == "right" ? MOUSEEVENTF_RIGHTDOWN : MOUSEEVENTF_LEFTDOWN;
        uint up = button == "right" ? MOUSEEVENTF_RIGHTUP : MOUSEEVENTF_LEFTUP;
        for (int i = 0; i < count; i++)
        {
            Send(MouseInput(down, 0), MouseInput(up, 0));
            if (count > 1) System.Threading.Thread.Sleep(80);
        }
    }

    public static void Scroll(int x, int y, int delta)
    {
        SetCursorPos(x, y);
        Send(MouseInput(MOUSEEVENTF_WHEEL, unchecked((uint)delta)));
    }

    public static void SendText(string text)
    {
        foreach (char ch in text)
        {
            Send(
                KeyInput(0, ch, KEYEVENTF_UNICODE),
                KeyInput(0, ch, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP)
            );
        }
    }

    private static ushort VirtualKey(string name)
    {
        var keys = new Dictionary<string, ushort>(StringComparer.OrdinalIgnoreCase)
        {
            { "CTRL", 0x11 }, { "CONTROL", 0x11 }, { "SHIFT", 0x10 }, { "ALT", 0x12 },
            { "ENTER", 0x0D }, { "RETURN", 0x0D },
            { "TAB", 0x09 }, { "ESC", 0x1B }, { "ESCAPE", 0x1B }, { "SPACE", 0x20 },
            { "BACKSPACE", 0x08 }, { "DELETE", 0x2E }, { "HOME", 0x24 }, { "END", 0x23 },
            { "PAGEUP", 0x21 }, { "PAGEDOWN", 0x22 }, { "UP", 0x26 }, { "DOWN", 0x28 },
            { "LEFT", 0x25 }, { "RIGHT", 0x27 }, { "INSERT", 0x2D }
        };
        ushort value;
        if (keys.TryGetValue(name, out value)) return value;
        if (name.Length > 1 && name.StartsWith("F", StringComparison.OrdinalIgnoreCase))
        {
            int fn;
            if (Int32.TryParse(name.Substring(1), out fn) && fn >= 1 && fn <= 24)
                return (ushort)(0x70 + fn - 1);
        }
        if (name.Length == 1)
        {
            short scan = VkKeyScan(Char.ToUpperInvariant(name[0]));
            if (scan != -1) return (ushort)(scan & 0xff);
        }
        throw new ArgumentException("Unsupported key: " + name);
    }

    public static void SendChord(string chord)
    {
        string[] names = chord.Split(new[] { '+' }, StringSplitOptions.RemoveEmptyEntries);
        if (names.Length == 0) throw new ArgumentException("Empty key chord");
        var keys = new List<ushort>();
        foreach (string raw in names) keys.Add(VirtualKey(raw.Trim()));
        foreach (ushort key in keys) Send(KeyInput(key, 0, 0));
        for (int i = keys.Count - 1; i >= 0; i--) Send(KeyInput(keys[i], 0, KEYEVENTF_KEYUP));
    }
}
'@

function Convert-Payload {
    $bytes = [Convert]::FromBase64String($PayloadBase64)
    $json = [Text.Encoding]::UTF8.GetString($bytes)
    return $json | ConvertFrom-Json
}

function Convert-Bounds([Windows.Rect]$rect) {
    return [ordered]@{
        x = [int][Math]::Round($rect.X)
        y = [int][Math]::Round($rect.Y)
        width = [int][Math]::Max(0, [Math]::Round($rect.Width))
        height = [int][Math]::Max(0, [Math]::Round($rect.Height))
    }
}

function Get-TargetWindow($payload) {
    if ($null -ne $payload.windowHandle -and [long]$payload.windowHandle -ne 0) {
        return [Windows.Automation.AutomationElement]::FromHandle([IntPtr][long]$payload.windowHandle)
    }

    if (-not [string]::IsNullOrWhiteSpace([string]$payload.windowTitle)) {
        $root = [Windows.Automation.AutomationElement]::RootElement
        $windows = $root.FindAll(
            [Windows.Automation.TreeScope]::Children,
            [Windows.Automation.Condition]::TrueCondition
        )
        foreach ($window in $windows) {
            try {
                if ($window.Current.Name.IndexOf(
                    [string]$payload.windowTitle,
                    [StringComparison]::OrdinalIgnoreCase
                ) -ge 0) {
                    return $window
                }
            } catch { }
        }
        throw "No top-level window title contains '$($payload.windowTitle)'."
    }

    $handle = [DshComputerUseNative]::GetForegroundWindow()
    if ($handle -eq [IntPtr]::Zero) { throw 'There is no foreground window.' }
    return [Windows.Automation.AutomationElement]::FromHandle($handle)
}

function Test-Pattern($element, $pattern) {
    $value = $null
    try { return $element.TryGetCurrentPattern($pattern, [ref]$value) } catch { return $false }
}

function Save-WindowScreenshot([IntPtr]$handle, [string]$path) {
    $rect = New-Object DshComputerUseNative+RECT
    if (-not [DshComputerUseNative]::GetWindowRect($handle, [ref]$rect)) {
        throw 'Unable to read the window screenshot bounds.'
    }
    $width = [Math]::Max(1, $rect.Right - $rect.Left)
    $height = [Math]::Max(1, $rect.Bottom - $rect.Top)
    $bitmap = New-Object Drawing.Bitmap($width, $height, [Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $graphics = [Drawing.Graphics]::FromImage($bitmap)
    try {
        $hdc = $graphics.GetHdc()
        try { $printed = [DshComputerUseNative]::PrintWindow($handle, $hdc, 2) }
        finally { $graphics.ReleaseHdc($hdc) }
        if (-not $printed) {
            $graphics.CopyFromScreen($rect.Left, $rect.Top, 0, 0, (New-Object Drawing.Size($width, $height)))
        }
        $bitmap.Save($path, [Drawing.Imaging.ImageFormat]::Png)
    } finally {
        $graphics.Dispose()
        $bitmap.Dispose()
    }
}

function Invoke-Observe($payload) {
    if ([int]$payload.delayMs -gt 0) { Start-Sleep -Milliseconds ([int]$payload.delayMs) }
    $window = Get-TargetWindow $payload
    $windowHandle = [long]$window.Current.NativeWindowHandle
    $processName = ''
    try { $processName = [string](Get-Process -Id ([int]$window.Current.ProcessId)).ProcessName } catch { }
    $queue = New-Object Collections.Queue
    $queue.Enqueue([pscustomobject]@{ element = $window; depth = 0 })
    $walker = [Windows.Automation.TreeWalker]::ControlViewWalker
    $elements = New-Object Collections.Generic.List[object]
    $refNumber = 1

    while ($queue.Count -gt 0 -and $elements.Count -lt [int]$payload.maxElements) {
        $item = $queue.Dequeue()
        $element = $item.element
        $depth = [int]$item.depth

        if ($depth -gt 0) {
            try {
                $current = $element.Current
                $bounds = Convert-Bounds $current.BoundingRectangle
                $controlType = $current.ControlType.ProgrammaticName -replace '^ControlType\.', ''
                $interactiveTypes = @(
                    'Button', 'Edit', 'ComboBox', 'ListItem', 'TreeItem', 'Hyperlink',
                    'MenuItem', 'CheckBox', 'RadioButton', 'TabItem', 'Slider', 'Spinner'
                )
                $interactive = $interactiveTypes -contains $controlType
                if (-not $interactive) {
                    $interactive = (Test-Pattern $element ([Windows.Automation.InvokePattern]::Pattern)) -or
                        (Test-Pattern $element ([Windows.Automation.ValuePattern]::Pattern)) -or
                        (Test-Pattern $element ([Windows.Automation.TogglePattern]::Pattern)) -or
                        (Test-Pattern $element ([Windows.Automation.SelectionItemPattern]::Pattern))
                }
                if (-not $current.IsOffscreen -and ($interactive -or -not [string]::IsNullOrWhiteSpace($current.Name))) {
                    $elements.Add([ordered]@{
                        ref = "e$refNumber"
                        depth = $depth
                        name = [string]$current.Name
                        automationId = [string]$current.AutomationId
                        className = [string]$current.ClassName
                        controlType = [string]$controlType
                        enabled = [bool]$current.IsEnabled
                        focused = [bool]$current.HasKeyboardFocus
                        interactive = [bool]$interactive
                        bounds = $bounds
                    })
                    $refNumber++
                }
            } catch { }
        }

        if ($depth -lt [int]$payload.maxDepth) {
            try {
                $child = $walker.GetFirstChild($element)
                while ($null -ne $child) {
                    $queue.Enqueue([pscustomobject]@{ element = $child; depth = $depth + 1 })
                    $child = $walker.GetNextSibling($child)
                }
            } catch { }
        }
    }

    $result = [ordered]@{
        window = [ordered]@{
            handle = $windowHandle
            title = [string]$window.Current.Name
            processId = [int]$window.Current.ProcessId
            processName = $processName
            className = [string]$window.Current.ClassName
            bounds = Convert-Bounds $window.Current.BoundingRectangle
        }
        elements = @($elements)
    }
    if ([bool]$payload.includeScreenshot) {
        Save-WindowScreenshot ([IntPtr]$windowHandle) ([string]$payload.screenshotPath)
        $result.screenshotPath = [string]$payload.screenshotPath
    }
    return $result
}

function Invoke-Action($payload) {
    $handle = if ($null -ne $payload.windowHandle) { [IntPtr][long]$payload.windowHandle } else { [IntPtr]::Zero }
    [DshComputerUseNative]::Activate($handle)
    Start-Sleep -Milliseconds 100
    $hasPoint = $null -ne $payload.x -and $null -ne $payload.y
    $x = if ($hasPoint) { [int][Math]::Round([double]$payload.x) } else { 0 }
    $y = if ($hasPoint) { [int][Math]::Round([double]$payload.y) } else { 0 }

    switch ([string]$payload.action) {
        'click' {
            [DshComputerUseNative]::MouseClick($x, $y, [string]$payload.button, 1)
        }
        'double_click' {
            [DshComputerUseNative]::MouseClick($x, $y, [string]$payload.button, 2)
        }
        'move' {
            [DshComputerUseNative]::SetCursorPos($x, $y) | Out-Null
        }
        'type' {
            if ($hasPoint) { [DshComputerUseNative]::MouseClick($x, $y, 'left', 1); Start-Sleep -Milliseconds 80 }
            if ([bool]$payload.replace) { [DshComputerUseNative]::SendChord('CTRL+A') }
            [DshComputerUseNative]::SendText([string]$payload.text)
        }
        'keypress' {
            [DshComputerUseNative]::SendChord([string]$payload.keys)
        }
        'scroll' {
            if (-not $hasPoint) {
                $rect = New-Object DshComputerUseNative+RECT
                if ($handle -ne [IntPtr]::Zero -and [DshComputerUseNative]::GetWindowRect($handle, [ref]$rect)) {
                    $x = [int](($rect.Left + $rect.Right) / 2)
                    $y = [int](($rect.Top + $rect.Bottom) / 2)
                }
            }
            [DshComputerUseNative]::Scroll($x, $y, [int]$payload.scrollDelta)
        }
        default { throw "Unsupported Computer Use action: $($payload.action)" }
    }

    return [ordered]@{
        success = $true
        action = [string]$payload.action
        target = [string]$payload.target
        message = "Windows Computer Use executed $($payload.action) on $($payload.target). Call computer_observe again to verify the result."
    }
}

try {
    $payload = Convert-Payload
    $result = if ($Operation -eq 'observe') { Invoke-Observe $payload } else { Invoke-Action $payload }
    $result | ConvertTo-Json -Compress -Depth 10
} catch {
    [Console]::Error.WriteLine($_.Exception.ToString())
    exit 1
}
