import type {
  DirectorySnapshot,
  ElectronAPI,
  TreeContextCommand,
  TreeContextTarget,
  TreeEntry,
  TreeEntryKind,
  TreeOperationResult,
} from '../preload/index'

type ExportFormat = 'pdf' | 'html'

interface FileTreeOptions {
  api: ElectronAPI
  panel: HTMLElement
  tree: HTMLUListElement
  rootLabel: HTMLElement
  rootUpButton: HTMLButtonElement
  chooseRootButton: HTMLButtonElement
  status: HTMLElement
  onOpenFile: (path: string) => Promise<boolean | void>
  onExportFile: (path: string, format: ExportFormat) => Promise<void>
}

const svgNamespace = 'http://www.w3.org/2000/svg'

function normalizedPath(path: string): string {
  if (path === '/') return path
  return path.replace(/\/+$/, '')
}

function parentPath(path: string): string {
  const normalized = normalizedPath(path)
  const splitAt = normalized.lastIndexOf('/')
  if (splitAt <= 0) return '/'
  return normalized.slice(0, splitAt)
}

function pathName(path: string): string {
  const normalized = normalizedPath(path)
  return normalized === '/' ? '/' : normalized.slice(normalized.lastIndexOf('/') + 1)
}

function isWithin(path: string, rootPath: string): boolean {
  const root = normalizedPath(rootPath)
  const candidate = normalizedPath(path)
  return candidate === root || candidate.startsWith(`${root}/`)
}

function createSvg(paths: string[], className: string, viewBox = '0 0 16 16'): SVGSVGElement {
  const svg = document.createElementNS(svgNamespace, 'svg')
  svg.setAttribute('viewBox', viewBox)
  svg.setAttribute('aria-hidden', 'true')
  svg.classList.add(className)
  for (const data of paths) {
    const path = document.createElementNS(svgNamespace, 'path')
    path.setAttribute('d', data)
    svg.appendChild(path)
  }
  return svg
}

function createEntryIcon(kind: TreeEntryKind): SVGSVGElement {
  return kind === 'directory'
    ? createSvg(['M2.5 4.5h4l1.5 1.5h6v6.5h-11.5z', 'M2.5 4.5v-1h4l1.5 1.5'], 'file-tree-entry-icon')
    : createSvg(['M4 2.5h5l3 3v8H4z', 'M9 2.5v3h3'], 'file-tree-entry-icon')
}

function createChevron(): SVGSVGElement {
  return createSvg(['M5.5 3.5 10 8l-4.5 4.5'], 'file-tree-chevron')
}

function normalizeOperationResult(result: TreeOperationResult | boolean | string | null | undefined): TreeOperationResult {
  if (typeof result === 'string') return { ok: true, path: result }
  if (typeof result === 'boolean') return { ok: result }
  if (result && typeof result === 'object' && typeof result.ok === 'boolean') return result
  return { ok: false, error: '操作未完成，请重试。' }
}

function resultPath(result: TreeOperationResult | string | null | undefined): string | null {
  if (typeof result === 'string') return result
  return result?.ok && result.path ? result.path : null
}

export class FileTree {
  private readonly api: ElectronAPI
  private readonly panel: HTMLElement
  private readonly tree: HTMLUListElement
  private readonly rootLabel: HTMLElement
  private readonly rootUpButton: HTMLButtonElement
  private readonly chooseRootButton: HTMLButtonElement
  private readonly status: HTMLElement
  private readonly onOpenFile: FileTreeOptions['onOpenFile']
  private readonly onExportFile: FileTreeOptions['onExportFile']
  private readonly entriesByDirectory = new Map<string, TreeEntry[]>()
  private readonly expanded = new Set<string>()
  private readonly loading = new Set<string>()
  private readonly renderedGroups = new Map<string, HTMLUListElement>()
  private rootPath: string | null = null
  private currentPath: string | null = null
  private focusPath: string | null = null
  private contextTarget: TreeContextTarget | null = null
  private statusTimer: ReturnType<typeof setTimeout> | null = null
  private createInput: HTMLInputElement | null = null

  constructor(options: FileTreeOptions) {
    this.api = options.api
    this.panel = options.panel
    this.tree = options.tree
    this.rootLabel = options.rootLabel
    this.rootUpButton = options.rootUpButton
    this.chooseRootButton = options.chooseRootButton
    this.status = options.status
    this.onOpenFile = options.onOpenFile
    this.onExportFile = options.onExportFile

    this.tree.setAttribute('role', 'tree')
    this.tree.setAttribute('aria-label', '文件树')
    this.tree.addEventListener('click', (event) => { void this.handleClick(event) })
    this.tree.addEventListener('keydown', (event) => { void this.handleKeydown(event) })
    this.tree.addEventListener('focusin', (event) => {
      const item = (event.target as HTMLElement).closest<HTMLElement>('[role="treeitem"][data-path]')
      if (item?.dataset.path) this.focusPath = item.dataset.path
    })
    this.tree.addEventListener('contextmenu', (event) => { void this.handleContextMenu(event) })
    this.panel.addEventListener('contextmenu', (event) => {
      if ((event.target as HTMLElement).closest('[role="treeitem"], input, button')) return
      event.preventDefault()
      if (this.rootPath) void this.showContextMenu(this.rootTarget())
    })

    this.rootUpButton.addEventListener('click', () => { void this.moveRootUp() })
    this.chooseRootButton.addEventListener('click', () => { void this.chooseRoot() })
    this.api.onTreeDirectoryChanged((data) => { void this.directoryChanged(data) })
    this.api.onTreeRootChanged((data) => { void this.replaceRoot(data.path, data.snapshot) })
    this.api.onTreeContextCommand((command) => { void this.runContextCommand(command) })
  }

  async initialize(currentPath: string | null): Promise<void> {
    this.currentPath = currentPath
    const result = await this.api.getTreeRoot()
    await this.replaceRoot(resultPath(result), result.snapshot)
    if (currentPath) await this.reveal(currentPath)
  }

  async setCurrentPath(path: string | null): Promise<void> {
    this.currentPath = path
    if (!path) {
      this.render()
      return
    }

    const rootResult = await this.api.getTreeRoot()
    const latestRoot = resultPath(rootResult)
    if (latestRoot !== this.rootPath) await this.replaceRoot(latestRoot, rootResult.snapshot)
    await this.reveal(path)
  }

  async refreshDirectory(directoryPath: string): Promise<void> {
    if (!this.rootPath || !isWithin(directoryPath, this.rootPath)) return
    await this.loadDirectory(directoryPath, true)
  }

  private rootTarget(): TreeContextTarget {
    return {
      ...(this.rootPath ? { path: this.rootPath } : {}),
      kind: 'root',
      ...(this.rootPath ? { parentPath: this.rootPath } : {}),
    }
  }

  private async replaceRoot(rootPath: string | null, snapshot?: DirectorySnapshot): Promise<void> {
    const normalized = rootPath ? normalizedPath(rootPath) : null
    if (normalized === this.rootPath && normalized && this.entriesByDirectory.has(normalized)) {
      if (snapshot) this.entriesByDirectory.set(normalizedPath(snapshot.directoryPath), snapshot.entries)
      this.updateRootHeader()
      this.render()
      return
    }
    this.rootPath = normalized
    this.entriesByDirectory.clear()
    this.expanded.clear()
    this.loading.clear()
    this.focusPath = null
    this.cancelInlineCreate()
    if (snapshot && normalizedPath(snapshot.rootPath) === normalized) {
      this.entriesByDirectory.set(normalizedPath(snapshot.directoryPath), snapshot.entries)
    }
    this.updateRootHeader()
    this.render()
    if (normalized && !this.entriesByDirectory.has(normalized)) await this.loadDirectory(normalized)
    await this.syncWatchers()
  }

  private updateRootHeader(): void {
    this.rootLabel.textContent = this.rootPath ? pathName(this.rootPath) : '未选择文件夹'
    this.rootLabel.title = this.rootPath ?? ''
    this.rootUpButton.disabled = !this.rootPath || this.rootPath === '/'
  }

  private async chooseRoot(): Promise<void> {
    const result = await this.api.chooseTreeRoot()
    const root = resultPath(result)
    if (root) await this.replaceRoot(root, result.snapshot)
  }

  private async moveRootUp(): Promise<void> {
    if (!this.rootPath || this.rootPath === '/') return
    const result = await this.api.setTreeRoot(parentPath(this.rootPath))
    await this.replaceRoot(resultPath(result), result.snapshot)
    if (this.currentPath) await this.reveal(this.currentPath)
  }

  private async loadDirectory(directoryPath: string, force = false): Promise<DirectorySnapshot | null> {
    const path = normalizedPath(directoryPath)
    if (!force && this.entriesByDirectory.has(path)) return null
    if (this.loading.has(path)) return null
    this.loading.add(path)
    this.render()
    try {
      const result = await this.api.listTreeDirectory(path)
      const snapshot = result.snapshot
      if (!result.ok || !snapshot) {
        this.showStatus(result.error ?? '无法读取这个文件夹。', true)
        return null
      }
      this.entriesByDirectory.set(normalizedPath(snapshot.directoryPath), snapshot.entries)
      if (!this.rootPath) this.rootPath = normalizedPath(snapshot.rootPath)
      return snapshot
    } catch (error) {
      this.showStatus(error instanceof Error ? error.message : '无法读取这个文件夹。', true)
      return null
    } finally {
      this.loading.delete(path)
      this.render()
    }
  }

  private async toggleDirectory(path: string): Promise<void> {
    if (this.expanded.has(path)) {
      this.expanded.delete(path)
      this.render()
      await this.syncWatchers()
      return
    }
    this.expanded.add(path)
    this.render()
    // A collapsed branch is not watched. Re-read it when reopened so changes
    // made while it was collapsed appear immediately.
    await Promise.all([this.loadDirectory(path, true), this.syncWatchers()])
  }

  private async reveal(filePath: string): Promise<void> {
    if (!this.rootPath || !isWithin(filePath, this.rootPath)) {
      this.render()
      return
    }

    await this.loadDirectory(this.rootPath)
    const folders: string[] = []
    let cursor = parentPath(filePath)
    while (cursor !== this.rootPath && isWithin(cursor, this.rootPath)) {
      folders.unshift(cursor)
      const next = parentPath(cursor)
      if (next === cursor) break
      cursor = next
    }

    let containingDirectory = this.rootPath
    for (const folder of folders) {
      this.expanded.add(folder)
      await this.loadDirectory(containingDirectory)
      await this.loadDirectory(folder)
      containingDirectory = folder
    }
    this.focusPath = filePath
    this.render()
    await this.syncWatchers()
    requestAnimationFrame(() => {
      this.itemForPath(filePath)?.scrollIntoView({ block: 'nearest' })
    })
  }

  private render(): void {
    const restoreFocus = document.activeElement instanceof HTMLElement && document.activeElement.matches('[role="treeitem"]')
    this.tree.replaceChildren()
    this.renderedGroups.clear()

    if (!this.rootPath) {
      const empty = document.createElement('li')
      empty.className = 'file-tree-empty'
      empty.textContent = '打开 Markdown 文档，或选择一个文件夹。'
      this.tree.appendChild(empty)
      return
    }

    this.renderedGroups.set(this.rootPath, this.tree)
    const rootEntries = this.entriesByDirectory.get(this.rootPath)
    if (rootEntries) {
      this.renderEntries(rootEntries, this.tree, 1)
    } else if (this.loading.has(this.rootPath)) {
      this.appendLoading(this.tree, 1)
    }

    const visible = this.visibleItems()
    if (!visible.some((item) => item.dataset.path === this.focusPath)) {
      this.focusPath = visible[0]?.dataset.path ?? null
    }
    this.syncTabIndexes()
    if (restoreFocus && this.focusPath) this.itemForPath(this.focusPath)?.focus({ preventScroll: true })
  }

  private renderEntries(entries: TreeEntry[], parent: HTMLUListElement, level: number): void {
    for (const entry of entries) {
      const wrapper = document.createElement('li')
      wrapper.setAttribute('role', 'none')

      const item = document.createElement('button')
      item.type = 'button'
      item.className = `file-tree-item ${entry.kind}`
      item.dataset.path = entry.path
      item.dataset.kind = entry.kind
      item.dataset.parentPath = parentPath(entry.path)
      item.setAttribute('role', 'treeitem')
      item.setAttribute('aria-level', String(level))
      item.setAttribute('aria-selected', entry.path === this.currentPath ? 'true' : 'false')
      item.tabIndex = -1
      item.style.setProperty('--tree-depth', String(level - 1))
      if (entry.path === this.currentPath) item.classList.add('active')
      if (entry.kind === 'directory') {
        const expanded = this.expanded.has(entry.path)
        item.setAttribute('aria-expanded', String(expanded))
        item.appendChild(createChevron())
      } else {
        const spacer = document.createElement('span')
        spacer.className = 'file-tree-chevron-spacer'
        spacer.setAttribute('aria-hidden', 'true')
        item.appendChild(spacer)
      }
      item.appendChild(createEntryIcon(entry.kind))

      const label = document.createElement('span')
      label.className = 'file-tree-name'
      label.textContent = entry.name
      item.title = entry.name
      item.appendChild(label)
      wrapper.appendChild(item)

      if (entry.kind === 'directory' && this.expanded.has(entry.path)) {
        const group = document.createElement('ul')
        group.setAttribute('role', 'group')
        group.dataset.directory = entry.path
        this.renderedGroups.set(entry.path, group)
        const children = this.entriesByDirectory.get(entry.path)
        if (children) {
          this.renderEntries(children, group, level + 1)
          if (children.length === 0) {
            const empty = document.createElement('li')
            empty.className = 'file-tree-branch-empty'
            empty.style.setProperty('--tree-depth', String(level))
            empty.textContent = '空文件夹'
            group.appendChild(empty)
          }
        } else {
          this.appendLoading(group, level + 1)
        }
        wrapper.appendChild(group)
      }
      parent.appendChild(wrapper)
    }
  }

  private appendLoading(parent: HTMLUListElement, level: number): void {
    const loading = document.createElement('li')
    loading.className = 'file-tree-loading'
    loading.style.setProperty('--tree-depth', String(level - 1))
    loading.textContent = '正在读取…'
    parent.appendChild(loading)
  }

  private visibleItems(): HTMLButtonElement[] {
    return Array.from(this.tree.querySelectorAll<HTMLButtonElement>('[role="treeitem"][data-path]'))
  }

  private itemForPath(path: string): HTMLButtonElement | null {
    return this.visibleItems().find((item) => item.dataset.path === path) ?? null
  }

  private syncTabIndexes(): void {
    for (const item of this.visibleItems()) {
      item.tabIndex = item.dataset.path === this.focusPath ? 0 : -1
    }
  }

  private focusItem(item: HTMLButtonElement | undefined): void {
    if (!item?.dataset.path) return
    this.focusPath = item.dataset.path
    this.syncTabIndexes()
    item.focus()
  }

  private async handleClick(event: MouseEvent): Promise<void> {
    const item = (event.target as HTMLElement).closest<HTMLButtonElement>('[role="treeitem"][data-path]')
    if (!item?.dataset.path) return
    this.focusPath = item.dataset.path
    this.syncTabIndexes()
    if (item.dataset.kind === 'directory') {
      await this.toggleDirectory(item.dataset.path)
    } else {
      await this.onOpenFile(item.dataset.path)
    }
  }

  private async handleKeydown(event: KeyboardEvent): Promise<void> {
    const item = (event.target as HTMLElement).closest<HTMLButtonElement>('[role="treeitem"][data-path]')
    if (!item?.dataset.path || this.createInput) return
    const items = this.visibleItems()
    const index = items.indexOf(item)

    if (event.shiftKey && event.key === 'F10') {
      event.preventDefault()
      await this.showContextMenu(this.targetFromItem(item))
      return
    }

    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault()
        this.focusItem(items[Math.min(items.length - 1, index + 1)])
        break
      case 'ArrowUp':
        event.preventDefault()
        this.focusItem(items[Math.max(0, index - 1)])
        break
      case 'Home':
        event.preventDefault()
        this.focusItem(items[0])
        break
      case 'End':
        event.preventDefault()
        this.focusItem(items[items.length - 1])
        break
      case 'ArrowRight':
        if (item.dataset.kind !== 'directory') break
        event.preventDefault()
        if (item.getAttribute('aria-expanded') !== 'true') {
          await this.toggleDirectory(item.dataset.path)
          this.focusItem(this.itemForPath(item.dataset.path) ?? undefined)
        } else {
          const updated = this.visibleItems()
          const updatedIndex = updated.findIndex((candidate) => candidate.dataset.path === item.dataset.path)
          this.focusItem(updated[updatedIndex + 1])
        }
        break
      case 'ArrowLeft':
        event.preventDefault()
        if (item.dataset.kind === 'directory' && item.getAttribute('aria-expanded') === 'true') {
          await this.toggleDirectory(item.dataset.path)
          this.focusItem(this.itemForPath(item.dataset.path) ?? undefined)
        } else {
          const parent = item.dataset.parentPath
          if (parent && parent !== this.rootPath) this.focusItem(this.itemForPath(parent) ?? undefined)
        }
        break
      case 'Enter':
      case ' ':
        event.preventDefault()
        if (item.dataset.kind === 'directory') await this.toggleDirectory(item.dataset.path)
        else await this.onOpenFile(item.dataset.path)
        break
    }
  }

  private targetFromItem(item: HTMLButtonElement): TreeContextTarget {
    return {
      ...(item.dataset.path ? { path: item.dataset.path } : {}),
      kind: item.dataset.kind === 'directory' ? 'directory' : 'file',
      parentPath: item.dataset.parentPath ?? this.rootPath ?? '',
    }
  }

  private async handleContextMenu(event: MouseEvent): Promise<void> {
    const item = (event.target as HTMLElement).closest<HTMLButtonElement>('[role="treeitem"][data-path]')
    if (!item) return
    event.preventDefault()
    if (item.dataset.path) {
      this.focusPath = item.dataset.path
      this.syncTabIndexes()
      item.focus({ preventScroll: true })
    }
    await this.showContextMenu(this.targetFromItem(item))
  }

  private async showContextMenu(target: TreeContextTarget): Promise<void> {
    this.contextTarget = target
    await this.api.showTreeContextMenu(target)
  }

  private async runContextCommand(payload: TreeContextCommand | string): Promise<void> {
    const command: string = typeof payload === 'string' ? payload : payload.command
    const target = typeof payload === 'string'
      ? this.contextTarget
      : {
          ...(payload.path ? { path: payload.path } : {}),
          kind: payload.kind,
          ...(payload.parentPath ? { parentPath: payload.parentPath } : {}),
        }
    if (!target) return

    switch (command) {
      case 'create-file':
      case 'new-file':
        await this.beginInlineCreate(target, 'file')
        break
      case 'create-directory':
      case 'create-folder':
      case 'new-folder':
        await this.beginInlineCreate(target, 'directory')
        break
      case 'duplicate-file':
      case 'duplicate':
      case 'copy-file':
        if (target.path) await this.duplicateFile(target.path)
        break
      case 'trash-entry':
      case 'trash':
      case 'delete':
        if (target.path) await this.trashEntry(target.path)
        break
      case 'export-pdf':
        if (target.path) await this.onExportFile(target.path, 'pdf')
        break
      case 'export-html':
        if (target.path) await this.onExportFile(target.path, 'html')
        break
    }
  }

  private directoryForCreate(target: TreeContextTarget): string | null {
    if (!this.rootPath) return null
    if ((target.kind === 'directory' || target.kind === 'root') && target.path) return target.path
    return target.parentPath || this.rootPath
  }

  private async beginInlineCreate(target: TreeContextTarget, kind: TreeEntryKind): Promise<void> {
    const directory = this.directoryForCreate(target)
    if (!directory) return
    this.cancelInlineCreate()

    if (directory !== this.rootPath && !this.expanded.has(directory)) {
      this.expanded.add(directory)
      await this.loadDirectory(directory)
      this.render()
      await this.syncWatchers()
    }

    const group = this.renderedGroups.get(directory)
    if (!group) return
    const wrapper = document.createElement('li')
    wrapper.className = 'file-tree-create-row'
    wrapper.setAttribute('role', 'none')
    const row = document.createElement('div')
    row.className = 'file-tree-inline'
    const parentItem = directory === this.rootPath ? null : this.itemForPath(directory)
    const level = parentItem ? Number(parentItem.getAttribute('aria-level') ?? '1') + 1 : 1
    row.style.setProperty('--tree-depth', String(level - 1))
    const spacer = document.createElement('span')
    spacer.className = 'file-tree-chevron-spacer'
    row.append(spacer, createEntryIcon(kind))
    const input = document.createElement('input')
    input.type = 'text'
    input.className = 'file-tree-inline-input'
    input.setAttribute('aria-label', kind === 'file' ? '新 Markdown 文档名称' : '新文件夹名称')
    input.value = kind === 'file' ? '未命名.md' : '新建文件夹'
    input.spellcheck = false
    row.appendChild(input)
    wrapper.appendChild(row)
    group.prepend(wrapper)
    this.createInput = input
    input.focus()
    if (kind === 'file') input.setSelectionRange(0, input.value.length - 3)
    else input.select()

    const cancel = (): void => {
      if (this.createInput !== input) return
      this.createInput = null
      wrapper.remove()
      this.itemForPath(this.focusPath ?? '')?.focus()
    }
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        cancel()
      } else if (event.key === 'Enter') {
        event.preventDefault()
        void this.commitInlineCreate(directory, kind, input.value, wrapper, input)
      }
    })
    input.addEventListener('blur', () => {
      // Match Finder's explicit rename/create field: focus loss cancels, while
      // Enter is the only action that writes to disk.
      queueMicrotask(() => {
        if (this.createInput === input && document.activeElement !== input) cancel()
      })
    })
  }

  private cancelInlineCreate(): void {
    const input = this.createInput
    if (!input) return
    this.createInput = null
    input.closest('.file-tree-create-row')?.remove()
  }

  private async commitInlineCreate(
    directory: string,
    kind: TreeEntryKind,
    rawName: string,
    wrapper: HTMLLIElement,
    input: HTMLInputElement,
  ): Promise<void> {
    let name = rawName.trim()
    if (!name) {
      this.showStatus('名称不能为空。', true)
      input.focus()
      return
    }
    if (kind === 'file' && !/\.md$/i.test(name)) name += '.md'
    input.readOnly = true
    input.setAttribute('aria-busy', 'true')

    const rawResult = await this.api.createTreeEntry({ parentPath: directory, kind, name })
    const result = normalizeOperationResult(rawResult)
    if (!result.ok) {
      input.readOnly = false
      input.removeAttribute('aria-busy')
      this.showStatus(result.error ?? '无法创建，请检查名称和文件夹权限。', true)
      input.focus()
      input.select()
      return
    }

    this.createInput = null
    wrapper.remove()
    await this.loadDirectory(directory, true)
    if (result.path) {
      this.focusPath = result.path
      this.render()
      this.itemForPath(result.path)?.focus()
      if (kind === 'file') await this.onOpenFile(result.path)
    }
    this.showStatus(kind === 'file' ? 'Markdown 文档已创建。' : '文件夹已创建。')
  }

  private async duplicateFile(path: string): Promise<void> {
    const result = normalizeOperationResult(await this.api.duplicateTreeFile(path))
    if (!result.ok) {
      this.showStatus(result.error ?? '无法创建副本。', true)
      return
    }
    const directory = parentPath(path)
    await this.loadDirectory(directory, true)
    if (result.path) {
      this.focusPath = result.path
      this.render()
      this.itemForPath(result.path)?.focus()
    }
    this.showStatus('副本已创建。')
  }

  private async trashEntry(path: string): Promise<void> {
    const result = normalizeOperationResult(await this.api.trashTreeEntry(path))
    if (!result.ok) {
      this.showStatus(result.error ?? '无法移到废纸篓。', true)
      return
    }
    const directory = parentPath(path)
    this.entriesByDirectory.delete(path)
    this.expanded.delete(path)
    await this.loadDirectory(directory, true)
    this.showStatus('已移到废纸篓。')
    await this.syncWatchers()
  }

  private async directoryChanged(value: string | { path: string } | DirectorySnapshot): Promise<void> {
    const directory = typeof value === 'string'
      ? value
      : 'directoryPath' in value
        ? value.directoryPath
        : value.path
    if (!directory || !this.rootPath || !isWithin(directory, this.rootPath)) return
    if (typeof value !== 'string' && 'directoryPath' in value) this.entriesByDirectory.set(directory, value.entries)
    else if (directory === this.rootPath || this.expanded.has(directory)) await this.loadDirectory(directory, true)
    this.render()
  }

  private async syncWatchers(): Promise<void> {
    if (!this.rootPath) return
    const directories = [this.rootPath, ...this.expanded].filter((path) => isWithin(path, this.rootPath!))
    try {
      await this.api.syncTreeWatchers(directories)
    } catch {
      // Watching is an enhancement. Directory operations still force refreshes.
    }
  }

  private showStatus(message: string, error = false): void {
    if (this.statusTimer) clearTimeout(this.statusTimer)
    this.status.textContent = message
    this.status.classList.toggle('error', error)
    this.status.hidden = false
    this.statusTimer = setTimeout(() => {
      this.status.hidden = true
      this.status.textContent = ''
      this.status.classList.remove('error')
    }, error ? 6000 : 3000)
  }
}
