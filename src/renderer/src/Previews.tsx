/**
 * Previews in the chat that cost something to load — a web page's card, the first page of a PDF,
 * a video — are only fetched once their message scrolls near the screen.
 */
import { useEffect, useRef, useState, type RefObject } from 'react'
import type { FileRef } from '../../shared/protocol'
import type { LinkPreview } from '../../preload/index'
import { t } from './i18n'
import { Icon } from './icons'

/** True once the element has come within a screen of the visible part of the conversation. */
export function useInView(ref: RefObject<Element | null>, margin = '300px'): boolean {
  const [seen, setSeen] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!el || seen) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setSeen(true)
          observer.disconnect()
        }
      },
      { rootMargin: margin }
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [ref, margin, seen])
  return seen
}

// ----- Web links -----

const previews = new Map<string, Promise<LinkPreview | null>>()

function fetchPreview(url: string): Promise<LinkPreview | null> {
  let entry = previews.get(url)
  if (!entry) {
    entry = Promise.resolve(window.duo.linkPreview?.(url))
      .then((preview) => (preview && typeof preview === 'object' && 'title' in preview ? preview : null))
      .catch(() => null)
    previews.set(url, entry)
  }
  return entry
}

export function LinkCard({ url, onLoad }: { url: string; onLoad: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const visible = useInView(ref)
  const [preview, setPreview] = useState<LinkPreview | null>(null)

  useEffect(() => {
    if (!visible) return
    let live = true
    void fetchPreview(url).then((result) => {
      if (live && result) setPreview(result)
    })
    return () => {
      live = false
    }
  }, [visible, url])
  useEffect(() => {
    if (preview) onLoad()
  }, [preview]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div ref={ref} className={preview ? 'link-card' : 'link-card pending'}>
      {preview && (
        <>
          <span className="muted small">{preview.site}</span>
          {preview.title && (
            <a href={url} target="_blank" rel="noreferrer" className="link-title">
              {preview.title}
            </a>
          )}
          {preview.description && <span className="link-text small">{preview.description}</span>}
          {preview.image && (
            <a href={url} target="_blank" rel="noreferrer" className="link-image">
              <img src={preview.image} alt="" onLoad={onLoad} />
            </a>
          )}
        </>
      )}
    </div>
  )
}

// ----- PDF -----

/** PDFs heavier than this are offered as plain files: their first page would cost too much. */
const PDF_PREVIEW_BYTES = 40 * 1024 * 1024

export const isPdf = (file: FileRef): boolean => file.mime === 'application/pdf' || /\.pdf$/i.test(file.name)

type PdfDocument = import('pdfjs-dist').PDFDocumentProxy
const documents = new Map<string, Promise<PdfDocument>>()

async function loadPdf(url: string): Promise<PdfDocument> {
  let entry = documents.get(url)
  if (!entry) {
    entry = (async () => {
      // pdf.js is only loaded the first time a PDF comes into view.
      const pdfjs = await import('pdfjs-dist')
      const worker = await import('pdfjs-dist/build/pdf.worker.min.mjs?url')
      pdfjs.GlobalWorkerOptions.workerSrc = worker.default
      const response = await fetch(url)
      if (!response.ok) throw new Error(`PDF unavailable (${response.status})`)
      const data = new Uint8Array(await response.arrayBuffer())
      return pdfjs.getDocument({ data, isEvalSupported: false }).promise
    })()
    entry.catch(() => documents.delete(url))
    documents.set(url, entry)
  }
  return entry
}

async function drawPage(doc: PdfDocument, number: number, canvas: HTMLCanvasElement, width: number): Promise<void> {
  const page = await doc.getPage(number)
  const base = page.getViewport({ scale: 1 })
  const ratio = window.devicePixelRatio || 1
  const viewport = page.getViewport({ scale: (width / base.width) * ratio })
  canvas.width = Math.floor(viewport.width)
  canvas.height = Math.floor(viewport.height)
  canvas.style.aspectRatio = `${viewport.width} / ${viewport.height}`
  await page.render({ canvas, viewport }).promise
}

export function PdfCard(props: { file: FileRef; url: string; size: string; onOpen: () => void; onSave: () => void; onLoad: () => void }) {
  const { file } = props
  const ref = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const visible = useInView(ref)
  const [pages, setPages] = useState<number | null>(null)
  const [failed, setFailed] = useState(file.size > PDF_PREVIEW_BYTES)

  useEffect(() => {
    if (!visible || failed) return
    let live = true
    loadPdf(props.url)
      .then(async (doc) => {
        if (!live || !canvas.current) return
        await drawPage(doc, 1, canvas.current, 320)
        if (live) {
          setPages(doc.numPages)
          props.onLoad()
        }
      })
      .catch(() => live && setFailed(true))
    return () => {
      live = false
    }
  }, [visible, failed, props.url]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div ref={ref} className="pdf-card">
      {!failed && (
        <button className={pages ? 'pdf-page' : 'pdf-page loading'} onClick={props.onOpen} aria-label={t('openFile')}>
          <canvas ref={canvas} />
        </button>
      )}
      <div className="pdf-meta">
        <Icon name="file" size={22} />
        <span>
          <strong>{file.name}</strong>
          <span className="muted small">
            PDF · {props.size}
            {pages ? ` · ${t(pages > 1 ? 'pdfPages' : 'pdfPage', { count: String(pages) })}` : ''}
          </span>
        </span>
        <button className="icon-btn" onClick={props.onSave} aria-label={t('saveFile')} data-tip={t('saveFile')} data-tip-align="end">
          <Icon name="download" size={18} />
        </button>
      </div>
    </div>
  )
}

/** The whole PDF, page after page, each drawn as it scrolls into view. */
export function PdfViewer(props: { file: FileRef; url: string; onSave: () => void; onClose: () => void }) {
  const [doc, setDoc] = useState<PdfDocument | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let live = true
    loadPdf(props.url).then(
      (loaded) => live && setDoc(loaded),
      () => live && setFailed(true)
    )
    return () => {
      live = false
    }
  }, [props.url])
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') props.onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="overlay pdf-viewer" onClick={props.onClose}>
      <div className="pdf-bar" onClick={(event) => event.stopPropagation()}>
        <strong>{props.file.name}</strong>
        <button onClick={props.onSave}>{t('saveFile')}</button>
        <button className="icon-btn" onClick={props.onClose} aria-label={t('close')}>
          <Icon name="close" />
        </button>
      </div>
      <div className="pdf-pages">
        {failed && <p className="muted">{t('pdfFailed')}</p>}
        {doc && Array.from({ length: doc.numPages }, (_, i) => <PdfPage key={i} doc={doc} number={i + 1} />)}
      </div>
    </div>
  )
}

function PdfPage({ doc, number }: { doc: PdfDocument; number: number }) {
  const ref = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const visible = useInView(ref, '800px')
  useEffect(() => {
    if (visible && canvas.current) void drawPage(doc, number, canvas.current, Math.min(860, window.innerWidth - 64))
  }, [visible, doc, number])
  return (
    <div ref={ref} className="pdf-sheet" onClick={(event) => event.stopPropagation()}>
      <canvas ref={canvas} />
    </div>
  )
}

// ----- Video -----

/** A video only starts loading once its message is near the screen. */
export function LazyVideo({ url, onLoad }: { url: string; onLoad: () => void }) {
  const ref = useRef<HTMLVideoElement>(null)
  const visible = useInView(ref)
  return <video ref={ref} className="photo" src={visible ? url : undefined} controls preload="metadata" onLoadedMetadata={onLoad} />
}
