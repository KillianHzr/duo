/**
 * Push-to-talk binding. The key is picked in the window (which knows the keyboard layout, so the
 * label is right on AZERTY too) and then watched system-wide by its physical position.
 */
export interface PttBinding {
  kind: 'key' | 'mouse'
  /** Hardware scan code of the key, or number of the mouse button, as the global listener reports them. */
  code: number
  /** What to show the user, e.g. "V" or "Mouse 4". */
  label: string
}

/** Physical keys (KeyboardEvent.code) and their scan codes. */
const SCAN_CODES: Record<string, number> = {
  Backspace: 14, Tab: 15, Enter: 28, CapsLock: 58, Space: 57,
  PageUp: 3657, PageDown: 3665, End: 3663, Home: 3655,
  ArrowLeft: 57419, ArrowUp: 57416, ArrowRight: 57421, ArrowDown: 57424,
  Insert: 3666, Delete: 3667,
  Digit0: 11, Digit1: 2, Digit2: 3, Digit3: 4, Digit4: 5, Digit5: 6, Digit6: 7, Digit7: 8, Digit8: 9, Digit9: 10,
  KeyA: 30, KeyB: 48, KeyC: 46, KeyD: 32, KeyE: 18, KeyF: 33, KeyG: 34, KeyH: 35, KeyI: 23, KeyJ: 36, KeyK: 37,
  KeyL: 38, KeyM: 50, KeyN: 49, KeyO: 24, KeyP: 25, KeyQ: 16, KeyR: 19, KeyS: 31, KeyT: 20, KeyU: 22, KeyV: 47,
  KeyW: 17, KeyX: 45, KeyY: 21, KeyZ: 44,
  Numpad0: 82, Numpad1: 79, Numpad2: 80, Numpad3: 81, Numpad4: 75, Numpad5: 76, Numpad6: 77, Numpad7: 71,
  Numpad8: 72, Numpad9: 73, NumpadMultiply: 55, NumpadAdd: 78, NumpadSubtract: 74, NumpadDecimal: 83,
  NumpadDivide: 3637,
  F1: 59, F2: 60, F3: 61, F4: 62, F5: 63, F6: 64, F7: 65, F8: 66, F9: 67, F10: 68, F11: 87, F12: 88,
  F13: 91, F14: 92, F15: 93, F16: 99, F17: 100, F18: 101, F19: 102, F20: 103, F21: 104, F22: 105, F23: 106,
  F24: 107,
  Semicolon: 39, Equal: 13, Comma: 51, Minus: 12, Period: 52, Slash: 53, Backquote: 41, BracketLeft: 26,
  Backslash: 43, BracketRight: 27, Quote: 40, IntlBackslash: 86,
  ControlLeft: 29, ControlRight: 3613, AltLeft: 56, AltRight: 3640, ShiftLeft: 42, ShiftRight: 54,
  ScrollLock: 70
}

/** Named keys whose `key` value is not a good label on its own. */
const LABELS: Record<string, string> = {
  Space: 'Space', ControlLeft: 'Ctrl', ControlRight: 'Right Ctrl', AltLeft: 'Alt', AltRight: 'Right Alt',
  ShiftLeft: 'Shift', ShiftRight: 'Right Shift'
}

/** Binding for a key pressed in the window, or null if that key cannot be watched. */
export function bindingFromKey(event: { code: string; key: string }): PttBinding | null {
  const code = SCAN_CODES[event.code]
  if (code === undefined) return null
  const label =
    LABELS[event.code] ??
    (event.code.startsWith('Numpad') ? event.code.replace('Numpad', 'Num ') : event.key.length === 1 ? event.key.toUpperCase() : event.key)
  return { kind: 'key', code, label }
}

/**
 * Binding for a mouse button pressed in the window. Left and right clicks are refused: they are
 * needed for everything else.
 */
export function bindingFromMouse(button: number): PttBinding | null {
  // The window numbers buttons 1 (middle), 3 (back), 4 (forward); the global listener 3, 4, 5.
  const code = { 1: 3, 3: 4, 4: 5 }[button]
  return code ? { kind: 'mouse', code, label: `Mouse ${code}` } : null
}
