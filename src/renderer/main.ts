import { createEditor, getMarkdown, setMarkdown, showMathModal } from './editor/editor'
import { SearchPanel } from './editor/search-panel'
import { applyTheme, loadSavedTheme } from './themes/theme-manager'
import './themes/base.css'
import './themes/premium.css'

let sourceModeActive = false
const editorEl = () => document.getElementById('editor') as HTMLElement
const sourceEl = () => document.getElementById('source-editor') as HTMLTextAreaElement
const filePanelEl = () => document.getElementById('file-panel') as HTMLElement
const fileListEl = () => document.getElementById('file-list') as HTMLElement
const fileToggleBtnEl = () => document.getElementById('file-toggle-btn') as HTMLButtonElement
const sourceToggleBtnEl = () => document.getElementById('source-toggle-btn') as HTMLButtonElement
const wordCountEl = () => document.getElementById('word-count') as HTMLElement
const fileTitleEl = () => document.getElementById('file-title') as HTMLElement

// --- Same-directory file panel ---
let currentFilePath: string | null = null
let dirty = false
// Milkdown's markdownUpdated listener fires 200ms-debounced AFTER a doc change,
// so a programmatic load would spuriously mark the doc dirty unless we keep a
// suppression window long enough to cover that debounce.
let applyingUntil = 0
// Fresh installs start focused on the document. Once changed, the user's
// explicit panel preference is preserved.
let manualHidden = localStorage.getItem('file-panel-hidden') !== '0'

function markApplying(): void {
  applyingUntil = Date.now() + 350
}

function applyContent(content: string): void {
  markApplying()
  setContent(content)
}

// --- Document statistics (top-right hover indicator) ---
function countCharacters(content: string): number {
  return content.replace(/\s/g, '').length
}

function countTokens(content: string): number {
  const tokens = content.match(/[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u3040-\u30FF\uAC00-\uD7AF]|[A-Za-z]+(?:['’\\-][A-Za-z]+)*|\d+(?:[.,]\d+)*/g)
  return tokens?.length ?? 0
}

function countParagraphs(content: string): number {
  const normalized = content.replace(/\r\n?/g, '\n').trim()
  return normalized ? normalized.split(/\n\s*\n+/).filter((block) => block.trim()).length : 0
}

function updateWordCount(content?: string): void {
  const text = content ?? getContent()
  const tip = wordCountEl().querySelector('.word-count-tip')
  if (!tip) return
  tip.textContent = `${countCharacters(text)} 字 · ${countTokens(text)} 词 · ${countParagraphs(text)} 段`
}

// --- Markdown source / WYSIWYG toggle ---
function updateSourceToggle(): void {
  const btn = sourceToggleBtnEl()
  btn.classList.toggle('active', sourceModeActive)
  const label = sourceModeActive
    ? '切换回所见即所得'
    : '切换 Markdown 源码'
  btn.setAttribute('aria-label', label)
  const tip = btn.querySelector('.toolbar-tip')
  if (tip) tip.textContent = label
}

function toggleSourceMode(): void {
  if (sourceModeActive) {
    // Source → WYSIWYG: re-parse the textarea content back into the editor
    markApplying() // suppress the spurious dirty flag from the markdownUpdated debounce
    exitSourceMode()
    setMarkdown(sourceEl().value)
  } else {
    // WYSIWYG → Source: serialize the current editor content into the textarea
    enterSourceMode(getMarkdown())
  }
  updateWordCount()
}

function updatePanelVisibility(): void {
  const show = !manualHidden
  filePanelEl().hidden = !show
  document.body.classList.toggle('show-file-panel', show)
  fileToggleBtnEl().classList.toggle('active', show)
}

function togglePanel(): void {
  manualHidden = !manualHidden
  localStorage.setItem('file-panel-hidden', manualHidden ? '1' : '0')
  updatePanelVisibility()
}

function updateFileTitle(): void {
  const name = currentFilePath ? (currentFilePath.split(/[\\/]/).pop() || currentFilePath) : '未命名'
  fileTitleEl().textContent = name
}

function renderFileList(files: import('../preload/index').SiblingFile[]): void {
  const list = fileListEl()
  list.innerHTML = ''
  for (const f of files) {
    const li = document.createElement('li')
    const btn = document.createElement('button')
    const icon = document.createElement('span')
    icon.className = `file-entry-icon ${f.kind}`
    icon.setAttribute('aria-hidden', 'true')
    icon.innerHTML = f.kind === 'parent'
      ? '<svg viewBox="0 0 16 16"><path d="M13 8H3.5M7 4 3 8l4 4"/></svg>'
      : f.kind === 'directory'
        ? '<svg viewBox="0 0 16 16"><path d="M2.5 4.5h4l1.5 1.5h6v6.5h-11.5z"/><path d="M2.5 4.5v-1h4l1.5 1.5"/></svg>'
        : '<svg viewBox="0 0 16 16"><path d="M4 2.5h5l3 3v8H4z"/><path d="M9 2.5v3h3"/></svg>'
    const label = document.createElement('span')
    label.className = 'file-entry-name'
    label.textContent = f.kind === 'parent' ? '..' : f.name
    btn.addEventListener('mouseenter', () => {
      const overflow = label.scrollWidth - label.clientWidth
      if (overflow <= 0) return
      label.style.setProperty('--file-entry-scroll', `${overflow}px`)
      label.style.setProperty('--file-entry-scroll-duration', `${Math.min(6, Math.max(2.4, overflow / 20))}s`)
      label.classList.add('scrolling')
    })
    btn.addEventListener('mouseleave', () => {
      label.classList.remove('scrolling')
      label.style.removeProperty('--file-entry-scroll')
      label.style.removeProperty('--file-entry-scroll-duration')
    })
    btn.title = f.kind === 'directory' ? `打开 ${f.name}` : f.kind === 'parent' ? '返回上级目录' : f.name
    btn.dataset.path = f.path
    btn.dataset.kind = f.kind
    btn.classList.toggle('directory', f.kind === 'directory')
    btn.classList.toggle('parent', f.kind === 'parent')
    if (f.path === currentFilePath) btn.classList.add('active')
    btn.append(icon, label)
    li.appendChild(btn)
    list.appendChild(li)
  }
}

async function refreshSiblings(): Promise<void> {
  const files = await window.electronAPI.listSiblings()
  if (files) renderFileList(files)
}

function enterSourceMode(content: string): void {
  sourceModeActive = true
  editorEl().classList.add('hidden')
  const ta = sourceEl()
  ta.classList.add('visible')
  ta.value = content
  updateSourceToggle()
}

function exitSourceMode(): void {
  sourceModeActive = false
  editorEl().classList.remove('hidden')
  sourceEl().classList.remove('visible')
  updateSourceToggle()
}

function setContent(content: string): void {
  exitSourceMode()
  setMarkdown(content)
  updateWordCount()
}

function getContent(): string {
  if (sourceModeActive) return sourceEl().value
  return getMarkdown()
}

function getExportSnapshot(content: string): {
  content: string
  html: string
  styles: string
  bodyClass: string
} {
  let styles = ''
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      styles += Array.from(sheet.cssRules).map((rule) => rule.cssText).join('\n') + '\n'
    } catch {
      // Ignore stylesheets that the browser marks as inaccessible.
    }
  }
  return {
    content,
    html: document.querySelector('#editor .ProseMirror')?.innerHTML ?? '',
    styles,
    bodyClass: Array.from(document.body.classList).filter((name) => name !== 'show-file-panel').join(' '),
  }
}

async function exportCurrentHTML(): Promise<void> {
  const wasSourceMode = sourceModeActive
  const content = getContent()

  // Render the latest source text before taking the DOM snapshot, then restore
  // source mode so exporting does not change the user's editing context.
  if (wasSourceMode) {
    markApplying()
    exitSourceMode()
    setMarkdown(content)
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => resolve())
      })
    })
  }

  await window.electronAPI.exportHTML(getExportSnapshot(content))

  if (wasSourceMode) {
    markApplying()
    enterSourceMode(content)
  }
}

async function init(): Promise<void> {
  const api = window.electronAPI
  const savedTheme = loadSavedTheme()
  applyTheme(savedTheme)

  if (savedTheme.startsWith('custom:')) {
    const fileName = savedTheme.slice(7)
    const css = await api.loadThemeCSS(fileName)
    if (css) applyTheme(savedTheme, css)
  }

  const searchPanel = new SearchPanel()
  api.onSearch(() => searchPanel.show())
  api.onMathModal(() => showMathModal())

  await createEditor('editor', (markdown) => {
    if (Date.now() >= applyingUntil) dirty = true
    updateWordCount(markdown)
  })
  updateWordCount()

  // File panel: switch to a sibling file (confirm if there are unsaved edits)
  fileListEl().addEventListener('click', async (e) => {
    const btn = (e.target as HTMLElement).closest('button[data-path]') as HTMLButtonElement | null
    if (!btn || !btn.dataset.path) return
    if (btn.dataset.path === currentFilePath) return
    if (btn.dataset.kind === 'file' && dirty && !window.confirm('当前文件有未保存的修改，切换文件会丢失这些修改。是否继续？')) return
    await api.openSibling(btn.dataset.path)
  })

  fileToggleBtnEl().addEventListener('click', togglePanel)
  api.onToggleFilePanel(() => togglePanel())

  sourceToggleBtnEl().addEventListener('click', toggleSourceMode)
  // Source-mode edits update the word count and mark the doc dirty in real time
  sourceEl().addEventListener('input', () => {
    if (Date.now() >= applyingUntil) dirty = true
    updateWordCount()
  })

  api.onSiblingsChanged((files) => renderFileList(files))
  updatePanelVisibility()
  await refreshSiblings()

  api.onMenuOpen(async () => {
    // 'file-opened' event drives the content load (and file-panel refresh)
    await api.openFile()
  })

  api.onMenuSave(async () => {
    const path = await api.saveFile(getContent())
    if (path) {
      dirty = false
      currentFilePath = path
      updateFileTitle()
      refreshSiblings()
    }
  })
  api.onMenuSaveAs(async () => {
    const path = await api.saveFileAs(getContent())
    if (path) {
      dirty = false
      currentFilePath = path
      updateFileTitle()
      refreshSiblings()
    }
  })
  api.onMenuExportPDF(() => api.exportPDF())
  api.onMenuExportHTML(() => { void exportCurrentHTML() })

  api.onNewFile(() => { exitSourceMode(); applyContent('') })
  api.onFileOpened((data) => {
    currentFilePath = data.path
    dirty = false
    markApplying()
    setContent(data.content)
    updateFileTitle()
    updatePanelVisibility()
    refreshSiblings()
  })
  api.onFileChanged((content) => {
    markApplying()
    if (sourceModeActive) {
      sourceEl().value = content
    } else {
      setMarkdown(content)
    }
    updateSourceToggle()
    updateWordCount()
    dirty = false
  })
  api.onSetTheme((theme) => applyTheme(theme))
  api.onSetCustomCSS((css) => {
    const theme = loadSavedTheme()
    applyTheme(theme, css)
  })

  api.onMenuImportTheme(async () => {
    const result = await api.loadCustomTheme()
    if (result) applyTheme(`custom:${result.name}`, result.css)
  })

  const agentDot = document.getElementById('agent-dot')
  api.onAgentActivity((state) => {
    if (!agentDot) return
    agentDot.className = state === 'idle' ? '' : state
    const label = state === 'active'
      ? 'Agent 正在修改文档'
      : state === 'cooldown'
        ? 'Agent 刚刚完成修改'
        : 'Agent 状态'
    agentDot.setAttribute('aria-label', label)
    const tip = agentDot.querySelector('.toolbar-tip')
    if (tip) tip.textContent = label
  })

  document.addEventListener('dragover', (e) => e.preventDefault())
  document.addEventListener('drop', async (e) => {
    e.preventDefault()
    const file = e.dataTransfer?.files[0]
    if (!file) return
    const filePath = api.getPathForFile(file)
    if (!filePath) return
    const result = await api.openFilePath(filePath)
    // 'file-opened' event drives the content load when opened into this window
    void result
  })
}

init().catch((e) => console.error('ColaMD init failed:', e))
