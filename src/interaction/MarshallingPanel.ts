// ------------------------------------------------------------------
// MarshallingPanel — floating DOM panel for prepared performance content
// ------------------------------------------------------------------
//
// Holds a one-time snapshot of an OS folder's images/video/JSON files, so a
// performer running Palimpsest full-screen (which hides the OS desktop and
// any file manager) can still drag prepared content onto the canvas.
//
// Not a Node/Layer — a plain DOM overlay appended to document.body, the
// same "outside the render loop" pattern as InteractionSystem's right-click
// binding-inspector panel. Its header is its own drag handle (native
// pointer events, independent of InteractionSystem's pointer pipeline).
//
// Dragging an item out tries to attach the real File to the native browser
// drag via DataTransfer.items.add(file), so the drag fires the canvas's
// existing dragover/drop listeners (see main.ts) exactly as an OS file drag
// would. That works in Chromium, but WebKit (Safari) does not support
// injecting a JS-constructed File into a page-initiated drag this way —
// confirmed live: dataTransfer.types comes back empty on both dragover and
// dragend there, so the browser's drag data store never actually receives
// the file. As a cross-browser fallback, every drag ALSO carries a plain
// string id (MARSHALLING_DRAG_MIME) via setData/getData — ordinary
// same-page custom-type drag data, which every browser supports — that the
// canvas's drop handler uses to look the File back up via getFileForDrag()
// when dataTransfer.files came back empty. See main.ts's dragover/drop
// listeners for the matching half of this.
//
// An item is removed from the panel once its drag ends with a non-'none'
// dropEffect, i.e. the drop was actually accepted somewhere.

export const MARSHALLING_DRAG_MIME = 'application/x-palimpsest-marshalled-item'

// Natural sort (numeric: true) so a numeric planning prefix like
// "2_build.mp4" sorts before "10_outro.mp4" — a plain string sort would put
// "10_" before "2_" since '1' < '2' character-by-character.
const FILENAME_ORDER = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

type ItemKind = 'image' | 'video' | 'json'

interface PanelItem {
  file:      File
  dragId:    string
  el:        HTMLDivElement
  objectUrl: string | null
}

const PANEL_WIDTH   = 44
const THUMB_SIZE     = 28
const ITEM_GAP       = 4
const VISIBLE_ITEMS  = 4
const MARGIN         = 16

let _nextDragId = 1

// Scrollbar styling needs real CSS (pseudo-elements aren't reachable via
// inline styles) — injected once, globally, the first time a panel is
// constructed. Kept invisible (transparent thumb/track) until the pointer
// is over the panel, so scrolling past VISIBLE_ITEMS is possible without
// a permanently visible scrollbar strip.
const ROOT_CLASS = 'palimpsest-marshalling-root'
const BODY_CLASS = 'palimpsest-marshalling-body'
const STYLE_ID   = 'palimpsest-marshalling-style'

function ensureScrollbarStyle(): void {
  if (document.getElementById(STYLE_ID)) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = `
    .${BODY_CLASS} { scrollbar-width: thin; scrollbar-color: transparent transparent; }
    .${ROOT_CLASS}:hover .${BODY_CLASS} { scrollbar-color: rgba(255,255,255,0.35) transparent; }
    .${BODY_CLASS}::-webkit-scrollbar { width: 3px; }
    .${BODY_CLASS}::-webkit-scrollbar-track { background: transparent; }
    .${BODY_CLASS}::-webkit-scrollbar-thumb { background: transparent; border-radius: 3px; }
    .${ROOT_CLASS}:hover .${BODY_CLASS}::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.35); }
  `
  document.head.appendChild(style)
}

export class MarshallingPanel {
  private readonly _root:   HTMLDivElement
  private readonly _header: HTMLDivElement
  private readonly _body:   HTMLDivElement

  private _items: PanelItem[] = []

  private _dragging     = false
  private _dragStartX   = 0
  private _dragStartY   = 0
  private _panelStartX  = 0
  private _panelStartY  = 0

  constructor() {
    ensureScrollbarStyle()

    this._root = document.createElement('div')
    this._root.className = ROOT_CLASS
    {
      const s = this._root.style
      s.position      = 'fixed'
      s.zIndex        = '800'
      s.width         = `${PANEL_WIDTH}px`
      s.maxHeight     = '70vh'
      s.background    = 'rgba(20,20,24,0.92)'
      s.border        = '0.5px solid rgba(255,255,255,0.15)'
      s.borderRadius  = '8px'
      s.boxShadow     = '0 4px 18px rgba(0,0,0,0.5)'
      s.opacity       = '0.5'
      s.display       = 'none'
      s.flexDirection = 'column'
      s.fontFamily    = 'monospace'
      s.fontSize      = '11px'
      s.color         = 'rgba(255,255,255,0.85)'
      s.overflow      = 'hidden'
    }

    // No folder-name heading — the folder name is still available as a
    // native hover tooltip (see load()) rather than a permanently visible
    // label, so the panel stays as unobtrusive as possible on stage. The
    // header strip remains only as the drag handle + close button.
    this._header = document.createElement('div')
    {
      const s = this._header.style
      s.display        = 'flex'
      s.alignItems     = 'center'
      s.justifyContent = 'flex-end'
      s.padding        = '3px 5px'
      s.background     = 'rgba(255,255,255,0.07)'
      s.cursor         = 'grab'
      s.userSelect     = 'none'
    }

    const closeBtn = document.createElement('span')
    closeBtn.textContent = '×'
    {
      const s = closeBtn.style
      s.cursor     = 'pointer'
      s.padding    = '0 4px'
      s.fontSize   = '14px'
      s.lineHeight = '14px'
    }
    // Stop the close click from also being seen by the header's own
    // pointerdown (drag-start) listener below.
    closeBtn.addEventListener('pointerdown', (e) => e.stopPropagation())
    closeBtn.addEventListener('click', (e) => { e.stopPropagation(); this.close() })
    this._header.appendChild(closeBtn)

    this._header.addEventListener('pointerdown', (e) => this._startDrag(e))

    this._body = document.createElement('div')
    this._body.className = BODY_CLASS
    {
      const s = this._body.style
      s.display       = 'flex'
      s.flexDirection = 'column'
      s.alignItems    = 'center'
      s.gap           = `${ITEM_GAP}px`
      s.padding       = '6px'
      s.overflowY     = 'auto'
      // Cap visible content to VISIBLE_ITEMS rows (content-box sizing, so
      // this excludes the padding above); anything beyond that scrolls, via
      // the hover-only scrollbar styled in ensureScrollbarStyle.
      s.maxHeight = `${VISIBLE_ITEMS * THUMB_SIZE + (VISIBLE_ITEMS - 1) * ITEM_GAP}px`
    }

    this._root.appendChild(this._header)
    this._root.appendChild(this._body)
    document.body.appendChild(this._root)
  }

  // ----------------------------------------------------------
  // Public API
  // ----------------------------------------------------------

  // Replaces any current contents with `files` (already the full recursive
  // listing of a picked folder) and shows the panel. Non-image/video/json
  // entries (and dotfiles) are silently skipped.
  load(folderName: string, files: File[]): void {
    this._clear()
    // No visible heading (see constructor) — the folder name is still
    // available as a native hover tooltip on the panel itself.
    this._root.title = folderName

    const sorted = [...files].sort((a, b) => FILENAME_ORDER.compare(a.name, b.name))
    for (const file of sorted) {
      const kind = this._kindOf(file)
      if (kind === null) continue
      const item = this._buildItem(file, kind)
      this._items.push(item)
      this._body.appendChild(item.el)
    }

    // Default position: unobtrusive bottom-right corner, clear of the
    // left-pinned LayerStackWidget strip. The user can drag it elsewhere.
    const s = this._root.style
    s.left   = ''
    s.top    = ''
    s.right  = `${MARGIN}px`
    s.bottom = `${MARGIN}px`
    s.display = 'flex'
  }

  close(): void {
    this._clear()
    this._root.style.display = 'none'
  }

  // ----------------------------------------------------------
  // Item construction
  // ----------------------------------------------------------

  private _kindOf(file: File): ItemKind | null {
    if (file.name.startsWith('.')) return null
    if (file.type.startsWith('image/')) return 'image'
    if (file.type.startsWith('video/')) return 'video'
    if (file.type === 'application/json' || file.name.toLowerCase().endsWith('.json')) return 'json'
    return null
  }

  // First two characters of the filename, uppercased — raw, not
  // letters-only, so a deliberate numbering scheme (e.g. "1_intro.mp4",
  // "2_build.mp4") stays visible as "1_"/"2_" rather than being collapsed
  // away.
  private _monogramOf(name: string): string {
    return name.slice(0, 2).toUpperCase()
  }

  // Square icon: the thumbnail fills the whole item, with a 2-letter
  // monogram overlaid and centred on top of it (rather than a filename
  // beside it) — see _monogramOf for the contrast treatment. The full
  // filename is still available as a native hover tooltip.
  private _buildItem(file: File, kind: ItemKind): PanelItem {
    const el = document.createElement('div')
    el.draggable = true
    el.title = file.name
    {
      const s = el.style
      s.width          = `${THUMB_SIZE}px`
      s.height         = `${THUMB_SIZE}px`
      // Flex children shrink to fit their container by default, which would
      // otherwise squash every item to fit within _body's capped max-height
      // instead of actually overflowing it — flex-shrink:0 is what makes
      // the VISIBLE_ITEMS cap produce a scrollable list rather than a
      // squeezed one.
      s.flexShrink     = '0'
      s.position       = 'relative'
      s.borderRadius   = '3px'
      s.overflow       = 'hidden'
      s.background     = 'rgba(255,255,255,0.05)'
      s.cursor         = 'grab'
      s.display        = 'flex'
      s.alignItems     = 'center'
      s.justifyContent = 'center'
    }

    const item: PanelItem = { file, dragId: String(_nextDragId++), el, objectUrl: null }

    if (kind === 'image') {
      const url = URL.createObjectURL(file)
      item.objectUrl = url
      const img = document.createElement('img')
      img.src = url
      img.draggable = false
      img.style.width    = '100%'
      img.style.height   = '100%'
      img.style.objectFit = 'cover'
      el.appendChild(img)
    } else if (kind === 'video') {
      const url = URL.createObjectURL(file)
      item.objectUrl = url
      const video = document.createElement('video')
      video.src     = url
      video.muted   = true
      video.preload = 'metadata'
      video.draggable = false
      video.style.width    = '100%'
      video.style.height   = '100%'
      video.style.objectFit = 'cover'
      // Seeking to a small offset (rather than leaving currentTime at 0)
      // reliably yields a decoded, visible frame as the "poster" across
      // browsers, without a separate canvas-capture step.
      video.addEventListener('loadedmetadata', () => {
        video.currentTime = Math.min(0.1, video.duration / 2 || 0)
      })
      el.appendChild(video)
    } else {
      const glyph = document.createElement('div')
      glyph.textContent = '{ }'
      glyph.style.fontSize = '11px'
      glyph.style.opacity  = '0.6'
      el.appendChild(glyph)
    }

    const mono = document.createElement('div')
    mono.textContent = this._monogramOf(file.name)
    {
      const s = mono.style
      s.position       = 'absolute'
      s.inset          = '0'
      s.display        = 'flex'
      s.alignItems     = 'center'
      s.justifyContent = 'center'
      s.pointerEvents  = 'none'
      s.userSelect     = 'none'
      s.fontWeight     = 'bold'
      s.fontSize       = '12px'
      s.letterSpacing  = '0.5px'
      s.color          = '#fff'
      // Four-directional outline via text-shadow, not -webkit-text-stroke —
      // plain CSS, so it renders identically everywhere rather than relying
      // on a still-nonstandard property. This is what makes the monogram
      // read reliably regardless of the thumbnail's own colour/brightness:
      // the black outline holds up against a light image, the white fill
      // holds up against a dark one.
      s.textShadow =
        '-1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000, 1px 1px 0 #000, 0 1px 3px rgba(0,0,0,0.8)'
    }
    el.appendChild(mono)

    // Try attaching the real File to the native drag (works in Chromium) —
    // and unconditionally also set the string-id fallback (works everywhere,
    // see the file header comment), since main.ts's drop handler only needs
    // one of the two to succeed.
    el.addEventListener('dragstart', (e) => {
      if (!e.dataTransfer) return
      e.dataTransfer.effectAllowed = 'copy'
      try {
        e.dataTransfer.items.add(file)
      } catch {
        // Expected in WebKit — see the file header comment. The setData
        // fallback below covers it.
      }
      e.dataTransfer.setData(MARSHALLING_DRAG_MIME, item.dragId)
    })
    el.addEventListener('dragend', (e) => {
      if (e.dataTransfer?.dropEffect !== 'none') this._removeItem(item)
    })

    return item
  }

  // Fallback lookup for browsers (Safari) that don't deliver a real File via
  // dataTransfer.files for a page-initiated drag — see the file header
  // comment. Non-destructive: the panel still only removes an item via the
  // dragend/dropEffect check above, so removal behaves identically
  // regardless of which channel actually delivered the file.
  getFileForDrag(dragId: string): File | null {
    return this._items.find(i => i.dragId === dragId)?.file ?? null
  }

  private _removeItem(item: PanelItem): void {
    const idx = this._items.indexOf(item)
    if (idx < 0) return
    this._items.splice(idx, 1)
    item.el.remove()
    if (item.objectUrl !== null) URL.revokeObjectURL(item.objectUrl)
  }

  private _clear(): void {
    for (const item of this._items) {
      if (item.objectUrl !== null) URL.revokeObjectURL(item.objectUrl)
    }
    this._items = []
    this._body.replaceChildren()
  }

  // ----------------------------------------------------------
  // Header drag-to-reposition — plain DOM pointer events, independent of
  // InteractionSystem (same reasoning as the binding-inspector panel: this
  // is outside the canvas/render loop entirely).
  // ----------------------------------------------------------

  private _startDrag(e: PointerEvent): void {
    if (e.button !== 0) return
    e.preventDefault()
    this._dragging = true

    const rect = this._root.getBoundingClientRect()
    this._panelStartX = rect.left
    this._panelStartY = rect.top
    this._dragStartX  = e.clientX
    this._dragStartY  = e.clientY

    // Switch from the default right/bottom anchoring to left/top so the
    // drag can freely reposition the panel.
    const s = this._root.style
    s.left   = `${rect.left}px`
    s.top    = `${rect.top}px`
    s.right  = ''
    s.bottom = ''

    this._header.style.cursor = 'grabbing'
    window.addEventListener('pointermove', this._onDragMove)
    window.addEventListener('pointerup', this._onDragEnd)
  }

  private readonly _onDragMove = (e: PointerEvent): void => {
    if (!this._dragging) return
    const dx = e.clientX - this._dragStartX
    const dy = e.clientY - this._dragStartY
    const rect = this._root.getBoundingClientRect()
    const x = Math.min(Math.max(0, this._panelStartX + dx), window.innerWidth - rect.width)
    const y = Math.min(Math.max(0, this._panelStartY + dy), window.innerHeight - rect.height)
    this._root.style.left = `${x}px`
    this._root.style.top  = `${y}px`
  }

  private readonly _onDragEnd = (): void => {
    this._dragging = false
    this._header.style.cursor = 'grab'
    window.removeEventListener('pointermove', this._onDragMove)
    window.removeEventListener('pointerup', this._onDragEnd)
  }
}
