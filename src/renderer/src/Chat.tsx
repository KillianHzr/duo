import {
  Fragment,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ClipboardEvent,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode
} from 'react'
import { MAX_FILES_PER_MESSAGE, MAX_TEXT_LENGTH, type ChatMessage, type FileRef } from '../../shared/protocol'
import { EMOJI_GROUPS, QUICK_REACTIONS } from './emoji'
import { t } from './i18n'
import { Avatar, Icon, hue } from './icons'
import { LazyVideo, LinkCard, PdfCard, PdfViewer, isPdf } from './Previews'
import { isAudio, isImage, isVideo, type Space } from './space'

/** Messages from the same person less than this apart are shown as one block. */
const GROUP_MS = 5 * 60_000
const LINK = /(https?:\/\/[^\s<]+[^\s<.,;:!?)\]'"])/g
/** Web pages previewed under a message, at most. */
const MAX_LINK_CARDS = 2
const SEARCH_DELAY_MS = 250

const dayKey = (at: number): string => new Date(at).toDateString()
const timeLabel = (at: number): string => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
const dayLabel = (at: number): string =>
  new Date(at).toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' })
const dateLabel = (at: number): string =>
  new Date(at).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' })

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

const linksOf = (text: string): string[] => [...new Set(text.match(LINK) ?? [])].slice(0, MAX_LINK_CARDS)

/** Lower case without accents, as the host searches. */
const fold = (text: string): string => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()

/** Marks the searched words in a result, ignoring case and accents like the search does. */
function highlight(text: string, query: string): ReactNode[] {
  const words = fold(query).split(/\s+/).filter(Boolean)
  if (!words.length) return [text]
  // Folds the text one character at a time, remembering where each folded character came from.
  const chars = Array.from(text)
  let folded = ''
  const origin: number[] = []
  chars.forEach((char, i) => {
    for (const piece of fold(char)) {
      folded += piece
      origin.push(i)
    }
  })
  const marked = new Array<boolean>(chars.length).fill(false)
  for (const word of words) {
    for (let at = folded.indexOf(word); at >= 0; at = folded.indexOf(word, at + word.length)) {
      for (let k = at; k < at + word.length; k++) marked[origin[k]] = true
    }
  }
  const parts: ReactNode[] = []
  let start = 0
  for (let i = 1; i <= chars.length; i++) {
    if (i < chars.length && marked[i] === marked[start]) continue
    const piece = chars.slice(start, i).join('')
    parts.push(marked[start] ? <mark key={start}>{piece}</mark> : piece)
    start = i
  }
  return parts
}

const fileSummary = (count: number): string => (count > 1 ? t('filesCount', { count: String(count) }) : t('oneFile'))

type Panel = 'pins' | null

export function Chat({ space, self, faces }: { space: Space; self: string; faces: Record<string, number | undefined> }) {
  const chat = useSyncExternalStore(space.subscribe, space.getSnapshot)
  const [text, setText] = useState('')
  const [files, setFiles] = useState<File[]>([])
  const [viewer, setViewer] = useState<FileRef | null>(null)
  const [pdf, setPdf] = useState<FileRef | null>(null)
  const [dragging, setDragging] = useState(false)
  const [replyTo, setReplyTo] = useState<ChatMessage | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [panel, setPanel] = useState<Panel>(null)
  const [query, setQuery] = useState('')
  const [flash, setFlash] = useState<string | null>(null)
  const list = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLTextAreaElement>(null)
  const picker = useRef<HTMLInputElement>(null)
  const calendar = useRef<HTMLInputElement>(null)
  /** True while the view follows the newest message. */
  const stick = useRef(true)
  const previous = useRef<{ first?: string; height: number }>({ height: 0 })
  /** Where the conversation was scrolled, to come back to it after the search or the pins. */
  const lastScroll = useRef(0)

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
    if (stick.current && !chat.newer) el.scrollTop = el.scrollHeight
    else if (previous.current.first && first !== previous.current.first && chat.messages.some((m) => m.id === previous.current.first)) {
      el.scrollTop += el.scrollHeight - previous.current.height
    }
    previous.current = { first, height: el.scrollHeight }
  }, [chat.messages, chat.newer])

  const searching = chat.search !== null
  const showList = !searching && panel === null

  // Back from the search or the pins, the conversation is where it was, or at its end when following it.
  // Declared before the jump below, so a jump that closes the search wins.
  useLayoutEffect(() => {
    const el = list.current
    if (!el || !showList) return
    el.scrollTop = stick.current && !chat.newer ? el.scrollHeight : lastScroll.current
  }, [showList]) // eslint-disable-line react-hooks/exhaustive-deps

  // A jump (from a reply, a pin or a search result) brings the message to the middle and lights it up.
  useLayoutEffect(() => {
    if (!chat.focus) return
    const el = list.current?.querySelector(`[data-id="${chat.focus.id}"]`)
    if (!el) return
    stick.current = false
    el.scrollIntoView({ block: 'center' })
    setFlash(chat.focus.id)
    const timer = setTimeout(() => setFlash(null), 1600)
    return () => clearTimeout(timer)
  }, [chat.focus])

  // The host is asked once typing pauses, not at every key.
  useEffect(() => {
    const timer = setTimeout(() => space.searchMessages(query), query.trim() ? SEARCH_DELAY_MS : 0)
    return () => clearTimeout(timer)
  }, [query, space])

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
    if (!el || el.hidden) return
    lastScroll.current = el.scrollTop
    const fromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    stick.current = fromBottom < 60
    if (el.scrollTop < 200) space.loadOlder()
    if (fromBottom < 200) space.loadNewer()
  }

  const settle = (): void => {
    const el = list.current
    if (el && stick.current && !chat.newer) el.scrollTop = el.scrollHeight
  }

  const toLatest = (): void => {
    stick.current = true
    if (chat.newer) space.backToLatest()
    else settle()
  }

  const jump = (id: string): void => {
    setPanel(null)
    setQuery('')
    // Closed at once rather than after the search delay, so the conversation is back before the jump lands.
    space.searchMessages('')
    space.jumpTo(id)
  }

  const jumpToDate = (date: number): void => {
    setPanel(null)
    setQuery('')
    space.searchMessages('')
    space.jumpToDate(date)
  }

  const addFiles = (added: FileList | File[]): void => {
    // Copied now: the file picker's list is emptied right after this call, before React reads it.
    const chosen = Array.from(added)
    setFiles((current) => [...current, ...chosen].slice(0, MAX_FILES_PER_MESSAGE))
    // Ready to type a word with it, or to send it with Enter.
    input.current?.focus()
  }

  const resize = (): void => {
    const el = input.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`
  }
  useLayoutEffect(resize, [text, files.length])
  // The box is measured again when its width changes: a box measured while narrow would stay tall.
  useEffect(() => {
    const el = input.current
    if (!el) return
    let width = el.clientWidth
    const observer = new ResizeObserver(() => {
      if (el.clientWidth === width) return
      width = el.clientWidth
      resize()
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const submit = (event?: FormEvent): void => {
    event?.preventDefault()
    if (!chat.available || (!text.trim() && !files.length)) return
    toLatest()
    void space.sendMessage(text, files, replyTo?.id)
    setText('')
    setFiles([])
    setReplyTo(null)
  }

  const startReply = (message: ChatMessage): void => {
    setEditing(null)
    setReplyTo(message)
    input.current?.focus()
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) submit(event)
    else if (event.key === 'Escape' && replyTo) setReplyTo(null)
    else if (event.key === 'ArrowUp' && !text) {
      // As in most chat apps, the up arrow in an empty box edits your last message.
      const last = [...chat.messages].reverse().find((m) => m.from === self && m.text)
      if (last) {
        event.preventDefault()
        setEditing(last.id)
      }
    }
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
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false)
      }}
      onDrop={onDrop}
    >
      <div className="chat-bar">
        <label className="search-box">
          <Icon name="search" size={16} />
          <input
            type="search"
            value={query}
            placeholder={t('searchPlaceholder')}
            aria-label={t('searchPlaceholder')}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') setQuery('')
            }}
          />
          {query && (
            <button className="icon-btn" aria-label={t('close')} onClick={() => setQuery('')}>
              <Icon name="close" size={14} />
            </button>
          )}
        </label>
        <button
          className="icon-btn"
          aria-label={t('goToDate')}
          data-tip={t('goToDate')}
          data-tip-align="end"
          onClick={() => calendar.current?.showPicker()}
        >
          <Icon name="calendar" size={18} />
        </button>
        <input
          ref={calendar}
          className="date-picker"
          type="date"
          tabIndex={-1}
          aria-hidden
          max={new Date().toLocaleDateString('sv')}
          onChange={(event) => {
            const [y, m, d] = event.target.value.split('-').map(Number)
            if (y && m && d) jumpToDate(new Date(y, m - 1, d).getTime())
            event.target.value = ''
          }}
        />
        <button
          className={panel === 'pins' ? 'icon-btn pins-btn active' : 'icon-btn pins-btn'}
          aria-label={t('pinnedMessages')}
          aria-pressed={panel === 'pins'}
          data-tip={t('pinnedMessages')}
          data-tip-align="end"
          onClick={() => setPanel(panel === 'pins' ? null : 'pins')}
        >
          <Icon name="pin" size={18} />
          {chat.pins.length > 0 && <span className="count">{chat.pins.length}</span>}
        </button>
      </div>

      {searching && (
        <div className="messages side-list">
          <div className="list-head muted small">
            {chat.search!.date && (
              <span className="date-chip">
                <Icon name="calendar" size={13} />
                {chat.search!.date.label}
              </span>
            )}
            {chat.search!.results === null
              ? t('searchingChat')
              : chat.search!.total === 0
                ? t('searchNone')
                : t(chat.search!.total > 1 ? 'searchResults' : 'searchResult', { count: String(chat.search!.total) })}
          </div>
          {chat.search!.results?.map((message) => (
            <ResultCard key={message.id} message={message} faces={faces} query={chat.search!.words} onOpen={() => jump(message.id)} />
          ))}
        </div>
      )}

      {!searching && panel === 'pins' && (
        <div className="messages side-list">
          <div className="list-head muted small">{t('pinnedMessages')}</div>
          {chat.pins.length === 0 && (
            <div className="empty-state">
              <span className="empty-icon">
                <Icon name="pin" size={26} />
              </span>
              <p className="muted">{t('noPins')}</p>
            </div>
          )}
          {chat.pins.map((message) => (
            <ResultCard
              key={message.id}
              message={message}
              faces={faces}
              onOpen={() => jump(message.id)}
              action={
                <button className="icon-btn" aria-label={t('unpin')} data-tip={t('unpin')} data-tip-align="end" onClick={() => space.pin(message.id, false)}>
                  <Icon name="close" size={16} />
                </button>
              }
            />
          ))}
        </div>
      )}

      <div className="messages" ref={list} onScroll={onScroll} hidden={!showList}>
        {chat.loadingOlder && <div className="loading-line muted small">{t('loadingOlder')}</div>}
        {chat.messages.length === 0 && (
          <div className="empty-state">
            <span className="empty-icon">
              <Icon name="chat" size={30} />
            </span>
            <strong>{t('chatEmptyTitle')}</strong>
            <p className="muted">{t('chatEmpty')}</p>
          </div>
        )}
        {chat.messages.map((message, i) => {
          const before: ChatMessage | undefined = chat.messages[i - 1]
          const newDay = !before || dayKey(before.at) !== dayKey(message.at)
          const grouped = !newDay && !message.replyTo && before.from === message.from && message.at - before.at < GROUP_MS
          return (
            <Fragment key={message.id}>
              {newDay && (
                <div className="day muted small">
                  <span>{dayLabel(message.at)}</span>
                </div>
              )}
              <Message
                message={message}
                self={self}
                face={faces[message.from]}
                grouped={grouped}
                flash={flash === message.id}
                editing={editing === message.id}
                space={space}
                onReply={startReply}
                onEdit={setEditing}
                onJump={jump}
                onView={setViewer}
                onPdf={setPdf}
                onLoad={settle}
              />
            </Fragment>
          )
        })}
        {chat.loadingNewer && <div className="loading-line muted small">{t('loadingOlder')}</div>}
      </div>

      {showList && chat.newer && (
        <button className="to-latest small" onClick={toLatest}>
          {t('backToLatest')}
          <Icon name="arrowDown" size={14} />
        </button>
      )}

      {!chat.available && <div className="notice">{t('chatOffline')}</div>}
      {chat.uploads.map((upload) => (
        <div key={upload.id} className={upload.failed ? 'upload failed' : 'upload'}>
          <span className="small">{upload.failed ? `${t('uploadFailed')} — ${upload.name}` : upload.name}</span>
          {upload.failed ? (
            <button className="icon-btn" aria-label={t('close')} onClick={() => space.dismissUpload(upload.id)}>
              <Icon name="close" size={16} />
            </button>
          ) : (
            <div className="meter">
              <div style={{ transform: `scaleX(${upload.progress.toFixed(3)})` }} />
            </div>
          )}
        </div>
      ))}

      <form className="composer" onSubmit={submit}>
        {replyTo && (
          <div className="reply-bar small">
            <Icon name="reply" size={14} />
            <span>
              {t('replyingTo')} <strong className={`name-${hue(replyTo.from)}`}>{replyTo.from}</strong>
            </span>
            <span className="muted reply-text">{replyTo.text || fileSummary(replyTo.files.length)}</span>
            <button type="button" className="icon-btn" aria-label={t('cancel')} onClick={() => setReplyTo(null)}>
              <Icon name="close" size={14} />
            </button>
          </div>
        )}
        {files.length > 0 && (
          <div className="attachments">
            {files.map((file, i) => (
              <PendingFile key={`${file.name}-${file.size}-${i}`} file={file} onRemove={() => setFiles((current) => current.filter((_, at) => at !== i))} />
            ))}
          </div>
        )}
        <div className="composer-box">
          <button type="button" className="icon-btn" aria-label={t('attach')} data-tip={t('attach')} data-tip-align="start" onClick={() => picker.current?.click()}>
            <Icon name="plus" />
          </button>
          <textarea
            ref={input}
            rows={1}
            value={text}
            maxLength={MAX_TEXT_LENGTH}
            placeholder={files.length ? t('attachHint') : t('chatPlaceholder')}
            aria-label={t('chatPlaceholder')}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
          />
          <button
            className="icon-btn send"
            type="submit"
            aria-label={t('send')}
            data-tip={t('send')}
            data-tip-align="end"
            disabled={!chat.available || (!text.trim() && !files.length)}
          >
            <Icon name="send" />
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
      {pdf && (
        <PdfViewer
          file={pdf}
          url={space.mediaUrl(pdf.id, true)}
          onSave={() => window.duo.download(space.mediaUrl(pdf.id, true))}
          onClose={() => setPdf(null)}
        />
      )}
    </section>
  )
}

interface MessageProps {
  message: ChatMessage
  self: string
  face: number | undefined
  grouped: boolean
  flash: boolean
  editing: boolean
  space: Space
  onReply: (message: ChatMessage) => void
  onEdit: (id: string | null) => void
  onJump: (id: string) => void
  onView: (file: FileRef) => void
  onPdf: (file: FileRef) => void
  onLoad: () => void
}

/** One message, with the actions that show on hover. */
function Message(props: MessageProps) {
  const { message, self, space } = props
  const mine = message.from === self
  const [confirming, setConfirming] = useState(false)
  const [emojiOpen, setEmojiOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const reactions = Object.entries(message.reactions ?? {})
  const links = message.text ? linksOf(message.text) : []

  const copy = (): void => {
    void navigator.clipboard.writeText(message.text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    })
  }

  const classes = ['msg']
  if (props.grouped) classes.push('grouped')
  if (mine) classes.push('mine')
  if (props.flash) classes.push('flash')
  if (emojiOpen || confirming) classes.push('active')
  if (message.pinned) classes.push('is-pinned')

  return (
    <div className={classes.join(' ')} data-id={message.id}>
      {!mine && <div className="msg-gutter">{!props.grouped && <Avatar name={message.from} pick={props.face} />}</div>}
      <div className="msg-content">
        {message.replyTo && (
          <button className="msg-quote small" onClick={() => props.onJump(message.replyTo!.id)}>
            <Icon name="reply" size={13} />
            <strong className={`name-${hue(message.replyTo.from)}`}>{message.replyTo.from}</strong>
            <span className="muted">{message.replyTo.text || fileSummary(message.replyTo.files)}</span>
          </button>
        )}
        {!props.grouped && (
          <div className="msg-head">
            {!mine && <strong className={`name-${hue(message.from)}`}>{message.from}</strong>}
            <span className="muted small" title={new Date(message.at).toLocaleString()}>
              {timeLabel(message.at)}
            </span>
            {message.pinned && (
              <span className="muted small pinned-tag" title={t('pinnedBy', { name: message.pinned.by })}>
                <Icon name="pin" size={12} />
              </span>
            )}
          </div>
        )}
        {props.editing ? (
          <EditBox
            initial={message.text}
            onSave={(text) => {
              if (text.trim() !== message.text) space.editMessage(message.id, text)
              props.onEdit(null)
            }}
            onCancel={() => props.onEdit(null)}
          />
        ) : (
          message.text && (
            <p>
              {linkify(message.text)}
              {message.editedAt && (
                <span className="edited" title={new Date(message.editedAt).toLocaleString()}>
                  {' '}
                  {t('edited')}
                </span>
              )}
            </p>
          )
        )}
        {message.files.map((file) => (
          <Attachment key={file.id} file={file} space={space} onOpen={props.onView} onPdf={props.onPdf} onLoad={props.onLoad} />
        ))}
        {links.map((url) => (
          <LinkCard key={url} url={url} onLoad={props.onLoad} />
        ))}
        {reactions.length > 0 && (
          <div className="reactions">
            {reactions.map(([emoji, people]) => (
              <button
                key={emoji}
                className={people.includes(self) ? 'reaction mine' : 'reaction'}
                aria-pressed={people.includes(self)}
                data-tip={people.join(', ')}
                onClick={() => space.react(message.id, emoji)}
              >
                <span className="emoji">{emoji}</span>
                {people.length}
              </button>
            ))}
            <button className="reaction add" aria-label={t('addReaction')} data-tip={t('addReaction')} onClick={() => setEmojiOpen(true)}>
              <Icon name="smile" size={15} />
            </button>
          </div>
        )}

        {!props.editing && (
          <div className="msg-tools" onClick={(event) => event.stopPropagation()}>
            {confirming ? (
              <button className="danger small" autoFocus onBlur={() => setConfirming(false)} onClick={() => space.deleteMessage(message.id)}>
                {t('deleteConfirm')}
              </button>
            ) : (
              <>
                {QUICK_REACTIONS.map((emoji) => (
                  <button key={emoji} className="tool emoji" aria-label={emoji} onClick={() => space.react(message.id, emoji)}>
                    {emoji}
                  </button>
                ))}
                <Tool icon="smile" label={t('addReaction')} onClick={() => setEmojiOpen((open) => !open)} />
                <Tool icon="reply" label={t('reply')} onClick={() => props.onReply(message)} />
                <Tool icon="pin" label={message.pinned ? t('unpin') : t('pin')} on={Boolean(message.pinned)} onClick={() => space.pin(message.id, !message.pinned)} />
                {message.text && <Tool icon={copied ? 'check' : 'copy'} label={copied ? t('copied') : t('copyText')} onClick={copy} />}
                {mine && message.text && <Tool icon="edit" label={t('edit')} onClick={() => props.onEdit(message.id)} />}
                {mine && (
                  <Tool
                    icon="trash"
                    label={t('delete')}
                    danger
                    onClick={(event) => (event.shiftKey ? space.deleteMessage(message.id) : setConfirming(true))}
                  />
                )}
              </>
            )}
            {emojiOpen && (
              <EmojiPicker
                onPick={(emoji) => {
                  space.react(message.id, emoji)
                  setEmojiOpen(false)
                }}
                onClose={() => setEmojiOpen(false)}
              />
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function Tool(props: {
  icon: Parameters<typeof Icon>[0]['name']
  label: string
  on?: boolean
  danger?: boolean
  onClick: (event: MouseEvent) => void
}) {
  const classes = ['tool']
  if (props.on) classes.push('on')
  if (props.danger) classes.push('danger-tool')
  return (
    <button className={classes.join(' ')} aria-label={props.label} data-tip={props.label} data-tip-pos="top" onClick={props.onClick}>
      <Icon name={props.icon} size={17} />
    </button>
  )
}

function EmojiPicker({ onPick, onClose }: { onPick: (emoji: string) => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const [up, setUp] = useState(false)
  // Opens upwards when the conversation has no room left below the message.
  useLayoutEffect(() => {
    const el = ref.current
    const box = el?.closest('.messages')?.getBoundingClientRect()
    if (el && box && el.getBoundingClientRect().bottom > box.bottom - 8) setUp(true)
  }, [])
  useEffect(() => {
    const away = (event: globalThis.MouseEvent): void => {
      if (!ref.current?.contains(event.target as Node)) onClose()
    }
    const onKey = (event: globalThis.KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    // Opened by a click: listen from the next one on.
    const timer = setTimeout(() => window.addEventListener('mousedown', away))
    window.addEventListener('keydown', onKey)
    return () => {
      clearTimeout(timer)
      window.removeEventListener('mousedown', away)
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])
  return (
    <div className={up ? 'emoji-picker up' : 'emoji-picker'} ref={ref} role="dialog" aria-label={t('addReaction')}>
      {EMOJI_GROUPS.map((group) => (
        <Fragment key={group.label}>
          <span className="muted small">{t(group.label)}</span>
          <div className="emoji-grid">
            {group.emoji.map((emoji) => (
              <button key={emoji} onClick={() => onPick(emoji)} aria-label={emoji}>
                {emoji}
              </button>
            ))}
          </div>
        </Fragment>
      ))}
    </div>
  )
}

function EditBox({ initial, onSave, onCancel }: { initial: string; onSave: (text: string) => void; onCancel: () => void }) {
  const [value, setValue] = useState(initial)
  const ref = useRef<HTMLTextAreaElement>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`
  }, [value])
  useEffect(() => {
    const el = ref.current
    el?.focus()
    el?.setSelectionRange(el.value.length, el.value.length)
    el?.parentElement?.scrollIntoView({ block: 'nearest' })
  }, [])
  return (
    <div className="edit-box">
      <textarea
        ref={ref}
        value={value}
        maxLength={MAX_TEXT_LENGTH}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') onCancel()
          else if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault()
            onSave(value)
          }
        }}
      />
      <span className="muted small">{t('editHint')}</span>
    </div>
  )
}

/** A file chosen for the next message, shown before it is sent: a photo as itself, anything else by its type. */
function PendingFile({ file, onRemove }: { file: File; onRemove: () => void }) {
  const [preview, setPreview] = useState<string | null>(null)
  useEffect(() => {
    if (!file.type.startsWith('image/')) return
    const url = URL.createObjectURL(file)
    setPreview(url)
    return () => URL.revokeObjectURL(url)
  }, [file])
  const extension = /\.([a-z0-9]{1,5})$/i.exec(file.name)?.[1]
  return (
    <div className="pending-file">
      {preview ? (
        <img src={preview} alt="" />
      ) : (
        <span className="file-badge">{extension ? extension.toUpperCase() : <Icon name="file" size={22} />}</span>
      )}
      <span className="pending-name small">
        <strong>{file.name}</strong>
        <span className="muted">{formatSize(file.size)}</span>
      </span>
      <button type="button" className="icon-btn" aria-label={t('delete')} data-tip={t('delete')} onClick={onRemove}>
        <Icon name="close" size={14} />
      </button>
    </div>
  )
}

/** A message in the search results or the pinned list: click to go to it in the conversation. */
function ResultCard(props: { message: ChatMessage; faces: Record<string, number | undefined>; query?: string; onOpen: () => void; action?: ReactNode }) {
  const { message } = props
  const text = message.text || message.files.map((f) => f.name).join(', ')
  return (
    <div className="result">
      <button className="result-open" onClick={props.onOpen} aria-label={t('jumpTo')}>
        <Avatar name={message.from} pick={props.faces[message.from]} />
        <span className="result-body">
          <span className="result-head">
            <strong className={`name-${hue(message.from)}`}>{message.from}</strong>
            <span className="muted small">
              {dateLabel(message.at)} · {timeLabel(message.at)}
            </span>
          </span>
          <span className="result-text">{props.query ? highlight(text, props.query) : text}</span>
        </span>
      </button>
      {props.action}
    </div>
  )
}

function Attachment(props: { file: FileRef; space: Space; onOpen: (file: FileRef) => void; onPdf: (file: FileRef) => void; onLoad: () => void }) {
  const { file, space } = props
  const save = (): void => window.duo.download(space.mediaUrl(file.id, true))
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
  if (isVideo(file)) return <LazyVideo url={space.mediaUrl(file.id)} onLoad={props.onLoad} />
  if (isAudio(file)) return <audio src={space.mediaUrl(file.id)} controls preload="none" />
  if (isPdf(file)) {
    return (
      <PdfCard
        file={file}
        url={space.mediaUrl(file.id, true)}
        size={formatSize(file.size)}
        onOpen={() => props.onPdf(file)}
        onSave={save}
        onLoad={props.onLoad}
      />
    )
  }
  const extension = /\.([a-z0-9]{1,5})$/i.exec(file.name)?.[1]
  return (
    <button className="file" onClick={save}>
      <span className="file-badge">{extension ? extension.toUpperCase() : <Icon name="file" size={22} />}</span>
      <span>
        <strong>{file.name}</strong>
        <span className="muted small">
          {formatSize(file.size)} · {t('saveFile')}
        </span>
      </span>
      <Icon name="download" size={18} />
    </button>
  )
}
