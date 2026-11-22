import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { MAX_NOTE_LENGTH, MAX_TITLE_LENGTH, NOTE_COLORS, type NoteDraft } from '../../shared/protocol'
import { t } from './i18n'
import type { Space } from './space'

/** How long after the last keystroke a note is sent to the host. */
const SAVE_DELAY_MS = 500

const blank = (): NoteDraft => ({ id: crypto.randomUUID(), title: '', text: '', color: 0, pinned: false })

export function Notes({ space, self }: { space: Space; self: string }) {
  const { notes, available } = useSyncExternalStore(space.subscribe, space.getSnapshot)
  /** The note being edited: one from the list, or a new one not saved yet. */
  const [editing, setEditing] = useState<NoteDraft | null>(null)

  return (
    <section className="notes">
      <button className="primary" disabled={!available} onClick={() => setEditing(blank())}>
        {t('newNote')}
      </button>
      {notes.length === 0 && <p className="muted small">{t('notesEmpty')}</p>}
      <div className="note-grid">
        {notes.map((note) => (
          <button key={note.id} className={`note color-${note.color}`} onClick={() => setEditing(note)}>
            {note.pinned && <span className="pin small">{t('pinned')}</span>}
            {note.title && <strong>{note.title}</strong>}
            {note.text && <span className="note-text">{note.text}</span>}
          </button>
        ))}
      </div>
      {editing && (
        <NoteEditor
          key={editing.id}
          initial={editing}
          space={space}
          self={self}
          onClose={() => setEditing(null)}
        />
      )}
    </section>
  )
}

function NoteEditor(props: { initial: NoteDraft; space: Space; self: string; onClose: () => void }) {
  const { space, self } = props
  const snapshot = useSyncExternalStore(space.subscribe, space.getSnapshot)
  const stored = snapshot.notes.find((note) => note.id === props.initial.id)
  const [draft, setDraft] = useState<NoteDraft>(props.initial)
  const [confirming, setConfirming] = useState(false)
  /** Latest draft and whether it still has to be sent, readable from timers and on close. */
  const latest = useRef({ draft: props.initial, dirty: false })
  const timer = useRef<number | null>(null)

  const flush = (): void => {
    if (timer.current !== null) window.clearTimeout(timer.current)
    timer.current = null
    if (!latest.current.dirty) return
    latest.current.dirty = false
    space.saveNote(latest.current.draft, self)
  }

  const change = (patch: Partial<NoteDraft>): void => {
    const next = { ...latest.current.draft, ...patch }
    latest.current = { draft: next, dirty: true }
    setDraft(next)
    if (timer.current !== null) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(flush, SAVE_DELAY_MS)
  }

  // The other person edited this note: show their version, unless we are in the middle of typing.
  useEffect(() => {
    if (!stored || latest.current.dirty) return
    const { id, title, text, color, pinned } = stored
    latest.current.draft = { id, title, text, color, pinned }
    setDraft(latest.current.draft)
  }, [stored?.updatedAt]) // eslint-disable-line react-hooks/exhaustive-deps

  const close = (): void => {
    flush()
    props.onClose()
  }

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') close()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      flush()
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="overlay" onClick={close}>
      <div className={`dialog note-editor color-${draft.color}`} role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <input
          className="note-title"
          value={draft.title}
          maxLength={MAX_TITLE_LENGTH}
          placeholder={t('noteTitle')}
          aria-label={t('noteTitle')}
          onChange={(event) => change({ title: event.target.value })}
        />
        <textarea
          autoFocus
          value={draft.text}
          maxLength={MAX_NOTE_LENGTH}
          placeholder={t('noteText')}
          aria-label={t('noteText')}
          onChange={(event) => change({ text: event.target.value })}
        />
        <div className="row colors">
          {Array.from({ length: NOTE_COLORS }, (_, color) => (
            <button
              key={color}
              className={`dot color-${color}`}
              aria-label={`${t('noteColor')} ${color + 1}`}
              aria-pressed={draft.color === color}
              onClick={() => change({ color })}
            />
          ))}
        </div>
        {stored && (
          <span className="muted small">
            {t('noteEdited', { name: stored.updatedBy, date: new Date(stored.updatedAt).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' }) })}
          </span>
        )}
        <div className="row">
          <button className={draft.pinned ? 'toggle on-accent' : 'toggle'} aria-pressed={draft.pinned} onClick={() => change({ pinned: !draft.pinned })}>
            {draft.pinned ? t('unpin') : t('pin')}
          </button>
          {stored &&
            (confirming ? (
              <button
                className="danger"
                autoFocus
                onBlur={() => setConfirming(false)}
                onClick={() => {
                  latest.current.dirty = false
                  space.deleteNote(draft.id)
                  props.onClose()
                }}
              >
                {t('deleteConfirm')}
              </button>
            ) : (
              <button className="ghost" onClick={() => setConfirming(true)}>
                {t('delete')}
              </button>
            ))}
          <button className="primary push" onClick={close}>
            {t('close')}
          </button>
        </div>
      </div>
    </div>
  )
}
