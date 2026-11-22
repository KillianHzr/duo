import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ClipboardEvent,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode
} from 'react'
import { MAX_FILES_PER_MESSAGE, MAX_TEXT_LENGTH, type ChatMessage, type FileRef } from '../../shared/protocol'
import { t } from './i18n'
import { isAudio, isImage, isVideo, type Space } from './space'

/** Messages from the same person less than this apart are shown as one block. */
const GROUP_MS = 5 * 60_000
const LINK = /(https?:\/\/[^\s<]+[^\s<.,;:!?)\]'"])/g

const dayKey = (at: number): string => new Date(at).toDateString()
const timeLabel = (at: number): string => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
const dayLabel = (at: number): string =>
  new Date(at).toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' })

export function formatSize(bytes: number): string {
  const [byte, ...units] = t('sizeUnits').split(',')
  if (bytes < 1024) return `${bytes} ${byte}`
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`
}

/** Turns web addresses into links, which open in the user's browser. */
function linkify(text: string): ReactNode[] {
  return text.split(LINK).map((part, i) =>
    i % 2 ? (
      <a key={i} href={part} target="_blank" rel="noreferrer">
        {part}
      </a>
    ) : (
      part
    )
  )
}

export function Chat({ space, self }: { space: Space; self: string }) {
  const chat = useSyncExternalStore(space.subscribe, space.getSnapshot)
  const [text, setText] = useState('')
  const [files, setFiles] = useState<File[]>([])
  const [viewer, setViewer] = useState<FileRef | null>(null)
  const [confirming, setConfirming] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const list = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLTextAreaElement>(null)
  const picker = useRef<HTMLInputElement>(null)
  /** True while the view follows the newest message. */
  const stick = useRef(true)
  const previous = useRef<{ first?: string; height: number }>({ height: 0 })

  useEffect(() => {
    const seen = (): void => space.setChatVisible(document.visibilityState === 'visible')
    seen()
    document.addEventListener('visibilitychange', seen)
    return () => {
      document.removeEventListener('visibilitychange', seen)
      space.setChatVisible(false)
    }
  }, [space])

  // Keeps the view where the reader left it: at the bottom when following the conversation,
  // on the same message when older ones are added above.
  useLayoutEffect(() => {
    const el = list.current
    if (!el) return
    const first = chat.messages[0]?.id
    if (stick.current) el.scrollTop = el.scrollHeight
    else if (previous.current.first && first !== previous.current.first) {
      el.scrollTop += el.scrollHeight - previous.current.height
    }
    previous.current = { first, height: el.scrollHeight }
  }, [chat.messages])

  useEffect(() => {
    if (!viewer) return
    const onKey = (event: globalThis.KeyboardEvent): void => {
      if (event.key === 'Escape') setViewer(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [viewer])

  const onScroll = (): void => {
    const el = list.current
    if (!el) return
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60
    if (el.scrollTop < 40) space.loadOlder()
  }

  const settle = (): void => {
    const el = list.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }

  const addFiles = (added: FileList | File[]): void => {
    setFiles((current) => [...current, ...Array.from(added)].slice(0, MAX_FILES_PER_MESSAGE))
  }

  const resize = (): void => {
    const el = input.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`
  }
  useLayoutEffect(resize, [text])

  const submit = (event?: FormEvent): void => {
    event?.preventDefault()
    if (!chat.available || (!text.trim() && !files.length)) return
    stick.current = true
    void space.sendMessage(text, files)
    setText('')
    setFiles([])
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) submit(event)
  }

  const onPaste = (event: ClipboardEvent): void => {
    if (!event.clipboardData.files.length) return
    event.preventDefault()
    addFiles(event.clipboardData.files)
  }

  const onDrop = (event: DragEvent): void => {
    event.preventDefault()
    setDragging(false)
    if (event.dataTransfer.files.length) addFiles(event.dataTransfer.files)
  }

  return (
    <section
      className={dragging ? 'chat dragging' : 'chat'}
      onDragOver={(event) => {
        event.preventDefault()
        setDragging(true)
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
    >
      <div className="messages" ref={list} onScroll={onScroll}>
        {chat.more && (
          <button className="ghost small" onClick={() => space.loadOlder()} disabled={chat.loadingOlder}>
            {t('loadOlder')}
          </button>
        )}
        {chat.messages.length === 0 && <p className="muted small empty-chat">{t('chatEmpty')}</p>}
        {chat.messages.map((message, i) => {
          const before: ChatMessage | undefined = chat.messages[i - 1]
          const newDay = !before || dayKey(before.at) !== dayKey(message.at)
          const grouped = !newDay && before.from === message.from && message.at - before.at < GROUP_MS
          const mine = message.from === self
          return (
            <div key={message.id} className={grouped ? 'msg grouped' : 'msg'}>
              {newDay && <div className="day muted small">{dayLabel(message.at)}</div>}
              {!grouped && (
                <div className="msg-head">
                  <strong className={mine ? 'mine' : undefined}>{message.from}</strong>
                  <span className="muted small">{timeLabel(message.at)}</span>
                </div>
              )}
              <div className="msg-body" title={timeLabel(message.at)}>
                <div className="msg-content">
                  {message.text && <p>{linkify(message.text)}</p>}
                  {message.files.map((file) => (
                    <Attachment key={file.id} file={file} space={space} onOpen={setViewer} onLoad={settle} />
                  ))}
                </div>
                {mine &&
                  (confirming === message.id ? (
                    <button
                      className="msg-action danger small"
                      autoFocus
                      onBlur={() => setConfirming(null)}
                      onClick={() => space.deleteMessage(message.id)}
                    >
                      {t('deleteConfirm')}
                    </button>
                  ) : (
                    <button
                      className="msg-action ghost small"
                      aria-label={t('delete')}
                      title={t('delete')}
                      onClick={() => setConfirming(message.id)}
                    >
                      ×
                    </button>
                  ))}
              </div>
            </div>
          )
        })}
      </div>

      {!chat.available && <div className="notice">{t('chatOffline')}</div>}
      {chat.uploads.map((upload) => (
        <div key={upload.id} className={upload.failed ? 'upload failed' : 'upload'}>
          <span className="small">{upload.failed ? `${t('uploadFailed')} — ${upload.name}` : upload.name}</span>
          {upload.failed ? (
            <button className="ghost small" onClick={() => space.dismissUpload(upload.id)}>
              ×
            </button>
          ) : (
            <div className="meter">
              <div style={{ width: `${Math.round(upload.progress * 100)}%` }} />
            </div>
          )}
        </div>
      ))}

      <form className="composer" onSubmit={submit}>
        {files.length > 0 && (
          <div className="chips">
            {files.map((file, i) => (
              <span key={i} className="chip small">
                {file.name} · {formatSize(file.size)}
                <button
                  type="button"
                  className="ghost"
                  aria-label={t('delete')}
                  onClick={() => setFiles((current) => current.filter((_, at) => at !== i))}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
        <div className="row">
          <button type="button" aria-label={t('attach')} title={t('attach')} onClick={() => picker.current?.click()}>
            +
          </button>
          <textarea
            ref={input}
            rows={1}
            value={text}
            maxLength={MAX_TEXT_LENGTH}
            placeholder={t('chatPlaceholder')}
            aria-label={t('chatPlaceholder')}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
          />
          <button className="primary" type="submit" disabled={!chat.available || (!text.trim() && !files.length)}>
            {t('send')}
          </button>
        </div>
        <input
          ref={picker}
          type="file"
          multiple
          hidden
          onChange={(event) => {
            if (event.target.files) addFiles(event.target.files)
            event.target.value = ''
          }}
        />
      </form>

      {viewer && (
        <div className="overlay viewer" onClick={() => setViewer(null)}>
          <img src={space.mediaUrl(viewer.id)} alt={viewer.name} onClick={(event) => event.stopPropagation()} />
          <div className="row" onClick={(event) => event.stopPropagation()}>
            <button onClick={() => window.duo.download(space.mediaUrl(viewer.id, true))}>{t('saveFile')}</button>
            <button className="ghost" onClick={() => setViewer(null)}>
              {t('close')}
            </button>
          </div>
        </div>
      )}
    </section>
  )
}

function Attachment(props: { file: FileRef; space: Space; onOpen: (file: FileRef) => void; onLoad: () => void }) {
  const { file, space } = props
  if (isImage(file)) {
    return (
      <img
        className="photo"
        src={space.mediaUrl(file.thumb ?? file.id)}
        alt={file.name}
        loading="lazy"
        style={file.width && file.height ? { aspectRatio: `${file.width} / ${file.height}` } : undefined}
        onLoad={props.onLoad}
        onClick={() => props.onOpen(file)}
      />
    )
  }
  if (isVideo(file)) {
    return <video className="photo" src={space.mediaUrl(file.id)} controls preload="metadata" onLoadedMetadata={props.onLoad} />
  }
  if (isAudio(file)) return <audio src={space.mediaUrl(file.id)} controls preload="none" />
  return (
    <button className="file" onClick={() => window.duo.download(space.mediaUrl(file.id, true))}>
      <strong>{file.name}</strong>
      <span className="muted small">
        {formatSize(file.size)} · {t('saveFile')}
      </span>
    </button>
  )
}
