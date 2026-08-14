import { app, BrowserWindow, ipcMain, dialog, Menu, shell, webContents } from 'electron'
import { autoUpdater } from 'electron-updater'
import { join, basename, dirname, extname, isAbsolute, resolve, relative, sep } from 'path'
import { fileURLToPath, pathToFileURL } from 'url'
import { readFile, writeFile, readdir, copyFile, mkdir, stat } from 'fs/promises'
import { watch, FSWatcher, existsSync, readdirSync } from 'fs'
import { execFile } from 'child_process'
import { randomUUID } from 'crypto'
import {
  assertSafeTreePath,
  canonicalizeTreeRoot,
  createTreeEntry,
  describeTreeError,
  duplicateTreeFile,
  isMarkdownPath,
  listTreeDirectory,
  type DirectorySnapshot
} from './file-tree'

// Custom themes directory
const themesDir = join(app.getPath('home'), '.colamd-melody', 'themes')
const APP_DISPLAY_NAME = 'ColaMD Melody'
const APP_BUNDLE_ID = 'com.melody.colamd'

// Bundled examples are opened on demand from Help. Browsing the user's
// Documents folder on macOS can trigger a privacy prompt before they have even
// opened a file.
const demoDir = app.isPackaged
  ? join(process.resourcesPath, 'demo')
  : join(__dirname, '../../resources/demo')
const cheatsheetDir = app.isPackaged
  ? join(process.resourcesPath, 'templates')
  : join(__dirname, '../../resources/templates')

function ensureThemesDir(): void {
  if (!existsSync(themesDir)) {
    mkdir(themesDir, { recursive: true }).catch(() => {})
  }
}

async function scanCustomThemes(): Promise<string[]> {
  try {
    const files = await readdir(themesDir)
    return files.filter(f => f.endsWith('.css')).sort()
  } catch {
    return []
  }
}

// Per-window state
interface WindowState {
  filePath: string | null
  treeRootPath: string | null
  fileWatcher: FSWatcher | null
  treeWatchers: Map<string, { watcher: FSWatcher; timer: ReturnType<typeof setTimeout> | null }>
  documentDirty: boolean
  isInternalSave: boolean
  debounceTimer: ReturnType<typeof setTimeout> | null
  agentState: 'idle' | 'active' | 'cooldown'
  lastExternalChange: number
  agentCooldownTimer: ReturnType<typeof setTimeout> | null
}

const windowStates = new Map<number, WindowState>()
let pendingFilePaths: string[] = []

interface ExportSnapshot {
  content: string
  html: string
  styles: string
  bodyClass: string
}

interface PendingExportRender {
  senderId: number
  resolve: (snapshot: ExportSnapshot) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
  onDestroyed: () => void
}

const pendingExportRenders = new Map<string, PendingExportRender>()

function getState(win: BrowserWindow): WindowState {
  let state = windowStates.get(win.id)
  if (!state) {
    state = {
      filePath: null,
      treeRootPath: null,
      fileWatcher: null,
      treeWatchers: new Map(),
      documentDirty: false,
      isInternalSave: false,
      debounceTimer: null,
      agentState: 'idle',
      lastExternalChange: 0,
      agentCooldownTimer: null
    }
    windowStates.set(win.id, state)
  }
  return state
}

function getWinFromEvent(event: Electron.IpcMainInvokeEvent): BrowserWindow | null {
  return BrowserWindow.fromWebContents(event.sender)
}

function createWindow(filePath?: string, initialContent?: string, initialTreeRootPath?: string): BrowserWindow {
  const win = new BrowserWindow({
    width: 960,
    height: 720,
    minWidth: 600,
    minHeight: 400,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 14 },
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // No spellcheck UI in ColaMD — avoid red squiggles in the editor (issue #7)
      spellcheck: false
    }
  })

  const state = getState(win)

  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  win.webContents.on('did-finish-load', () => {
    void (async () => {
      if (filePath) {
        await loadFileInWindow(win, filePath)
      } else {
        if (initialTreeRootPath) {
          try { await setTreeRoot(win, initialTreeRootPath) } catch { /* unavailable bundled directory */ }
        }
        if (initialContent) {
          // In-memory content (e.g. the Markdown cheatsheet) — no file, no file watcher.
          win.webContents.send('file-opened', { path: null, content: initialContent })
        }
      }
    })()
  })

  win.on('closed', () => {
    stopWatching(state)
    windowStates.delete(win.id)
  })

  updateTitle(win)
  return win
}

async function createExportWindow(): Promise<BrowserWindow> {
  const win = new BrowserWindow({
    show: false,
    width: 960,
    height: 720,
    paintWhenInitiallyHidden: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      backgroundThrottling: false
    }
  })

  try {
    if (process.env.ELECTRON_RENDERER_URL) {
      const url = new URL(process.env.ELECTRON_RENDERER_URL)
      url.searchParams.set('mode', 'export')
      await win.loadURL(url.toString())
    } else {
      await win.loadFile(join(__dirname, '../renderer/index.html'), { query: { mode: 'export' } })
    }
    return win
  } catch (error) {
    if (!win.isDestroyed()) win.destroy()
    throw error
  }
}

function isExportSnapshot(value: unknown): value is ExportSnapshot {
  if (!value || typeof value !== 'object') return false
  const snapshot = value as Partial<ExportSnapshot>
  return typeof snapshot.content === 'string'
    && typeof snapshot.html === 'string'
    && typeof snapshot.styles === 'string'
    && typeof snapshot.bodyClass === 'string'
}

function finishExportRender(requestId: string, snapshot?: ExportSnapshot, error?: Error): void {
  const pending = pendingExportRenders.get(requestId)
  if (!pending) return
  pendingExportRenders.delete(requestId)
  clearTimeout(pending.timer)
  const sender = webContents.fromId(pending.senderId)
  sender?.removeListener('destroyed', pending.onDestroyed)
  if (snapshot) pending.resolve(snapshot)
  else pending.reject(error ?? new Error('导出渲染失败。'))
}

ipcMain.on('export-render-ready', (event, value: unknown) => {
  if (!value || typeof value !== 'object') return
  const payload = value as { requestId?: unknown; snapshot?: unknown }
  if (typeof payload.requestId !== 'string') return
  const pending = pendingExportRenders.get(payload.requestId)
  if (!pending || pending.senderId !== event.sender.id) return
  if (!isExportSnapshot(payload.snapshot)) {
    finishExportRender(payload.requestId, undefined, new Error('导出窗口返回了无效内容。'))
    return
  }
  finishExportRender(payload.requestId, payload.snapshot)
})

function renderExportSnapshot(win: BrowserWindow, filePath: string, content: string): Promise<ExportSnapshot> {
  const requestId = randomUUID()
  return new Promise((resolve, reject) => {
    const onDestroyed = (): void => {
      finishExportRender(requestId, undefined, new Error('导出窗口已提前关闭。'))
    }
    const timer = setTimeout(() => {
      finishExportRender(requestId, undefined, new Error('导出渲染超时，请重试。'))
    }, 15_000)
    pendingExportRenders.set(requestId, {
      senderId: win.webContents.id,
      resolve,
      reject,
      timer,
      onDestroyed
    })
    win.webContents.once('destroyed', onDestroyed)
    try {
      win.webContents.send('export-render-request', { requestId, path: filePath, content })
    } catch (error) {
      finishExportRender(requestId, undefined, error instanceof Error ? error : new Error('无法启动导出渲染。'))
    }
  })
}

function updateTitle(win: BrowserWindow): void {
  const state = getState(win)
  const fileName = state.filePath ? basename(state.filePath) : 'Untitled'
  win.setTitle(`${fileName} — ${APP_DISPLAY_NAME}`)
}

function suggestFileName(win: BrowserWindow, content?: string): string | undefined {
  const state = getState(win)
  if (state.filePath) return basename(state.filePath, extname(state.filePath))
  if (!content) return undefined
  // Extract first heading or first non-empty line
  const match = content.match(/^#\s+(.+)/m) || content.match(/^(.+)/m)
  if (!match) return undefined
  return match[1].trim().replace(/[/\\:*?"<>|]/g, '').slice(0, 60) || undefined
}

function stopWatching(state: WindowState): void {
  if (state.fileWatcher) {
    state.fileWatcher.close()
    state.fileWatcher = null
  }
  if (state.debounceTimer) {
    clearTimeout(state.debounceTimer)
    state.debounceTimer = null
  }
  for (const entry of state.treeWatchers.values()) {
    entry.watcher.close()
    if (entry.timer) clearTimeout(entry.timer)
  }
  state.treeWatchers.clear()
  if (state.agentCooldownTimer) {
    clearTimeout(state.agentCooldownTimer)
    state.agentCooldownTimer = null
  }
  state.agentState = 'idle'
  state.lastExternalChange = 0
}

function stopFileWatching(state: WindowState): void {
  if (state.fileWatcher) {
    state.fileWatcher.close()
    state.fileWatcher = null
  }
  if (state.debounceTimer) {
    clearTimeout(state.debounceTimer)
    state.debounceTimer = null
  }
}

function stopTreeWatchers(state: WindowState): void {
  for (const entry of state.treeWatchers.values()) {
    entry.watcher.close()
    if (entry.timer) clearTimeout(entry.timer)
  }
  state.treeWatchers.clear()
}

function startTreeWatcher(win: BrowserWindow, state: WindowState, directoryPath: string): void {
  if (state.treeWatchers.has(directoryPath)) return
  try {
    const entry: { watcher: FSWatcher; timer: ReturnType<typeof setTimeout> | null } = {
      watcher: null as unknown as FSWatcher,
      timer: null
    }
    const watcher = watch(directoryPath, () => {
      if (entry.timer) clearTimeout(entry.timer)
      entry.timer = setTimeout(() => {
        entry.timer = null
        if (!win.isDestroyed()) win.webContents.send('tree-directory-changed', { path: directoryPath })
      }, 180)
    })
    entry.watcher = watcher
    watcher.on('error', () => {
      const current = state.treeWatchers.get(directoryPath)
      if (current !== entry) return
      if (entry.timer) clearTimeout(entry.timer)
      entry.watcher.close()
      state.treeWatchers.delete(directoryPath)
      if (!win.isDestroyed()) win.webContents.send('tree-directory-changed', { path: directoryPath })
    })
    state.treeWatchers.set(directoryPath, entry)
  } catch {
    // The renderer can retry on its next expanded-directory sync.
  }
}

async function syncTreeWatchers(
  win: BrowserWindow,
  state: WindowState,
  requestedDirectories: string[]
): Promise<void> {
  if (!state.treeRootPath) {
    stopTreeWatchers(state)
    return
  }

  const wanted = new Set<string>([state.treeRootPath])
  for (const inputPath of requestedDirectories.slice(0, 256)) {
    try {
      wanted.add(await assertSafeTreePath(state.treeRootPath, inputPath, 'directory'))
    } catch {
      // Ignore stale or forged expanded paths; the valid subset remains watched.
    }
  }

  for (const [directoryPath, entry] of state.treeWatchers) {
    if (wanted.has(directoryPath)) continue
    entry.watcher.close()
    if (entry.timer) clearTimeout(entry.timer)
    state.treeWatchers.delete(directoryPath)
  }
  for (const directoryPath of wanted) startTreeWatcher(win, state, directoryPath)
}

async function setTreeRoot(win: BrowserWindow, inputPath: string, notify = true): Promise<DirectorySnapshot> {
  const state = getState(win)
  const rootPath = await canonicalizeTreeRoot(inputPath)
  const snapshot = await listTreeDirectory(rootPath, rootPath)
  const rootChanged = state.treeRootPath !== rootPath
  if (rootChanged) stopTreeWatchers(state)
  state.treeRootPath = rootPath
  if (rootChanged) await syncTreeWatchers(win, state, [])
  else startTreeWatcher(win, state, rootPath)
  if (notify && !win.isDestroyed()) {
    win.webContents.send('tree-root-changed', { path: rootPath, snapshot })
  }
  return snapshot
}

async function ensureTreeRootForFile(win: BrowserWindow, filePath: string): Promise<void> {
  const state = getState(win)
  const candidateDirectory = await canonicalizeTreeRoot(dirname(filePath))
  if (state.treeRootPath) {
    try {
      await assertSafeTreePath(state.treeRootPath, filePath, 'file')
      return
    } catch {
      // Opening a file outside the current tree starts a new tree at its parent.
    }
  }
  await setTreeRoot(win, candidateDirectory)
}

function transitionAgentState(win: BrowserWindow, state: WindowState, newState: 'idle' | 'active' | 'cooldown'): void {
  if (state.agentCooldownTimer) {
    clearTimeout(state.agentCooldownTimer)
    state.agentCooldownTimer = null
  }

  if (newState === 'active') {
    if (state.agentState !== 'active') {
      state.agentState = 'active'
      if (!win.isDestroyed()) win.webContents.send('agent-activity', 'active')
    }
    // Reset cooldown timer — 3s after last write
    state.agentCooldownTimer = setTimeout(() => {
      transitionAgentState(win, state, 'cooldown')
    }, 3000)
  } else if (newState === 'cooldown') {
    state.agentState = 'cooldown'
    if (!win.isDestroyed()) win.webContents.send('agent-activity', 'cooldown')
    state.agentCooldownTimer = setTimeout(() => {
      transitionAgentState(win, state, 'idle')
    }, 2000)
  } else {
    state.agentState = 'idle'
    if (!win.isDestroyed()) win.webContents.send('agent-activity', 'idle')
  }
}

function watchFile(win: BrowserWindow, state: WindowState): void {
  if (!state.filePath) return
  stopFileWatching(state)

  const filePath = state.filePath
  const dir = dirname(filePath)
  const fileName = basename(filePath)
  // macOS FSEvents replays recent history when a watcher starts; drop events
  // fired within this window so opening a file doesn't trigger a spurious reload.
  let suppressUntil = 0

  const scheduleReload = (): void => {
    if (state.debounceTimer) clearTimeout(state.debounceTimer)
    state.debounceTimer = setTimeout(() => {
      readFile(filePath, 'utf-8')
        .then((data) => {
          if (!win.isDestroyed()) win.webContents.send('file-changed', resolveImagePaths(data, filePath))
        })
        .catch(() => { /* file mid-replace; a follow-up event will re-trigger */ })
    }, 100)
  }

  const onExternalChange = (): void => {
    if (state.isInternalSave) return
    if (Date.now() < suppressUntil) return

    // Agent activity detection
    const now = Date.now()
    const gap = now - state.lastExternalChange
    state.lastExternalChange = now
    if (gap > 0 && gap < 2000) {
      transitionAgentState(win, state, 'active')
    } else if (state.agentState === 'active') {
      transitionAgentState(win, state, 'active') // reset cooldown timer
    }

    scheduleReload()
  }

  const establish = (): void => {
    if (state.filePath !== filePath) return
    suppressUntil = Date.now() + 300
    if (state.fileWatcher) {
      state.fileWatcher.close()
      state.fileWatcher = null
    }
    try {
      // Watch the parent directory instead of the file: agents often save
      // atomically (write temp + rename over), which replaces the file's
      // inode and silently kills a watcher bound to the old file. A
      // directory watcher survives those and keeps reporting our filename.
      const watcher = watch(dir, (eventType, filename) => {
        if (state.isInternalSave) return
        // filename may be null on some platforms — treat as our file
        if (filename !== null && filename !== fileName) {
          return
        }

        if (eventType === 'rename') {
          // Atomic save / file replacement. The dir watcher itself stays
          // valid, but re-establish anyway to cover platform quirks.
          onExternalChange()
          if (filename === fileName && existsSync(filePath)) establish()
        } else if (eventType === 'change') {
          onExternalChange()
        }
      })
      watcher.on('error', () => {
        // Watcher died (directory removed, permissions…). Retry so we
        // recover automatically when the file comes back.
        establish()
      })
      state.fileWatcher = watcher
    } catch {
      // Fallback: watch the file directly if the directory isn't watchable
      try {
        const watcher = watch(filePath, (eventType) => {
          if (eventType !== 'change' || state.isInternalSave) return
          onExternalChange()
        })
        watcher.on('error', () => establish())
        state.fileWatcher = watcher
      } catch { /* file not watchable; nothing to do */ }
    }
  }

  establish()
}

// Rewrite local image paths to encoded file:// URLs. This handles both
// standard Markdown images and the raw <img src="..."> HTML that Milkdown
// accepts, including Windows drive letters, backslashes, spaces and Unicode.
function localImageUrl(src: string, dir: string): string {
  const value = src.trim().replace(/^<|>$/g, '')
  if (/^(?:https?:|file:|data:|blob:)/i.test(value)) return src
  return pathToFileURL(isAbsolute(value) ? value : resolve(dir, value)).href
}

function resolveImagePaths(content: string, filePath: string): string {
  const dir = dirname(filePath)
  const markdown = content.replace(/!\[([^\]]*)\]\((?!https?:\/\/|file:\/\/|data:|blob:)([^)]+)\)/g, (_match, alt, src) => {
    return `![${alt}](${localImageUrl(src, dir)})`
  })

  return markdown.replace(/(<img\b[^>]*\bsrc\s*=\s*)(["'])([^"']+)\2/gi, (_match, prefix, quote, src) => {
    return `${prefix}${quote}${localImageUrl(src, dir)}${quote}`
  })
}

// Keep the editor's display URLs out of the Markdown source. Image paths are
// rewritten to file:// URLs for rendering, then converted back to paths that
// are portable relative to the file being saved.
function sourceImageUrl(src: string, dir: string): string {
  const value = src.trim()
  if (!/^file:/i.test(value)) return src

  try {
    const target = fileURLToPath(value)
    const portable = relative(dir, target).replaceAll('\\', '/')
    return portable || './'
  } catch {
    return src
  }
}

function markdownImagePath(value: string): string {
  return /[\s()]/.test(value) ? `<${value}>` : value
}

function restoreImagePaths(content: string, filePath: string): string {
  const dir = dirname(filePath)
  const markdown = content.replace(/!\[([^\]]*)\]\((file:[^)]+)\)/gi, (_match, alt, src) => {
    return `![${alt}](${markdownImagePath(sourceImageUrl(src, dir))})`
  })

  return markdown.replace(/(<img\b[^>]*\bsrc\s*=\s*)(["'])(file:[^"']+)\2/gi, (_match, prefix, quote, src) => {
    return `${prefix}${quote}${sourceImageUrl(src, dir)}${quote}`
  })
}

async function loadFileInWindow(win: BrowserWindow, inputPath: string): Promise<boolean> {
  const filePath = resolve(inputPath)
  try {
    const data = await readFile(filePath, 'utf-8')
    const state = getState(win)
    state.filePath = filePath
    state.documentDirty = false
    await ensureTreeRootForFile(win, filePath)
    watchFile(win, state)
    updateTitle(win)
    win.webContents.send('file-opened', { path: filePath, content: resolveImagePaths(data, filePath) })
    return true
  } catch {
    return false
  }
}

// Find window that already has this file open
function findWindowForFile(filePath: string): BrowserWindow | null {
  for (const [id, state] of windowStates) {
    if (state.filePath === filePath) {
      return BrowserWindow.fromId(id) || null
    }
  }
  return null
}

// Open file: reuse existing window or create new one
function openFile(filePath: string): void {
  // If already open, focus that window
  const existing = findWindowForFile(filePath)
  if (existing) {
    existing.focus()
    return
  }

  // Find an untitled empty window to reuse
  const emptyWin = findEmptyWindow()
  if (emptyWin) {
    void loadFileInWindow(emptyWin, filePath)
    emptyWin.focus()
    return
  }

  // Create new window
  const win = createWindow(filePath)
  win.focus()
}

function findEmptyWindow(): BrowserWindow | null {
  for (const [id, state] of windowStates) {
    if (!state.filePath) {
      return BrowserWindow.fromId(id) || null
    }
  }
  return null
}

async function saveToPath(win: BrowserWindow, filePath: string, content: string): Promise<boolean> {
  const state = getState(win)
  try {
    filePath = resolve(filePath)
    state.isInternalSave = true
    await writeFile(filePath, restoreImagePaths(content, filePath), 'utf-8')
    state.filePath = filePath
    state.documentDirty = false
    await ensureTreeRootForFile(win, filePath)
    watchFile(win, state)
    updateTitle(win)
    return true
  } catch {
    return false
  } finally {
    setTimeout(() => { state.isInternalSave = false }, 100)
  }
}

// IPC Handlers

ipcMain.on('open-external', (_event, url: string) => {
  if (typeof url === 'string' && (url.startsWith('https://') || url.startsWith('http://'))) {
    shell.openExternal(url)
  }
})

ipcMain.handle('open-file', async (event) => {
  const win = getWinFromEvent(event)
  if (!win) return null
  const result = await dialog.showOpenDialog(win, {
    filters: [
      { name: 'Markdown', extensions: ['md', 'markdown', 'mdown', 'mkd'] },
      { name: 'Text', extensions: ['txt'] },
      { name: 'All Files', extensions: ['*'] }
    ],
    properties: ['openFile']
  })
  if (result.canceled || result.filePaths.length === 0) return null

  const filePath = result.filePaths[0]

  // If this window has no file, load here; otherwise open in new window
  const state = getState(win)
  if (!state.filePath) {
    const ok = await loadFileInWindow(win, filePath)
    if (!ok) return null
    return { path: resolve(filePath), content: await readFile(filePath, 'utf-8') }
  } else {
    openFile(filePath)
    return null
  }
})

ipcMain.handle('open-file-path', async (event, filePath: string) => {
  const win = getWinFromEvent(event)
  if (!win) return null
  const state = getState(win)

  // If this window has no file, load here
  if (!state.filePath) {
    const ok = await loadFileInWindow(win, filePath)
    if (!ok) return null
    return { path: resolve(filePath), content: await readFile(filePath, 'utf-8') }
  } else {
    openFile(filePath)
    return null
  }
})

// Same-directory file panel: list markdown files next to the open file
ipcMain.handle('list-siblings', async (event) => {
  const win = getWinFromEvent(event)
  if (!win) return null
  const state = getState(win)
  if (!state.treeRootPath) return []
  try {
    return (await listTreeDirectory(state.treeRootPath, state.treeRootPath)).entries
  } catch {
    return []
  }
})

// Open a Markdown file or navigate into a directory from the file panel.
ipcMain.handle('open-sibling', async (event, filePath: string) => {
  const win = getWinFromEvent(event)
  if (!win || typeof filePath !== 'string') return false
  try {
    const info = await stat(filePath)
    if (info.isDirectory()) {
      const snapshot = await setTreeRoot(win, filePath)
      if (!win.isDestroyed()) win.webContents.send('siblings-changed', snapshot.entries)
      return true
    }
  } catch {
    return false
  }
  return loadFileInWindow(win, filePath)
})

type TreeResult = {
  ok: boolean
  error?: string
  path?: string
  snapshot?: DirectorySnapshot
}

type TreeContextKind = 'root' | 'directory' | 'file'
type TreeContextCommand = 'create-file' | 'create-directory' | 'duplicate' | 'trash' | 'export-pdf' | 'export-html'

function inputPath(value: unknown): string | null {
  if (typeof value === 'string') return value
  if (value && typeof value === 'object' && typeof (value as { path?: unknown }).path === 'string') {
    return (value as { path: string }).path
  }
  return null
}

function sendTreeDirectoryChanged(directoryPath: string): void {
  for (const [id, state] of windowStates) {
    if (!state.treeRootPath) continue
    const child = relative(state.treeRootPath, directoryPath)
    if (child !== '' && (child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child))) continue
    const win = BrowserWindow.fromId(id)
    if (win && !win.isDestroyed()) win.webContents.send('tree-directory-changed', { path: directoryPath })
  }
}

ipcMain.handle('get-tree-root', async (event): Promise<TreeResult> => {
  const win = getWinFromEvent(event)
  if (!win) return { ok: false, error: '窗口已关闭。' }
  const state = getState(win)
  if (!state.treeRootPath) return { ok: true }
  try {
    const snapshot = await listTreeDirectory(state.treeRootPath, state.treeRootPath)
    return { ok: true, path: state.treeRootPath, snapshot }
  } catch (error) {
    return { ok: false, error: describeTreeError(error) }
  }
})

ipcMain.handle('choose-tree-root', async (event): Promise<TreeResult> => {
  const win = getWinFromEvent(event)
  if (!win) return { ok: false, error: '窗口已关闭。' }
  const state = getState(win)
  const result = await dialog.showOpenDialog(win, {
    defaultPath: state.treeRootPath ?? (state.filePath ? dirname(state.filePath) : undefined),
    properties: ['openDirectory', 'createDirectory']
  })
  if (result.canceled || !result.filePaths[0]) return { ok: false, error: 'canceled' }
  try {
    const snapshot = await setTreeRoot(win, result.filePaths[0])
    return { ok: true, path: snapshot.rootPath, snapshot }
  } catch (error) {
    return { ok: false, error: describeTreeError(error) }
  }
})

ipcMain.handle('set-tree-root', async (event, value: unknown): Promise<TreeResult> => {
  const win = getWinFromEvent(event)
  const path = inputPath(value)
  if (!win || !path) return { ok: false, error: '无效的文件夹路径。' }
  try {
    const snapshot = await setTreeRoot(win, path)
    return { ok: true, path: snapshot.rootPath, snapshot }
  } catch (error) {
    return { ok: false, error: describeTreeError(error) }
  }
})

ipcMain.handle('list-tree-directory', async (event, value: unknown): Promise<TreeResult> => {
  const win = getWinFromEvent(event)
  if (!win) return { ok: false, error: '窗口已关闭。' }
  const state = getState(win)
  const path = inputPath(value) ?? state.treeRootPath
  if (!state.treeRootPath || !path) return { ok: false, error: '尚未选择侧边栏根目录。' }
  try {
    return { ok: true, snapshot: await listTreeDirectory(state.treeRootPath, path) }
  } catch (error) {
    return { ok: false, error: describeTreeError(error) }
  }
})

ipcMain.handle('open-tree-file', async (event, value: unknown): Promise<TreeResult> => {
  const win = getWinFromEvent(event)
  if (!win) return { ok: false, error: '窗口已关闭。' }
  const state = getState(win)
  const path = inputPath(value)
  if (!state.treeRootPath || !path) return { ok: false, error: '无效的文件路径。' }
  try {
    const safePath = await assertSafeTreePath(state.treeRootPath, path, 'file')
    if (!isMarkdownPath(safePath)) return { ok: false, error: '只能从侧边栏打开 Markdown 文档。' }
    if (!await loadFileInWindow(win, safePath)) return { ok: false, error: '无法读取该文档。' }
    return { ok: true, path: safePath }
  } catch (error) {
    return { ok: false, error: describeTreeError(error) }
  }
})

ipcMain.handle('sync-tree-watchers', async (event, value: unknown): Promise<TreeResult> => {
  const win = getWinFromEvent(event)
  if (!win) return { ok: false, error: '窗口已关闭。' }
  const paths = Array.isArray(value)
    ? value.filter((path): path is string => typeof path === 'string')
    : value && typeof value === 'object' && Array.isArray((value as { paths?: unknown }).paths)
      ? (value as { paths: unknown[] }).paths.filter((path): path is string => typeof path === 'string')
      : []
  try {
    await syncTreeWatchers(win, getState(win), paths)
    return { ok: true }
  } catch (error) {
    return { ok: false, error: describeTreeError(error) }
  }
})

function sendTreeContextCommand(
  win: BrowserWindow,
  command: TreeContextCommand,
  kind: TreeContextKind,
  path: string,
  parentPath: string
): void {
  if (!win.isDestroyed()) win.webContents.send('tree-context-command', { command, kind, path, parentPath })
}

ipcMain.handle('show-tree-context-menu', async (event, value: unknown): Promise<TreeResult> => {
  const win = getWinFromEvent(event)
  if (!win || !value || typeof value !== 'object') return { ok: false, error: '无效的菜单目标。' }
  const state = getState(win)
  if (!state.treeRootPath) return { ok: false, error: '尚未选择侧边栏根目录。' }

  const payload = value as { path?: unknown; kind?: unknown; parentPath?: unknown }
  const kind = payload.kind
  if (kind !== 'root' && kind !== 'directory' && kind !== 'file') {
    return { ok: false, error: '无效的菜单目标。' }
  }

  try {
    const path = kind === 'root'
      ? state.treeRootPath
      : await assertSafeTreePath(state.treeRootPath, String(payload.path ?? ''), kind)
    if (kind === 'file' && !isMarkdownPath(path)) return { ok: false, error: '该文件不是 Markdown 文档。' }
    const parentPath = kind === 'file' ? dirname(path) : path
    const command = (value: TreeContextCommand): void => sendTreeContextCommand(win, value, kind, path, parentPath)
    const template: Electron.MenuItemConstructorOptions[] = [
      { label: '新建 Markdown 文档', click: () => command('create-file') },
      { label: '新建文件夹', click: () => command('create-directory') }
    ]
    if (kind === 'file') {
      template.push(
        { type: 'separator' },
        { label: '创建副本', click: () => command('duplicate') },
        { type: 'separator' },
        { label: '导出 PDF…', click: () => command('export-pdf') },
        { label: '导出 HTML…', click: () => command('export-html') }
      )
    }
    if (kind !== 'root' && path !== state.treeRootPath) {
      template.push({ type: 'separator' }, { label: '移到废纸篓', click: () => command('trash') })
    }
    Menu.buildFromTemplate(template).popup({ window: win })
    return { ok: true }
  } catch (error) {
    return { ok: false, error: describeTreeError(error) }
  }
})

ipcMain.handle('create-tree-entry', async (event, value: unknown): Promise<TreeResult> => {
  const win = getWinFromEvent(event)
  if (!win || !value || typeof value !== 'object') return { ok: false, error: '无效的新建请求。' }
  const state = getState(win)
  if (!state.treeRootPath) return { ok: false, error: '尚未选择侧边栏根目录。' }
  const payload = value as { parentPath?: unknown; kind?: unknown; name?: unknown }
  if (typeof payload.parentPath !== 'string' || (payload.kind !== 'file' && payload.kind !== 'directory') || typeof payload.name !== 'string') {
    return { ok: false, error: '无效的新建请求。' }
  }
  try {
    const result = await createTreeEntry(state.treeRootPath, payload.parentPath, payload.kind, payload.name)
    sendTreeDirectoryChanged(result.snapshot.directoryPath)
    return { ok: true, path: result.path, snapshot: result.snapshot }
  } catch (error) {
    return { ok: false, error: describeTreeError(error) }
  }
})

ipcMain.handle('duplicate-tree-file', async (event, value: unknown): Promise<TreeResult> => {
  const win = getWinFromEvent(event)
  const path = inputPath(value)
  if (!win || !path) return { ok: false, error: '无效的文件路径。' }
  const state = getState(win)
  if (!state.treeRootPath) return { ok: false, error: '尚未选择侧边栏根目录。' }
  try {
    const result = await duplicateTreeFile(state.treeRootPath, path)
    sendTreeDirectoryChanged(result.snapshot.directoryPath)
    return { ok: true, path: result.path, snapshot: result.snapshot }
  } catch (error) {
    return { ok: false, error: describeTreeError(error) }
  }
})

function pathIsAffected(openPath: string, targetPath: string, targetIsDirectory: boolean): boolean {
  if (openPath === targetPath) return true
  if (!targetIsDirectory) return false
  const child = relative(targetPath, openPath)
  return child !== '' && child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child)
}

ipcMain.handle('trash-tree-entry', async (event, value: unknown): Promise<TreeResult> => {
  const win = getWinFromEvent(event)
  const path = inputPath(value)
  if (!win || !path) return { ok: false, error: '无效的文件路径。' }
  const state = getState(win)
  if (!state.treeRootPath) return { ok: false, error: '尚未选择侧边栏根目录。' }

  try {
    const safePath = await assertSafeTreePath(state.treeRootPath, path)
    if (safePath === state.treeRootPath) return { ok: false, error: '不能删除侧边栏根目录。' }
    const info = await stat(safePath)
    if (!info.isFile() && !info.isDirectory()) return { ok: false, error: '只能删除文件或文件夹。' }
    if (info.isFile() && !isMarkdownPath(safePath)) return { ok: false, error: '只能删除 Markdown 文档。' }

    const affectedWindows: Array<{ win: BrowserWindow; state: WindowState; oldPath: string }> = []
    for (const [id, otherState] of windowStates) {
      if (!otherState.filePath || !pathIsAffected(otherState.filePath, safePath, info.isDirectory())) continue
      const otherWin = BrowserWindow.fromId(id)
      if (!otherWin) continue
      if (id !== win.id && otherState.documentDirty) {
        return { ok: false, error: '该内容正在另一个窗口中编辑且尚未保存，无法删除。' }
      }
      affectedWindows.push({ win: otherWin, state: otherState, oldPath: otherState.filePath })
    }

    const parentPath = dirname(safePath)
    await shell.trashItem(safePath)
    for (const affected of affectedWindows) {
      stopFileWatching(affected.state)
      affected.state.filePath = null
      affected.state.documentDirty = true
      updateTitle(affected.win)
      if (!affected.win.isDestroyed()) affected.win.webContents.send('file-detached', { path: affected.oldPath })
    }

    for (const [id, otherState] of windowStates) {
      if (!otherState.treeRootPath || !pathIsAffected(otherState.treeRootPath, safePath, info.isDirectory())) continue
      stopTreeWatchers(otherState)
      otherState.treeRootPath = null
      const otherWin = BrowserWindow.fromId(id)
      if (otherWin && !otherWin.isDestroyed()) otherWin.webContents.send('tree-root-changed', { path: null })
    }

    const snapshot = await listTreeDirectory(state.treeRootPath, parentPath)
    sendTreeDirectoryChanged(parentPath)
    return { ok: true, path: safePath, snapshot }
  } catch (error) {
    return { ok: false, error: describeTreeError(error) }
  }
})

ipcMain.handle('set-document-dirty', async (event, value: unknown): Promise<TreeResult> => {
  const win = getWinFromEvent(event)
  if (!win) return { ok: false, error: '窗口已关闭。' }
  const dirty = typeof value === 'boolean'
    ? value
    : Boolean(value && typeof value === 'object' && (value as { dirty?: unknown }).dirty)
  getState(win).documentDirty = dirty
  return { ok: true }
})

ipcMain.handle('export-tree-file', async (event, value: unknown): Promise<TreeResult> => {
  const win = getWinFromEvent(event)
  if (!win || !value || typeof value !== 'object') return { ok: false, error: '无效的导出请求。' }
  const state = getState(win)
  if (!state.treeRootPath) return { ok: false, error: '尚未选择侧边栏根目录。' }
  const payload = value as { path?: unknown; format?: unknown }
  if (typeof payload.path !== 'string' || (payload.format !== 'pdf' && payload.format !== 'html')) {
    return { ok: false, error: '无效的导出请求。' }
  }

  let exportWin: BrowserWindow | null = null
  try {
    const sourcePath = await assertSafeTreePath(state.treeRootPath, payload.path, 'file')
    if (!isMarkdownPath(sourcePath)) return { ok: false, error: '只能导出 Markdown 文档。' }

    for (const otherState of windowStates.values()) {
      if (otherState.filePath === sourcePath && otherState.documentDirty) {
        return { ok: false, error: '该文档在另一个窗口中有未保存修改，请从那个窗口导出。' }
      }
    }

    const baseName = basename(sourcePath, extname(sourcePath))
    const extension = payload.format === 'pdf' ? 'pdf' : 'html'
    const saveResult = await dialog.showSaveDialog(win, {
      defaultPath: join(dirname(sourcePath), `${baseName}.${extension}`),
      filters: [{ name: payload.format === 'pdf' ? 'PDF' : 'HTML', extensions: [extension] }]
    })
    // Cancel is a completed no-op, not an error that should produce an alert.
    if (saveResult.canceled || !saveResult.filePath) return { ok: true }

    const source = await readFile(sourcePath, 'utf-8')
    exportWin = await createExportWindow()
    const snapshot = await renderExportSnapshot(exportWin, sourcePath, resolveImagePaths(source, sourcePath))

    if (payload.format === 'pdf') {
      await writeWindowPDF(exportWin, saveResult.filePath)
    } else {
      await writeFile(saveResult.filePath, renderHTMLDocument(snapshot, baseName), 'utf-8')
    }
    shell.showItemInFolder(saveResult.filePath)
    return { ok: true, path: saveResult.filePath }
  } catch (error) {
    return { ok: false, error: describeTreeError(error) }
  } finally {
    if (exportWin && !exportWin.isDestroyed()) exportWin.destroy()
  }
})

ipcMain.handle('save-file', async (event, content: string) => {
  const win = getWinFromEvent(event)
  if (!win) return null
  const state = getState(win)
  if (!state.filePath) {
    const result = await dialog.showSaveDialog(win, {
      defaultPath: suggestFileName(win, content),
      filters: [
        { name: 'Markdown', extensions: ['md'] },
        { name: 'All Files', extensions: ['*'] }
      ]
    })
    if (result.canceled || !result.filePath) return null
    state.filePath = result.filePath
  }
  const ok = await saveToPath(win, state.filePath, content)
  return ok ? state.filePath : null
})

ipcMain.handle('save-file-as', async (event, content: string) => {
  const win = getWinFromEvent(event)
  if (!win) return null
  const result = await dialog.showSaveDialog(win, {
    defaultPath: suggestFileName(win, content),
    filters: [
      { name: 'Markdown', extensions: ['md'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  })
  if (result.canceled || !result.filePath) return null
  const ok = await saveToPath(win, result.filePath, content)
  return ok ? result.filePath : null
})

async function writeWindowPDF(win: BrowserWindow, outputPath: string): Promise<void> {
  let cssKey: string | null = null
  try {
    // Expand editor to full content height for printing
    cssKey = await win.webContents.insertCSS(
      'html, body { height: auto !important; overflow: visible !important; } #titlebar { display: none !important; } #editor { height: auto !important; overflow: visible !important; } #editor .ProseMirror { min-height: auto !important; }'
    )
    const pdfData = await win.webContents.printToPDF({
      margins: { marginType: 'default' },
      printBackground: true,
      pageSize: 'A4'
    })
    await writeFile(outputPath, pdfData)
  } finally {
    if (cssKey && !win.isDestroyed()) await win.webContents.removeInsertedCSS(cssKey).catch(() => undefined)
  }
}

ipcMain.handle('export-pdf', async (event) => {
  const win = getWinFromEvent(event)
  if (!win) return false
  const defaultName = suggestFileName(win) ?? 'untitled'
  const result = await dialog.showSaveDialog(win, {
    defaultPath: `${defaultName}.pdf`,
    filters: [{ name: 'PDF', extensions: ['pdf'] }]
  })
  if (result.canceled || !result.filePath) return false

  try {
    await writeWindowPDF(win, result.filePath)
    return true
  } catch {
    return false
  }
})

function escapeHTML(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[char] ?? char)
}

function renderHTMLDocument(snapshot: ExportSnapshot, baseName: string): string {
  const title = escapeHTML(baseName)
  const bodyClass = escapeHTML(snapshot.bodyClass)
  const renderedContent = snapshot.html || `<pre>${escapeHTML(snapshot.content)}</pre>`
  const exportStyles = snapshot.styles || ''
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  <style>${exportStyles}
    html, body { height: auto; overflow: visible; }
    body { min-width: 320px; }
    #titlebar, #file-panel, #source-editor { display: none !important; }
    #editor { height: auto !important; min-height: 100vh; overflow: visible !important; padding: 40px !important; }
  </style>
</head>
<body class="${bodyClass}">
  <div id="editor"><div class="ProseMirror">${renderedContent}</div></div>
</body>
</html>
`
}

ipcMain.handle('export-html', async (event, snapshot: {
  content: string
  html: string
  styles: string
  bodyClass: string
}) => {
  const win = getWinFromEvent(event)
  if (!win || !isExportSnapshot(snapshot)) return false
  const baseName = suggestFileName(win, snapshot.content) ?? 'untitled'
  const result = await dialog.showSaveDialog(win, {
    defaultPath: `${baseName}.html`,
    filters: [{ name: 'HTML', extensions: ['html'] }]
  })
  if (result.canceled || !result.filePath) return false

  try {
    await writeFile(result.filePath, renderHTMLDocument(snapshot, baseName), 'utf-8')
    shell.showItemInFolder(result.filePath)
    return true
  } catch {
    return false
  }
})

// Bundled Markdown documents open in an in-memory window. This keeps Help
// useful even in a signed/read-only app bundle and avoids starting a watcher.
async function openBundledDocument(fileName: string): Promise<void> {
  try {
    const content = await readFile(join(demoDir, fileName), 'utf-8')
    createWindow(undefined, content, demoDir)
  } catch {
    createWindow(undefined, undefined, demoDir)
  }
}

async function openCheatsheet(language: 'zh' | 'en' = 'zh'): Promise<void> {
  try {
    const fileName = language === 'en' ? 'cheatsheet-en.md' : 'cheatsheet.md'
    const content = await readFile(join(cheatsheetDir, fileName), 'utf-8')
    createWindow(undefined, content, demoDir)
  } catch {
    createWindow(undefined, undefined, demoDir)
  }
}

ipcMain.handle('load-custom-theme', async (event) => {
  const win = getWinFromEvent(event)
  if (!win) return null
  const result = await dialog.showOpenDialog(win, {
    filters: [{ name: 'CSS', extensions: ['css'] }],
    properties: ['openFile']
  })
  if (result.canceled || result.filePaths.length === 0) return null

  try {
    const srcPath = result.filePaths[0]
    const fileName = basename(srcPath)
    const destPath = join(themesDir, fileName)
    await copyFile(srcPath, destPath)
    const css = await readFile(destPath, 'utf-8')
    buildMenu() // rebuild menu to include new theme
    return { name: fileName, css }
  } catch {
    return null
  }
})

ipcMain.handle('load-theme-css', async (_event, fileName: string) => {
  try {
    return await readFile(join(themesDir, fileName), 'utf-8')
  } catch {
    return null
  }
})

// Menu — targets the focused window

function setAsDefaultApp(): void {
  if (process.platform !== 'darwin') {
    dialog.showMessageBox({
      type: 'info',
      message: 'This feature is available on macOS only.'
    })
    return
  }

  const script = `
    ObjC.import('CoreServices');
    var bundleID = '${APP_BUNDLE_ID}';
    var exts = ['md', 'markdown', 'mdown', 'mkd', 'txt'];
    var results = [];
    for (var i = 0; i < exts.length; i++) {
      var ext = exts[i];
      try {
        var uti = $.UTTypeCreatePreferredIdentifierForTag(
          $.kUTTagClassFilenameExtension,
          $(ext),
          null
        ).takeRetainedValue();
        $.LSSetDefaultRoleHandlerForContentType(uti, $.kLSRolesAll, $(bundleID));
        results.push(ext + ': OK');
      } catch (e) {
        results.push(ext + ': ' + e.message);
      }
    }
    JSON.stringify(results);
  `

  execFile('osascript', ['-l', 'JavaScript', '-e', script], (error, stdout, stderr) => {
    if (error) {
      dialog.showMessageBox({
        type: 'error',
        message: `Failed to set ${APP_DISPLAY_NAME} as the default app.`,
        detail: stderr || error.message
      })
      return
    }
    try {
      const results: string[] = JSON.parse(stdout.trim())
      const allOk = results.every((r) => r.endsWith(': OK'))
      dialog.showMessageBox({
        type: 'info',
        message: allOk
          ? `${APP_DISPLAY_NAME} is now the default app for Markdown and text files.`
          : 'Some file types could not be associated. System Settings may need manual adjustment.',
        detail: results.join('\n')
      })
    } catch {
      dialog.showMessageBox({
        type: 'info',
        message: 'Default app request sent. You may need to confirm in the system dialog.'
      })
    }
  })
}

function getFocusedWindow(): BrowserWindow | null {
  return BrowserWindow.getFocusedWindow()
}

function getPreferredCheatsheetLanguage(): 'zh' | 'en' {
  return app.getLocale().toLowerCase().startsWith('zh') ? 'zh' : 'en'
}

let latestVersion: string | null = null

function sendToFocused(channel: string, ...args: unknown[]): void {
  const win = getFocusedWindow()
  if (win) win.webContents.send(channel, ...args)
}

function buildMenu(): void {
  const isMac = process.platform === 'darwin'

  // Scan custom themes synchronously for menu building
  const customThemeItems: Electron.MenuItemConstructorOptions[] = []
  try {
    const files = readdirSync(themesDir).filter((f: string) => f.endsWith('.css')).sort()
    for (const file of files) {
      customThemeItems.push({
        label: file.replace(/\.css$/, ''),
        click: async () => {
          try {
            const css = await readFile(join(themesDir, file), 'utf-8')
            sendToFocused('set-theme', `custom:${file}`)
            sendToFocused('set-custom-css', css)
          } catch { /* ignore */ }
        }
      })
    }
  } catch { /* themes dir may not exist yet */ }

  const preferredCheatsheetLanguage = getPreferredCheatsheetLanguage()
  const labels = preferredCheatsheetLanguage === 'zh'
    ? {
        file: '文件', edit: '编辑', view: '视图', theme: '主题', help: '帮助',
        newFile: '新建', open: '打开...', save: '保存', saveAs: '另存为...',
        exportPDF: '导出 PDF...', exportHTML: '导出 HTML...', find: '查找',
        setDefault: '设置为默认应用...',
        insertFormula: '插入公式', filePanel: '显示 / 隐藏文件列表',
        light: '浅色', dark: '深色', elegant: '雅致',
        sepia: '羊皮纸', notion: '简白', bear: '熊红', writer: '作家',
        solarizedDark: '夜航', nord: '极地', gruvbox: '暖木', dracula: '德古拉', midnight: '午夜',
        importTheme: '导入主题...', whatsNew: '新功能演示',
        cheatsheet: 'Markdown 语法', about: `关于 ${APP_DISPLAY_NAME}`, updateAvailable: '发现新版本', close: '关闭窗口',
        undo: '撤销', redo: '重做', cut: '剪切', copy: '复制', paste: '粘贴', selectAll: '全选',
        actualSize: '实际大小', zoomIn: '放大', zoomOut: '缩小', fullscreen: '切换全屏',
        hide: `隐藏 ${APP_DISPLAY_NAME}`, hideOthers: '隐藏其他应用', showAll: '显示全部', quit: `退出 ${APP_DISPLAY_NAME}`,
      }
    : {
        file: 'File', edit: 'Edit', view: 'View', theme: 'Theme', help: 'Help',
        newFile: 'New', open: 'Open...', save: 'Save', saveAs: 'Save As...',
        exportPDF: 'Export PDF...', exportHTML: 'Export HTML...', find: 'Find',
        setDefault: 'Set as Default...',
        insertFormula: 'Insert Formula', filePanel: 'Show / Hide File List',
        light: 'Light', dark: 'Dark', elegant: 'Elegant',
        sepia: 'Sepia', notion: 'Notion', bear: 'Bear', writer: 'Writer',
        solarizedDark: 'Solarized Dark', nord: 'Nord', gruvbox: 'Gruvbox', dracula: 'Dracula', midnight: 'Midnight',
        importTheme: 'Import Theme...', whatsNew: "What's New",
        cheatsheet: 'Markdown Syntax', about: `About ${APP_DISPLAY_NAME}`, updateAvailable: 'Update Available', close: 'Close Window',
        undo: 'Undo', redo: 'Redo', cut: 'Cut', copy: 'Copy', paste: 'Paste', selectAll: 'Select All',
        actualSize: 'Actual Size', zoomIn: 'Zoom In', zoomOut: 'Zoom Out', fullscreen: 'Toggle Full Screen',
        hide: `Hide ${APP_DISPLAY_NAME}`, hideOthers: 'Hide Others', showAll: 'Show All', quit: `Quit ${APP_DISPLAY_NAME}`,
      }

  const themeSubmenu: Electron.MenuItemConstructorOptions[] = [
    { label: labels.light, click: () => sendToFocused('set-theme', 'light') },
    { label: labels.elegant, click: () => sendToFocused('set-theme', 'elegant') },
    { label: labels.notion, click: () => sendToFocused('set-theme', 'notion') },
    { label: labels.writer, click: () => sendToFocused('set-theme', 'writer') },
    { label: labels.bear, click: () => sendToFocused('set-theme', 'bear') },
    { label: labels.sepia, click: () => sendToFocused('set-theme', 'sepia') },
    { type: 'separator' },
    { label: labels.dark, click: () => sendToFocused('set-theme', 'dark') },
    { label: labels.gruvbox, click: () => sendToFocused('set-theme', 'gruvbox') },
    { label: labels.midnight, click: () => sendToFocused('set-theme', 'midnight') },
    { label: labels.solarizedDark, click: () => sendToFocused('set-theme', 'solarized-dark') },
    { label: labels.nord, click: () => sendToFocused('set-theme', 'nord') },
    { label: labels.dracula, click: () => sendToFocused('set-theme', 'dracula') },
  ]
  if (customThemeItems.length > 0) {
    themeSubmenu.push({ type: 'separator' }, ...customThemeItems)
  }
  themeSubmenu.push({ type: 'separator' }, {
    label: labels.importTheme,
    click: () => sendToFocused('menu-import-theme')
  })

  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac ? [{
      label: APP_DISPLAY_NAME,
      submenu: [
        { label: labels.about, role: 'about' as const },
        { type: 'separator' as const },
        { label: labels.hide, role: 'hide' as const },
        { label: labels.hideOthers, role: 'hideOthers' as const },
        { label: labels.showAll, role: 'unhide' as const },
        { type: 'separator' as const },
        { label: labels.quit, role: 'quit' as const }
      ]
    }] : []),
    {
      label: labels.file,
      submenu: [
        {
          label: labels.newFile,
          accelerator: 'CmdOrCtrl+N',
          click: () => createWindow()
        },
        {
          label: labels.open,
          accelerator: 'CmdOrCtrl+O',
          click: () => sendToFocused('menu-open')
        },
        { type: 'separator' },
        {
          label: labels.save,
          accelerator: 'CmdOrCtrl+S',
          click: () => sendToFocused('menu-save')
        },
        {
          label: labels.saveAs,
          accelerator: 'CmdOrCtrl+Shift+S',
          click: () => sendToFocused('menu-save-as')
        },
        { type: 'separator' },
        {
          label: labels.exportPDF,
          click: () => sendToFocused('menu-export-pdf')
        },
        {
          label: labels.exportHTML,
          click: () => sendToFocused('menu-export-html')
        },
        { type: 'separator' },
        {
          label: labels.setDefault,
          click: () => setAsDefaultApp()
        },
        { type: 'separator' },
        isMac ? { label: labels.close, role: 'close' } : { label: labels.quit, role: 'quit' }
      ]
    },
    {
      label: labels.edit,
      submenu: [
        { label: labels.undo, role: 'undo' },
        { label: labels.redo, role: 'redo' },
        { type: 'separator' },
        { label: labels.cut, role: 'cut' },
        { label: labels.copy, role: 'copy' },
        { label: labels.paste, role: 'paste' },
        { label: labels.selectAll, role: 'selectAll' },
        { type: 'separator' },
        {
          label: labels.find,
          accelerator: 'CmdOrCtrl+F',
          click: () => sendToFocused('editor:search')
        },
        {
          label: labels.insertFormula,
          accelerator: 'CmdOrCtrl+Shift+E',
          click: () => sendToFocused('editor:math')
        }
      ]
    },
    {
      label: labels.view,
      submenu: [
        { label: labels.actualSize, role: 'resetZoom' },
        { label: labels.zoomIn, role: 'zoomIn' },
        { label: labels.zoomOut, role: 'zoomOut' },
        { type: 'separator' },
        {
          label: labels.filePanel,
          accelerator: 'CmdOrCtrl+Shift+B',
          click: () => sendToFocused('toggle-file-panel')
        },
        { type: 'separator' },
        { label: labels.fullscreen, role: 'togglefullscreen' }
      ]
    },
    {
      label: labels.theme,
      submenu: themeSubmenu
    },
    {
      label: labels.help,
      submenu: [
        {
          label: labels.whatsNew,
          accelerator: 'CmdOrCtrl+Shift+D',
          click: () => { void openBundledDocument('changelog.md') }
        },
        {
          label: labels.cheatsheet,
          accelerator: 'CmdOrCtrl+Shift+/',
          click: () => { void openCheatsheet(preferredCheatsheetLanguage) }
        },
        {
          label: latestVersion ? `${labels.updateAvailable} v${latestVersion}` : labels.about,
          click: () => shell.openExternal(latestVersion ? 'https://colamd.com/' : 'https://github.com/marswaveai/colamd')
        }
      ]
    }
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

// --- Auto update (weak, non-blocking) ---
function setupAutoUpdater(): void {
  if (!app.isPackaged) return

  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true

  const broadcast = (channel: string, version: string): void => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(channel, version)
    }
  }

  autoUpdater.on('update-available', (info) => {
    latestVersion = info.version
    buildMenu()
    broadcast('update-available', info.version)
  })
  autoUpdater.on('update-downloaded', (info) => broadcast('update-downloaded', info.version))
  autoUpdater.on('error', (err) => console.error('autoUpdater:', err.message))

  // Defer the first check so it never delays startup.
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch(() => {})
  }, 8000)
}

ipcMain.handle('download-update', async () => {
  await autoUpdater.downloadUpdate()
})

ipcMain.handle('install-update', () => {
  autoUpdater.quitAndInstall(false, true)
})

// App lifecycle

app.whenReady().then(() => {
  ensureThemesDir()
  buildMenu()

  // Check command line args for file paths
  const args = process.argv.slice(app.isPackaged ? 1 : 2)
  const fileArgs = args.filter((arg) => !arg.startsWith('-'))
  if (fileArgs.length > 0) {
    pendingFilePaths = fileArgs
  }

  if (pendingFilePaths.length > 0) {
    for (const fp of pendingFilePaths) {
      createWindow(fp)
    }
    pendingFilePaths = []
  } else {
    // Start with an empty editor and no directory scan. Bundled examples stay
    // available from Help and are loaded only when explicitly requested.
    createWindow()
  }

  setupAutoUpdater()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('open-file', (event, filePath) => {
  event.preventDefault()
  if (app.isReady()) {
    openFile(filePath)
  } else {
    pendingFilePaths.push(filePath)
  }
})
