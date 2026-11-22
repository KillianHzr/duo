/**
 * Push-to-talk: watches one key or mouse button system-wide, so it works while a game has the
 * focus. The listener is only installed while push-to-talk is on; it never blocks or changes
 * what the key does elsewhere.
 */
import type { PttBinding } from '../shared/keys'

type Hook = (typeof import('uiohook-napi'))['uIOhook']

let hook: Hook | null = null
let running = false
let binding: Pick<PttBinding, 'kind' | 'code'> | null = null
let down = false
let notify: (down: boolean) => void = () => {}

function set(next: boolean): void {
  if (down === next) return
  down = next
  notify(down)
}

async function load(): Promise<Hook> {
  if (hook) return hook
  const { uIOhook } = await import('uiohook-napi')
  uIOhook.on('keydown', (event) => {
    if (binding?.kind === 'key' && event.keycode === binding.code) set(true)
  })
  uIOhook.on('keyup', (event) => {
    if (binding?.kind === 'key' && event.keycode === binding.code) set(false)
  })
  uIOhook.on('mousedown', (event) => {
    if (binding?.kind === 'mouse' && event.button === binding.code) set(true)
  })
  uIOhook.on('mouseup', (event) => {
    if (binding?.kind === 'mouse' && event.button === binding.code) set(false)
  })
  hook = uIOhook
  return hook
}

/**
 * Starts watching the given key, or stops watching with null.
 * Returns false when the system does not allow a global listener.
 */
export async function setPushToTalk(next: typeof binding, onChange: (down: boolean) => void): Promise<boolean> {
  notify = onChange
  binding = next
  set(false)
  try {
    if (!next) {
      stopPushToTalk()
    } else if (!running) {
      ;(await load()).start()
      running = true
    }
    return true
  } catch (err) {
    console.error('push-to-talk unavailable:', err)
    binding = null
    return false
  }
}

export function stopPushToTalk(): void {
  if (!running) return
  running = false
  try {
    hook?.stop()
  } catch {
    /* already stopped */
  }
}
