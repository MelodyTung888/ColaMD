import { app, BrowserWindow, ipcMain, dialog, Menu, shell } from 'electron'
import { join, basename, dirname, extname, isAbsolute, resolve, relative } from 'path'
import { fileURLToPath, pathToFileURL } from 'url'
import { readFile, writeFile, readdir, copyFile, mkdir, stat } from 'fs/promises'
import { watch, FSWatcher, existsSync, readdirSync } from 'fs'

// Custom themes directory
const themesDir = join(app.getPath('home'), '.colamd', 'themes')

const MARKDOWN_EXTENSIONS = ['.md', '.markdown', '.mdown', '.mkd']

interface SiblingFile {
  name: string
  path: string
  kind: 'file' | 'directory' | 'parent'
}

function getDefaultBrowsePath(): string {
  const documentsPath = app.getPath('documents')
  return existsSync(documentsPath) ? documentsPath : app.getPath('desktop')
}

// Browse Markdown files in the current directory. Directories are kept as
// navigable entries rather than flattening the whole tree into one list.
async function listSiblingFiles(filePath: string | null, browseDir?: string): Promise<SiblingFile[]> {
  const dir = browseDir ?? (filePath ? dirname(filePath) : getDefaultBrowsePath())
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    const result: SiblingFile[] = []
    const parent = dirname(dir)
    if (parent !== dir) result.push({ name: '..', path: parent, kind: 'parent' })

    result.push(
      ...entries
        .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
        .map((e) => ({ name: e.name, path: join(dir, e.name), kind: 'directory' as const }))
        .sort((a, b) => a.name.localeCompare(b.name))
    )
    result.push(
      ...entries
        .filter((e) => e.isFile() && MARKDOWN_EXTENSIONS.includes(extname(e.name).toLowerCase()))
        .map((e) => ({ name: e.name, path: join(dir, e.name), kind: 'file' as const }))
        .sort((a, b) => a.name.localeCompare(b.name))
    )
    return result
  } catch {
    return []
  }
}

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
  browsePath: string | null
  watcher: FSWatcher | null
  isInternalSave: boolean
  debounceTimer: ReturnType<typeof setTimeout> | null
  siblingsTimer: ReturnType<typeof setTimeout> | null
  agentState: 'idle' | 'active' | 'cooldown'
  lastExternalChange: number
  agentCooldownTimer: ReturnType<typeof setTimeout> | null
}

const windowStates = new Map<number, WindowState>()
let pendingFilePaths: string[] = []

function getState(win: BrowserWindow): WindowState {
  let state = windowStates.get(win.id)
  if (!state) {
    state = { filePath: null, browsePath: getDefaultBrowsePath(), watcher: null, isInternalSave: false, debounceTimer: null, siblingsTimer: null, agentState: 'idle', lastExternalChange: 0, agentCooldownTimer: null }
    windowStates.set(win.id, state)
  }
  return state
}

function getWinFromEvent(event: Electron.IpcMainInvokeEvent): BrowserWindow | null {
  return BrowserWindow.fromWebContents(event.sender)
}

function createWindow(filePath?: string, initialContent?: string): BrowserWindow {
  const win = new BrowserWindow({
    width: 960,
    height: 720,
    minWidth: 600,
    minHeight: 400,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 16 },
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
    if (filePath) {
      loadFileInWindow(win, filePath)
    } else if (initialContent) {
      // In-memory content (e.g. the Markdown cheatsheet) — no file, no watcher
      win.webContents.send('file-opened', { path: null, content: initialContent })
    }
  })

  win.on('closed', () => {
    stopWatching(state)
    windowStates.delete(win.id)
  })

  updateTitle(win)
  return win
}

function updateTitle(win: BrowserWindow): void {
  const state = getState(win)
  const fileName = state.filePath ? basename(state.filePath) : 'Untitled'
  win.setTitle(`${fileName} — ColaMD`)
}

function suggestFileName(win: BrowserWindow, content?: string): string | undefined {
  const state = getState(win)
  if (state.filePath) return basename(state.filePath, '.md')
  if (!content) return undefined
  // Extract first heading or first non-empty line
  const match = content.match(/^#\s+(.+)/m) || content.match(/^(.+)/m)
  if (!match) return undefined
  return match[1].trim().replace(/[/\\:*?"<>|]/g, '').slice(0, 60) || undefined
}

function stopWatching(state: WindowState): void {
  if (state.watcher) {
    state.watcher.close()
    state.watcher = null
  }
  if (state.agentCooldownTimer) {
    clearTimeout(state.agentCooldownTimer)
    state.agentCooldownTimer = null
  }
  state.agentState = 'idle'
  state.lastExternalChange = 0
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
  if (state.watcher) {
    state.watcher.close()
    state.watcher = null
  }

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

  // Agent created/renamed/deleted a sibling file — refresh the file panel list
  const scheduleSiblingsRefresh = (): void => {
    if (state.siblingsTimer) clearTimeout(state.siblingsTimer)
    state.siblingsTimer = setTimeout(() => {
      state.siblingsTimer = null
      if (state.filePath !== filePath) return // file switched meanwhile; new watcher handles it
      listSiblingFiles(filePath, state.browsePath ?? dirname(filePath)).then((files) => {
        if (!win.isDestroyed()) win.webContents.send('siblings-changed', files)
      })
    }, 300)
  }

  const establish = (): void => {
    if (state.filePath !== filePath) return
    suppressUntil = Date.now() + 300
    if (state.watcher) {
      state.watcher.close()
      state.watcher = null
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
          // A sibling file changed (agent created / renamed / deleted it)
          if (MARKDOWN_EXTENSIONS.includes(extname(filename).toLowerCase())) {
            scheduleSiblingsRefresh()
          }
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
      state.watcher = watcher
    } catch {
      // Fallback: watch the file directly if the directory isn't watchable
      try {
        const watcher = watch(filePath, (eventType) => {
          if (eventType !== 'change' || state.isInternalSave) return
          onExternalChange()
        })
        watcher.on('error', () => establish())
        state.watcher = watcher
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

function loadFileInWindow(win: BrowserWindow, filePath: string): void {
  readFile(filePath, 'utf-8')
    .then((data) => {
      const state = getState(win)
      state.filePath = filePath
      state.browsePath = dirname(filePath)
      watchFile(win, state)
      updateTitle(win)
      win.webContents.send('file-opened', { path: filePath, content: resolveImagePaths(data, filePath) })
    })
    .catch(() => {})
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
    loadFileInWindow(emptyWin, filePath)
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
    state.isInternalSave = true
    await writeFile(filePath, restoreImagePaths(content, filePath), 'utf-8')
    state.filePath = filePath
    state.browsePath = dirname(filePath)
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
    try {
      const content = await readFile(filePath, 'utf-8')
      state.filePath = filePath
      state.browsePath = dirname(filePath)
      watchFile(win, state)
      updateTitle(win)
      win.webContents.send('file-opened', { path: filePath, content: resolveImagePaths(content, filePath) })
      return { path: filePath, content }
    } catch {
      return null
    }
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
    try {
      const content = await readFile(filePath, 'utf-8')
      state.filePath = filePath
      state.browsePath = dirname(filePath)
      watchFile(win, state)
      updateTitle(win)
      win.webContents.send('file-opened', { path: filePath, content: resolveImagePaths(content, filePath) })
      return { path: filePath, content }
    } catch {
      return null
    }
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
  return listSiblingFiles(state.filePath, state.browsePath ?? undefined)
})

// Open a Markdown file or navigate into a directory from the file panel.
ipcMain.handle('open-sibling', async (event, filePath: string) => {
  const win = getWinFromEvent(event)
  if (!win || typeof filePath !== 'string') return false
  try {
    const info = await stat(filePath)
    const state = getState(win)
    if (info.isDirectory()) {
      state.browsePath = filePath
      const files = await listSiblingFiles(state.filePath, filePath)
      if (!win.isDestroyed()) win.webContents.send('siblings-changed', files)
      return true
    }
  } catch {
    return false
  }
  loadFileInWindow(win, filePath)
  return true
})

ipcMain.handle('save-file', async (event, content: string) => {
  const win = getWinFromEvent(event)
  if (!win) return false
  const state = getState(win)
  if (!state.filePath) {
    const result = await dialog.showSaveDialog(win, {
      defaultPath: suggestFileName(win, content),
      filters: [
        { name: 'Markdown', extensions: ['md'] },
        { name: 'All Files', extensions: ['*'] }
      ]
    })
    if (result.canceled || !result.filePath) return false
    state.filePath = result.filePath
  }
  return saveToPath(win, state.filePath, content)
})

ipcMain.handle('save-file-as', async (event, content: string) => {
  const win = getWinFromEvent(event)
  if (!win) return false
  const result = await dialog.showSaveDialog(win, {
    defaultPath: suggestFileName(win, content),
    filters: [
      { name: 'Markdown', extensions: ['md'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  })
  if (result.canceled || !result.filePath) return false
  return saveToPath(win, result.filePath, content)
})

ipcMain.handle('export-pdf', async (event) => {
  const win = getWinFromEvent(event)
  if (!win) return false
  const result = await dialog.showSaveDialog(win, {
    defaultPath: suggestFileName(win),
    filters: [{ name: 'PDF', extensions: ['pdf'] }]
  })
  if (result.canceled || !result.filePath) return false

  try {
    // Expand editor to full content height for printing
    const cssKey = await win.webContents.insertCSS(
      'html, body { height: auto !important; overflow: visible !important; } #titlebar { display: none !important; } #editor { height: auto !important; overflow: visible !important; } #editor .ProseMirror { min-height: auto !important; }'
    )
    const pdfData = await win.webContents.printToPDF({
      margins: { marginType: 'default' },
      printBackground: true,
      pageSize: 'A4'
    })
    await win.webContents.removeInsertedCSS(cssKey)
    await writeFile(result.filePath, pdfData)
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

ipcMain.handle('export-html', async (event, snapshot: {
  content: string
  html: string
  styles: string
  bodyClass: string
}) => {
  const win = getWinFromEvent(event)
  if (!win) return false
  const baseName = suggestFileName(win, snapshot.content) ?? 'untitled'
  const result = await dialog.showSaveDialog(win, {
    defaultPath: `${baseName}.html`,
    filters: [{ name: 'HTML', extensions: ['html'] }]
  })
  if (result.canceled || !result.filePath) return false

  const title = escapeHTML(baseName)
  const bodyClass = escapeHTML(snapshot.bodyClass)
  const renderedContent = snapshot.html || `<pre>${escapeHTML(snapshot.content)}</pre>`
  const exportStyles = snapshot.styles || ''
  const documentHTML = `<!doctype html>
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

  try {
    await writeFile(result.filePath, documentHTML, 'utf-8')
    shell.showItemInFolder(result.filePath)
    return true
  } catch {
    return false
  }
})

// What's-new demo page: a playable changelog directory (changelog.md + demo files)
const demoDir = app.isPackaged
  ? join(process.resourcesPath, 'demo')
  : join(__dirname, '../../resources/demo')

// Markdown cheatsheet shown via Help > Markdown 语法速查
const cheatsheetPath = app.isPackaged
  ? join(process.resourcesPath, 'templates', 'cheatsheet.md')
  : join(__dirname, '../../resources/templates/cheatsheet.md')

async function openCheatsheet(): Promise<void> {
  try {
    const content = await readFile(cheatsheetPath, 'utf-8')
    createWindow(undefined, content)
  } catch {
    createWindow()
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

function getFocusedWindow(): BrowserWindow | null {
  return BrowserWindow.getFocusedWindow()
}

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

  const themeSubmenu: Electron.MenuItemConstructorOptions[] = [
    { label: 'Light', click: () => sendToFocused('set-theme', 'light') },
    { label: 'Dark', click: () => sendToFocused('set-theme', 'dark') },
    { label: 'Elegant', click: () => sendToFocused('set-theme', 'elegant') },
    { label: 'Newsprint', click: () => sendToFocused('set-theme', 'newsprint') },
  ]
  if (customThemeItems.length > 0) {
    themeSubmenu.push({ type: 'separator' }, ...customThemeItems)
  }
  themeSubmenu.push({ type: 'separator' }, {
    label: 'Import Theme...',
    click: () => sendToFocused('menu-import-theme')
  })

  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac ? [{
      label: 'ColaMD',
      submenu: [
        { role: 'about' as const },
        { type: 'separator' as const },
        { role: 'hide' as const },
        { role: 'hideOthers' as const },
        { role: 'unhide' as const },
        { type: 'separator' as const },
        { role: 'quit' as const }
      ]
    }] : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'New',
          accelerator: 'CmdOrCtrl+N',
          click: () => createWindow()
        },
        {
          label: 'Open...',
          accelerator: 'CmdOrCtrl+O',
          click: () => sendToFocused('menu-open')
        },
        { type: 'separator' },
        {
          label: 'Save',
          accelerator: 'CmdOrCtrl+S',
          click: () => sendToFocused('menu-save')
        },
        {
          label: 'Save As...',
          accelerator: 'CmdOrCtrl+Shift+S',
          click: () => sendToFocused('menu-save-as')
        },
        { type: 'separator' },
        {
          label: 'Export PDF...',
          click: () => sendToFocused('menu-export-pdf')
        },
        {
          label: 'Export HTML...',
          click: () => sendToFocused('menu-export-html')
        },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
        { type: 'separator' },
        {
          label: 'Find',
          accelerator: 'CmdOrCtrl+F',
          click: () => sendToFocused('editor:search')
        },
        {
          label: 'Insert Formula',
          accelerator: 'CmdOrCtrl+Shift+E',
          click: () => sendToFocused('editor:math')
        }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        {
          label: '显示 / 隐藏文件列表',
          accelerator: 'CmdOrCtrl+Shift+B',
          click: () => sendToFocused('toggle-file-panel')
        },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Theme',
      submenu: themeSubmenu
    },
    {
      label: 'Help',
      submenu: [
        {
          label: '新功能演示',
          accelerator: 'CmdOrCtrl+Shift+D',
          click: () => openFile(join(demoDir, 'changelog.md'))
        },
        {
          label: 'Markdown 语法速查',
          accelerator: 'CmdOrCtrl+Shift+/',
          click: () => openCheatsheet()
        },
        {
          label: 'About ColaMD',
          click: () => shell.openExternal('https://github.com/marswaveai/colamd')
        }
      ]
    }
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

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
    createWindow()
  }

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
