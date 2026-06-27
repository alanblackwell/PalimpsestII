// Full-screen HTML overlay for browsing, loading, renaming, and deleting
// IndexedDB-backed saves on mobile. Not used on desktop.

import { listSaves, deleteSave, renameSave, type MobileSave } from '../persistence/MobileStore.js'

export interface GalleryCallbacks {
  onLoad:  (session: unknown) => void
}

export function openGallery(cbs: GalleryCallbacks, highlightId?: string): void {
  // ── Root overlay ────────────────────────────────────────────
  const overlay = el('div', {
    position: 'fixed', inset: '0',
    background: 'rgba(8,8,16,0.97)',
    zIndex: '9999',
    display: 'flex', flexDirection: 'column',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    color: '#e8e8f0',
    userSelect: 'none',
  })
  document.body.appendChild(overlay)

  const close = () => overlay.remove()

  // ── Header ──────────────────────────────────────────────────
  const header = el('div', {
    display: 'flex', alignItems: 'center',
    padding: '14px 16px 12px',
    borderBottom: '1px solid rgba(255,255,255,0.10)',
    flexShrink: '0', gap: '12px',
  })
  overlay.appendChild(header)

  const titleEl = el('div', { flex: '1', fontSize: '17px', fontWeight: '600' })
  titleEl.textContent = 'Sessions'
  header.appendChild(titleEl)

  const closeBtn = textBtn('Done')
  closeBtn.addEventListener('click', close)
  header.appendChild(closeBtn)

  // ── Scrollable grid ─────────────────────────────────────────
  const grid = el('div', {
    flex: '1', overflowY: 'auto', overflowX: 'hidden',
    padding: '14px 12px',
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(148px, 1fr))',
    gap: '12px',
    alignContent: 'start',
  })
  overlay.appendChild(grid)

  // ── Load and render saves ────────────────────────────────────
  async function refresh(): Promise<void> {
    grid.innerHTML = ''
    const saves = await listSaves()
    if (saves.length === 0) {
      const empty = el('p', { color: '#666', gridColumn: '1/-1', margin: '24px 0 0', fontSize: '14px' })
      empty.textContent = 'No saved sessions yet.'
      grid.appendChild(empty)
      return
    }
    for (const save of saves) grid.appendChild(makeCard(save, save.id === highlightId))
  }

  function makeCard(save: MobileSave, highlight: boolean): HTMLElement {
    const card = el('div', {
      background: highlight ? 'rgba(126,207,126,0.10)' : 'rgba(255,255,255,0.05)',
      border: `1.5px solid ${highlight ? '#7ecf7e' : 'rgba(255,255,255,0.10)'}`,
      borderRadius: '10px', overflow: 'hidden',
      display: 'flex', flexDirection: 'column',
      cursor: 'pointer',
    })

    // Thumbnail
    const img = document.createElement('img')
    img.src = save.preview
    img.style.cssText = 'width:100%;aspect-ratio:16/9;object-fit:cover;display:block'
    img.addEventListener('click', () => { close(); cbs.onLoad(save.session) })
    card.appendChild(img)

    // Info
    const info = el('div', { padding: '8px 8px 6px', flex: '1', display: 'flex', flexDirection: 'column', gap: '3px' })
    card.appendChild(info)

    // Name row
    const nameRow = el('div', { display: 'flex', alignItems: 'flex-start', gap: '4px' })
    info.appendChild(nameRow)

    const nameEl = el('div', {
      flex: '1', fontSize: '12px', fontWeight: '500',
      lineHeight: '1.3', wordBreak: 'break-word', color: '#e8e8f0',
    })
    nameEl.textContent = save.name
    nameEl.addEventListener('click', () => { close(); cbs.onLoad(save.session) })
    nameRow.appendChild(nameEl)

    const renameBtn = iconBtn('✎')
    renameBtn.title = 'Rename'
    renameBtn.addEventListener('click', e => { e.stopPropagation(); startRename(save, nameEl) })
    nameRow.appendChild(renameBtn)

    // Date
    const dateEl = el('div', { fontSize: '10px', color: '#666' })
    dateEl.textContent = fmtDate(save.savedAt)
    dateEl.addEventListener('click', () => { close(); cbs.onLoad(save.session) })
    info.appendChild(dateEl)

    // Delete
    const footer = el('div', { display: 'flex', justifyContent: 'flex-end', marginTop: '4px' })
    info.appendChild(footer)
    const delBtn = iconBtn('✕')
    delBtn.title = 'Delete'
    delBtn.style.color = '#c06060'
    delBtn.addEventListener('click', async e => {
      e.stopPropagation()
      if (!confirm(`Delete "${save.name}"?`)) return
      await deleteSave(save.id)
      await refresh()
    })
    footer.appendChild(delBtn)

    return card
  }

  function startRename(save: MobileSave, nameEl: HTMLElement): void {
    const input = document.createElement('input')
    input.value = save.name
    input.style.cssText = [
      'flex:1', 'font-size:12px', 'font-weight:500', 'width:100%',
      'box-sizing:border-box', 'padding:2px 4px', 'border-radius:4px',
      'border:1px solid #7ecf7e', 'background:rgba(255,255,255,0.08)',
      'color:#e8e8f0', 'outline:none',
    ].join(';')
    nameEl.replaceWith(input)
    input.focus()
    input.select()

    const commit = async () => {
      const newName = input.value.trim() || save.name
      save.name = newName
      nameEl.textContent = newName
      input.replaceWith(nameEl)
      await renameSave(save.id, newName)
    }
    input.addEventListener('blur', commit)
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter')  { input.blur() }
      if (e.key === 'Escape') { input.value = save.name; input.blur() }
    })
  }

  void refresh()
}

// ── DOM helpers ──────────────────────────────────────────────

function el(tag: string, styles: Record<string, string>): HTMLElement {
  const node = document.createElement(tag)
  Object.assign(node.style, styles)
  return node
}

function textBtn(label: string): HTMLButtonElement {
  const btn = document.createElement('button')
  btn.textContent = label
  btn.style.cssText = [
    'background:rgba(255,255,255,0.10)', 'border:none', 'border-radius:7px',
    'padding:6px 14px', 'color:#e8e8f0', 'font-size:14px', 'cursor:pointer',
    'flex-shrink:0',
  ].join(';')
  return btn
}

function iconBtn(icon: string): HTMLButtonElement {
  const btn = document.createElement('button')
  btn.textContent = icon
  btn.style.cssText = [
    'background:none', 'border:none', 'padding:2px 4px', 'border-radius:4px',
    'color:#aaa', 'font-size:12px', 'cursor:pointer', 'line-height:1',
    'flex-shrink:0',
  ].join(';')
  return btn
}

function fmtDate(ts: number): string {
  return new Date(ts).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}
