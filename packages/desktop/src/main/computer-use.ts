import { Browser } from "@opencode-ai/plugin-browser/rpc"
import { spawn } from "node:child_process"
import electron, { type Display } from "electron"

const MAX_STDERR = 8_192
const MAX_ACTION_MS = 50_000

type InputCommand =
  | { type: "move"; x: number; y: number }
  | {
      type: "click"
      x: number
      y: number
      button: "left" | "right" | "middle"
      count: 1 | 2
      modifiers: number[]
    }
  | {
      type: "drag"
      fromX: number
      fromY: number
      toX: number
      toY: number
      button: "left" | "right" | "middle"
      durationMs: number
    }
  | { type: "type"; text: string; delayMs: number }
  | { type: "key"; keyCode: number; modifiers: number[] }
  | { type: "scroll"; x?: number; y?: number; deltaX: number; deltaY: number }

export async function executeComputerAction(
  action: Browser.ComputerAction,
  signal: AbortSignal,
): Promise<Browser.Result> {
  signal.throwIfAborted()
  if (action.type === "computer.displays") return result({ displays: displays() })
  if (action.type === "computer.screenshot") return screenshot(action)
  if (action.type === "computer.cursor_position") {
    const point = electron.screen.getCursorScreenPoint()
    return result({ x: point.x, y: point.y })
  }

  if (process.platform !== "win32")
    throw new Error("Host input is currently available only in the Windows desktop beta. Screenshot remains available.")

  if (action.type === "computer.move") {
    await input({ type: "move", x: action.x, y: action.y }, signal)
    return result({ x: action.x, y: action.y })
  }
  if (action.type === "computer.click" || action.type === "computer.double_click") {
    await input(
      {
        type: "click",
        x: action.x,
        y: action.y,
        button: action.button ?? "left",
        count: action.type === "computer.double_click" ? 2 : 1,
        modifiers: modifierCodes(action.modifiers),
      },
      signal,
    )
    return result({ ok: true })
  }
  if (action.type === "computer.drag") {
    await input(
      {
        type: "drag",
        fromX: action.fromX,
        fromY: action.fromY,
        toX: action.toX,
        toY: action.toY,
        button: action.button ?? "left",
        durationMs: action.durationMs ?? 500,
      },
      signal,
    )
    return result({ ok: true })
  }
  if (action.type === "computer.type") {
    const delayMs = action.delayMs ?? 0
    if (action.text.length * delayMs > 45_000)
      throw new Error("Typing would exceed the 45 second action budget. Reduce text length or delayMs.")
    await input({ type: "type", text: action.text, delayMs }, signal)
    return result({ ok: true })
  }
  if (action.type === "computer.key") {
    await input({ type: "key", keyCode: keyCode(action.key), modifiers: modifierCodes(action.modifiers) }, signal)
    return result({ ok: true })
  }
  if ((action.x === undefined) !== (action.y === undefined))
    throw new Error("computer.scroll requires both x and y, or neither.")
  await input(
    {
      type: "scroll",
      ...(action.x === undefined ? {} : { x: action.x, y: action.y }),
      deltaX: action.deltaX ?? 0,
      deltaY: action.deltaY,
    },
    signal,
  )
  return result({ ok: true })
}

function result(value: Browser.Result["value"], files: Browser.File[] = []): Browser.Result {
  return { value, files }
}

function displayInfo(display: Display, index: number): Browser.ComputerDisplay {
  return {
    index,
    id: String(display.id),
    primary: display.id === electron.screen.getPrimaryDisplay().id,
    bounds: {
      x: display.bounds.x,
      y: display.bounds.y,
      width: display.bounds.width,
      height: display.bounds.height,
    },
    scaleFactor: display.scaleFactor,
  }
}

function displays() {
  return electron.screen.getAllDisplays().map(displayInfo)
}

async function screenshot(action: Extract<Browser.ComputerAction, { type: "computer.screenshot" }>) {
  const available = electron.screen.getAllDisplays()
  const cursorDisplay = electron.screen.getDisplayNearestPoint(electron.screen.getCursorScreenPoint())
  const index = action.display ?? available.findIndex((item) => item.id === cursorDisplay.id)
  const display = available[index]
  if (!display)
    throw new Error(`Display index ${index} is unavailable. Call computer.displays({}) and use a returned index.`)
  const maxWidth = action.maxWidth ?? 1_280
  const ratio = display.bounds.height / display.bounds.width
  const width = Math.min(maxWidth, Math.max(1, Math.round(display.bounds.width * display.scaleFactor)))
  const height = Math.max(1, Math.round(width * ratio))
  const sources = await electron.desktopCapturer.getSources({
    types: ["screen"],
    thumbnailSize: { width, height },
    fetchWindowIcons: false,
  })
  const source = sources.find((item) => item.display_id === String(display.id)) ?? sources[index]
  if (!source || source.thumbnail.isEmpty())
    throw new Error("Windows did not return a screen image. Keep the desktop session unlocked and retry once.")
  const size = source.thumbnail.getSize()
  const data = source.thumbnail.toPNG()
  if (data.byteLength > Browser.MAX_FILE_BYTES)
    throw new Error("Screen capture exceeds 5 MiB. Retry with a smaller maxWidth.")
  const file: Browser.File = {
    id: Browser.FileID.make(`file_${crypto.randomUUID()}`),
    name: `computer-display-${index}.png`,
    mime: "image/png",
    data: new Uint8Array(data),
  }
  return result(
    {
      display: displayInfo(display, index),
      width: size.width,
      height: size.height,
      scale: size.width / display.bounds.width,
    },
    [file],
  )
}

function modifierCodes(modifiers: ReadonlyArray<"Alt" | "Control" | "Meta" | "Shift"> | undefined) {
  const codes = { Alt: 0x12, Control: 0x11, Meta: 0x5b, Shift: 0x10 }
  return (modifiers ?? []).map((modifier) => codes[modifier])
}

export function keyCode(value: string) {
  const key = value.trim()
  if (/^[a-z0-9]$/i.test(key)) return key.toUpperCase().charCodeAt(0)
  const functionKey = /^F([1-9]|1[0-9]|2[0-4])$/i.exec(key)
  if (functionKey) return 0x6f + Number(functionKey[1])
  const named: Record<string, number> = {
    backspace: 0x08,
    tab: 0x09,
    enter: 0x0d,
    shift: 0x10,
    control: 0x11,
    alt: 0x12,
    pause: 0x13,
    capslock: 0x14,
    escape: 0x1b,
    space: 0x20,
    pageup: 0x21,
    pagedown: 0x22,
    end: 0x23,
    home: 0x24,
    arrowleft: 0x25,
    arrowup: 0x26,
    arrowright: 0x27,
    arrowdown: 0x28,
    insert: 0x2d,
    delete: 0x2e,
    meta: 0x5b,
  }
  const code = named[key.toLowerCase().replace(/[ _-]/g, "")]
  if (code === undefined)
    throw new Error(
      `Unsupported key ${JSON.stringify(value)}. Use one letter/digit, F1-F24, Enter, Escape, Tab, Space, an arrow, or a navigation key.`,
    )
  return code
}

async function input(command: InputCommand, signal: AbortSignal) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encodedScript],
      {
        windowsHide: true,
        env: { ...process.env, OPENCODE_COMPUTER_ACTION: JSON.stringify(command) },
        stdio: ["ignore", "ignore", "pipe"],
      },
    )
    let stderr = ""
    child.stderr.setEncoding("utf8")
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < MAX_STDERR) stderr += chunk.slice(0, MAX_STDERR - stderr.length)
    })
    const abort = () => child.kill()
    signal.addEventListener("abort", abort, { once: true })
    const timeout = setTimeout(abort, MAX_ACTION_MS)
    child.once("error", reject)
    child.once("close", (code) => {
      clearTimeout(timeout)
      signal.removeEventListener("abort", abort)
      if (signal.aborted)
        return reject(new Error("Computer input was cancelled; inspect the screen before repeating it."))
      if (code !== 0)
        return reject(
          new Error(
            `Windows input failed${stderr.trim() ? `: ${stderr.trim().slice(0, 1_000)}` : ". It may be blocked by UIPI when the target is elevated."}`,
          ),
        )
      resolve()
    })
  })
}

const script = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Threading;

public static class OpenCodeComputerInput {
  [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public InputUnion U; }
  [StructLayout(LayoutKind.Explicit)] struct InputUnion {
    [FieldOffset(0)] public MOUSEINPUT mi;
    [FieldOffset(0)] public KEYBDINPUT ki;
    [FieldOffset(0)] public HARDWAREINPUT hi;
  }
  [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT {
    public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public UIntPtr extraInfo;
  }
  [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT {
    public ushort virtualKey; public ushort scanCode; public uint flags; public uint time; public UIntPtr extraInfo;
  }
  [StructLayout(LayoutKind.Sequential)] struct HARDWAREINPUT { public uint message; public ushort low; public ushort high; }

  [DllImport("user32.dll", SetLastError=true)] static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] static extern void mouse_event(uint flags, uint dx, uint dy, int data, UIntPtr extraInfo);
  [DllImport("user32.dll")] static extern void keybd_event(byte key, byte scan, uint flags, UIntPtr extraInfo);
  [DllImport("user32.dll", SetLastError=true)] static extern uint SendInput(uint count, INPUT[] inputs, int size);

  public static void Move(int x, int y) {
    if (!SetCursorPos(x, y)) throw new Win32Exception(Marshal.GetLastWin32Error());
  }
  public static void Mouse(uint flags, int data) { mouse_event(flags, 0, 0, data, UIntPtr.Zero); }
  public static void KeyDown(int key) { keybd_event((byte)key, 0, 0, UIntPtr.Zero); }
  public static void KeyUp(int key) { keybd_event((byte)key, 0, 2, UIntPtr.Zero); }
  public static void TypeText(string text, int delayMs) {
    foreach (char value in text) {
      var inputs = new INPUT[] {
        new INPUT { type = 1, U = new InputUnion { ki = new KEYBDINPUT { scanCode = value, flags = 4 } } },
        new INPUT { type = 1, U = new InputUnion { ki = new KEYBDINPUT { scanCode = value, flags = 6 } } }
      };
      if (SendInput(2, inputs, Marshal.SizeOf(typeof(INPUT))) != 2)
        throw new Win32Exception(Marshal.GetLastWin32Error());
      if (delayMs > 0) Thread.Sleep(delayMs);
    }
  }
}
'@

$command = $env:OPENCODE_COMPUTER_ACTION | ConvertFrom-Json
function Down([string]$button) { if ($button -eq 'right') { 8 } elseif ($button -eq 'middle') { 32 } else { 2 } }
function Up([string]$button) { if ($button -eq 'right') { 16 } elseif ($button -eq 'middle') { 64 } else { 4 } }
function ModifiersDown($values) { foreach ($value in $values) { [OpenCodeComputerInput]::KeyDown([int]$value) } }
function ModifiersUp($values) { for ($index = $values.Count - 1; $index -ge 0; $index--) { [OpenCodeComputerInput]::KeyUp([int]$values[$index]) } }

switch ($command.type) {
  'move' { [OpenCodeComputerInput]::Move([int]$command.x, [int]$command.y) }
  'click' {
    ModifiersDown $command.modifiers
    try {
      [OpenCodeComputerInput]::Move([int]$command.x, [int]$command.y)
      for ($index = 0; $index -lt [int]$command.count; $index++) {
        [OpenCodeComputerInput]::Mouse((Down $command.button), 0)
        [OpenCodeComputerInput]::Mouse((Up $command.button), 0)
        if ($command.count -gt 1) { Start-Sleep -Milliseconds 75 }
      }
    } finally { ModifiersUp $command.modifiers }
  }
  'drag' {
    [OpenCodeComputerInput]::Move([int]$command.fromX, [int]$command.fromY)
    [OpenCodeComputerInput]::Mouse((Down $command.button), 0)
    try {
      $steps = 10
      for ($index = 1; $index -le $steps; $index++) {
        $x = [int]($command.fromX + (($command.toX - $command.fromX) * $index / $steps))
        $y = [int]($command.fromY + (($command.toY - $command.fromY) * $index / $steps))
        [OpenCodeComputerInput]::Move($x, $y)
        if ($command.durationMs -gt 0) { Start-Sleep -Milliseconds ([int]($command.durationMs / $steps)) }
      }
    } finally { [OpenCodeComputerInput]::Mouse((Up $command.button), 0) }
  }
  'type' { [OpenCodeComputerInput]::TypeText([string]$command.text, [int]$command.delayMs) }
  'key' {
    ModifiersDown $command.modifiers
    try {
      [OpenCodeComputerInput]::KeyDown([int]$command.keyCode)
      [OpenCodeComputerInput]::KeyUp([int]$command.keyCode)
    } finally { ModifiersUp $command.modifiers }
  }
  'scroll' {
    if ($null -ne $command.x) { [OpenCodeComputerInput]::Move([int]$command.x, [int]$command.y) }
    if ([int]$command.deltaX -ne 0) { [OpenCodeComputerInput]::Mouse(4096, -[int]$command.deltaX) }
    if ([int]$command.deltaY -ne 0) { [OpenCodeComputerInput]::Mouse(2048, -[int]$command.deltaY) }
  }
  default { throw 'Unsupported computer input action.' }
}
`

const encodedScript = Buffer.from(script, "utf16le").toString("base64")
