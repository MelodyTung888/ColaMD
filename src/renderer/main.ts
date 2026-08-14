import type { ExportSnapshot, TreeOperationResult } from '../preload/index'
import { createEditor, getMarkdown, setMarkdown, showMathModal } from './editor/editor'
import { SearchPanel } from './editor/search-panel'
import { FileTree } from './file-tree'
import { applyTheme, loadSavedTheme } from './themes/theme-manager'
import './themes/base.css'
import './themes/premium.css'

let sourceModeActive = false
let currentFilePath: string | null = null
let dirty = false
let syncedDirty: boolean | null = null
let applyingUntil = 0
let fileTree: FileTree | null = null

const editorEl = () => document.getElementById('editor') as HTMLElement
const sourceEl = () => document.getElementById('source-editor') as HTMLTextAreaElement
const filePanelEl = () => document.getElementById('file-panel') as HTMLElement
const fileListEl = () => document.getElementById('file-list') as HTMLUListElement
const fileToggleBtnEl = () => document.getElementById('file-toggle-btn') as HTMLButtonElement
const sourceToggleBtnEl = () => document.getElementById('source-toggle-btn') as HTMLButtonElement
const wordCountEl = () => document.getElementById('word-count') as HTMLElement
const fileTitleEl = () => document.getElementById('file-title') as HTMLElement
const updateBannerEl = () => document.getElementById('update-banner') as HTMLElement
const updateBannerTextEl = () => document.getElementById('update-banner-text') as HTMLElement
const updateBannerActionEl = () => document.getElementById('update-banner-action') as HTMLButtonElement

// Fresh installs start focused on the document. Once changed, the user's
// explicit panel preference is preserved.
let manualHidden = localStorage.getItem('file-panel-hidden') !== '0'

function markApplying(): void {
  // Milkdown's markdownUpdated callback is debounced by 200ms. Keep a longer
  // suppression window so programmatic file loads never become user edits.
  applyingUntil = Date.now() + 350
}

function setDirty(value: boolean): void {
  dirty = value
  if (syncedDirty === value) return
  syncedDirty = value
  void window.electronAPI.setDocumentDirty(value).catch(() => {
    // The editor remains safe even if a closing window can no longer sync.
    syncedDirty = null
  })
}

function applyContent(content: string): void {
  markApplying()
  setContent(content)
}

function directoryName(path: string): string {
  const normalized = path === '/' ? path : path.replace(/\/+$/, '')
  const index = normalized.lastIndexOf('/')
  return index <= 0 ? '/' : normalized.slice(0, index)
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
  const label = sourceModeActive ? '切换回所见即所得' : '切换 Markdown 源码'
  btn.setAttribute('aria-label', label)
  const tip = btn.querySelector('.toolbar-tip')
  if (tip) tip.textContent = label
}

function toggleSourceMode(): void {
  if (sourceModeActive) {
    markApplying()
    exitSourceMode()
    setMarkdown(sourceEl().value)
  } else {
    enterSourceMode(getMarkdown())
  }
  updateWordCount()
}

function enterSourceMode(content: string): void {
  sourceModeActive = true
  editorEl().classList.add('hidden')
  const textarea = sourceEl()
  textarea.classList.add('visible')
  textarea.value = content
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
  return sourceModeActive ? sourceEl().value : getMarkdown()
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
  const name = currentFilePath ? (currentFilePath.split('/').pop() || currentFilePath) : '未命名'
  fileTitleEl().textContent = name
}

async function applySavedTheme(): Promise<void> {
  const api = window.electronAPI
  const savedTheme = loadSavedTheme()
  applyTheme(savedTheme)
  if (!savedTheme.startsWith('custom:')) return
  const css = await api.loadThemeCSS(savedTheme.slice(7))
  if (css) applyTheme(savedTheme, css)
}

function getExportSnapshot(content: string): ExportSnapshot {
  let styles = ''
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      styles += Array.from(sheet.cssRules).map((rule) => rule.cssText).join('\n') + '\n'
    } catch {
      // Ignore stylesheets that Chromium marks as inaccessible.
    }
  }
  return {
    content,
    html: document.querySelector('#editor .ProseMirror')?.innerHTML ?? '',
    styles,
    bodyClass: Array.from(document.body.classList)
      .filter((name) => name !== 'show-file-panel' && name !== 'export-mode')
      .join(' '),
  }
}

function afterTwoFrames(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  })
}

function withTimeout<T>(promise: Promise<T>, milliseconds: number): Promise<T | undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), milliseconds)
    promise.then((value) => {
      clearTimeout(timer)
      resolve(value)
    }, () => {
      clearTimeout(timer)
      resolve(undefined)
    })
  })
}

async function waitForRenderedAssets(): Promise<void> {
  await afterTwoFrames()
  if (document.fonts) await withTimeout(document.fonts.ready, 3000)

  const images = Array.from(document.querySelectorAll<HTMLImageElement>('#editor .ProseMirror img'))
  const imagePromises = images.map(async (image) => {
    if (!image.complete) {
      await new Promise<void>((resolve) => {
        image.addEventListener('load', () => resolve(), { once: true })
        image.addEventListener('error', () => resolve(), { once: true })
      })
    }
    if (typeof image.decode === 'function') await image.decode().catch(() => undefined)
  })
  await withTimeout(Promise.all(imagePromises), 5000)
  await afterTwoFrames()
}

async function renderLatestSourceForExport<T>(task: () => Promise<T>): Promise<T> {
  const wasSourceMode = sourceModeActive
  const content = getContent()
  if (wasSourceMode) {
    markApplying()
    exitSourceMode()
    setMarkdown(content)
    await waitForRenderedAssets()
  }
  try {
    return await task()
  } finally {
    if (wasSourceMode) {
      markApplying()
      enterSourceMode(content)
    }
  }
}

async function exportCurrentHTML(): Promise<void> {
  await renderLatestSourceForExport(async () => {
    const content = getContent()
    await waitForRenderedAssets()
    await window.electronAPI.exportHTML(getExportSnapshot(content))
  })
}

async function exportCurrentPDF(): Promise<void> {
  await renderLatestSourceForExport(() => window.electronAPI.exportPDF())
}

function showOperationError(result: TreeOperationResult, fallback: string): void {
  if (result.ok) return
  window.alert(result.error ?? fallback)
}

async function initExportMode(): Promise<void> {
  const api = window.electronAPI
  document.body.classList.add('export-mode')

  const editorReady = (async () => {
    await applySavedTheme()
    await createEditor('editor')
  })()

  api.onExportRenderRequest((request) => {
    void (async () => {
      await editorReady
      const content = request.content ?? getMarkdown()
      if (request.content !== undefined) setMarkdown(request.content)
      await waitForRenderedAssets()
      api.sendExportRenderReady(request.requestId, getExportSnapshot(content))
    })()
  })

  await editorReady
}

async function initNormalMode(): Promise<void> {
  const api = window.electronAPI
  await applySavedTheme()

  const searchPanel = new SearchPanel()
  api.onSearch(() => searchPanel.show())
  api.onMathModal(() => showMathModal())

  await createEditor('editor', (markdown) => {
    if (Date.now() >= applyingUntil) setDirty(true)
    updateWordCount(markdown)
  })
  updateWordCount()
  setDirty(false)

  fileTree = new FileTree({
    api,
    panel: filePanelEl(),
    tree: fileListEl(),
    rootLabel: document.getElementById('file-tree-root-label') as HTMLElement,
    rootUpButton: document.getElementById('file-root-up') as HTMLButtonElement,
    chooseRootButton: document.getElementById('file-root-choose') as HTMLButtonElement,
    status: document.getElementById('file-tree-status') as HTMLElement,
    onOpenFile: async (path) => {
      if (path === currentFilePath) return true
      if (dirty && !window.confirm('当前文件有未保存的修改，切换文件会丢失这些修改。是否继续？')) return false
      const result = await api.openTreeFile(path)
      showOperationError(result, '无法打开这个 Markdown 文档。')
      return result.ok
    },
    onExportFile: async (path, format) => {
      if (path === currentFilePath) {
        if (format === 'pdf') await exportCurrentPDF()
        else await exportCurrentHTML()
        return
      }
      const result = await api.exportTreeFile(path, format)
      showOperationError(result, `无法导出 ${format.toUpperCase()}。`)
    },
  })
  await fileTree.initialize(currentFilePath)

  fileToggleBtnEl().addEventListener('click', togglePanel)
  api.onToggleFilePanel(() => togglePanel())
  sourceToggleBtnEl().addEventListener('click', toggleSourceMode)
  sourceEl().addEventListener('input', () => {
    if (Date.now() >= applyingUntil) setDirty(true)
    updateWordCount()
  })
  updatePanelVisibility()

  api.onMenuOpen(async () => {
    await api.openFile()
  })

  api.onMenuSave(async () => {
    const path = await api.saveFile(getContent())
    if (!path) return
    setDirty(false)
    currentFilePath = path
    updateFileTitle()
    await fileTree?.refreshDirectory(directoryName(path))
    await fileTree?.setCurrentPath(path)
  })
  api.onMenuSaveAs(async () => {
    const path = await api.saveFileAs(getContent())
    if (!path) return
    setDirty(false)
    currentFilePath = path
    updateFileTitle()
    await fileTree?.refreshDirectory(directoryName(path))
    await fileTree?.setCurrentPath(path)
  })
  api.onMenuExportPDF(() => { void exportCurrentPDF() })
  api.onMenuExportHTML(() => { void exportCurrentHTML() })

  api.onNewFile(() => {
    currentFilePath = null
    setDirty(false)
    exitSourceMode()
    applyContent('')
    updateFileTitle()
    void fileTree?.setCurrentPath(null)
  })
  api.onFileOpened((data) => {
    currentFilePath = data.path
    setDirty(false)
    applyContent(data.content)
    updateFileTitle()
    updatePanelVisibility()
    void fileTree?.setCurrentPath(data.path)
  })
  api.onFileChanged((content) => {
    markApplying()
    if (sourceModeActive) sourceEl().value = content
    else setMarkdown(content)
    updateSourceToggle()
    updateWordCount()
    setDirty(false)
  })
  api.onFileDetached((data) => {
    if (data.path !== currentFilePath) return
    currentFilePath = null
    // Preserve the editor exactly as-is. Saving now prompts for a new path.
    setDirty(true)
    updateFileTitle()
    void fileTree?.setCurrentPath(null)
  })

  api.onSetTheme((theme) => applyTheme(theme))
  api.onSetCustomCSS((css) => applyTheme(loadSavedTheme(), css))
  api.onMenuImportTheme(async () => {
    const result = await api.loadCustomTheme()
    if (result) applyTheme(`custom:${result.name}`, result.css)
  })

  // --- Auto update banner (weak, non-blocking) ---
  let updateDownloaded = false
  function showUpdateBanner(version: string): void {
    updateBannerTextEl().textContent = updateDownloaded ? `新版本 v${version} 已就绪` : `发现新版本 v${version}`
    updateBannerActionEl().textContent = updateDownloaded ? '重启安装' : '更新'
    updateBannerActionEl().disabled = false
    updateBannerEl().hidden = false
  }

  api.onUpdateAvailable((version) => {
    updateDownloaded = false
    showUpdateBanner(version)
  })
  api.onUpdateDownloaded((version) => {
    updateDownloaded = true
    showUpdateBanner(version)
  })
  updateBannerActionEl().addEventListener('click', async () => {
    if (updateDownloaded) {
      await api.installUpdate()
    } else {
      updateBannerActionEl().textContent = '下载中…'
      updateBannerActionEl().disabled = true
      await api.downloadUpdate()
    }
  })
  document.getElementById('update-banner-dismiss')!.addEventListener('click', () => {
    updateBannerEl().hidden = true
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

  document.addEventListener('dragover', (event) => event.preventDefault())
  document.addEventListener('drop', async (event) => {
    event.preventDefault()
    const file = event.dataTransfer?.files[0]
    if (!file) return
    const filePath = api.getPathForFile(file)
    if (filePath) await api.openFilePath(filePath)
  })
}

async function init(): Promise<void> {
  const mode = new URLSearchParams(window.location.search).get('mode')
  if (mode === 'export') await initExportMode()
  else await initNormalMode()
}

init().catch((error) => console.error('ColaMD init failed:', error))
