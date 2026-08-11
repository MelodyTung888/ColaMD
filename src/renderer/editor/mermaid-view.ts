import { codeBlockSchema } from '@milkdown/kit/preset/commonmark'
import { $view } from '@milkdown/kit/utils'
import type { NodeViewConstructor } from '@milkdown/kit/prose/view'
import mermaid from 'mermaid'

let nextDiagramId = 0
let mermaidReady = false

function ensureMermaid(): void {
  if (mermaidReady) return
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme: 'default',
  })
  mermaidReady = true
}

function isMermaid(node: { attrs: { language?: string } }): boolean {
  return String(node.attrs.language ?? '').trim().toLowerCase() === 'mermaid'
}

const mermaidViewConstructor: NodeViewConstructor = (node) => {
  const dom = document.createElement('div')
  dom.className = 'colamd-code-block'

  const diagram = document.createElement('div')
  diagram.className = 'mermaid-diagram'
  diagram.hidden = true

  const pre = document.createElement('pre')
  const code = document.createElement('code')
  pre.appendChild(code)

  const error = document.createElement('div')
  error.className = 'mermaid-error'
  error.hidden = true

  dom.append(diagram, pre, error)

  let renderToken = 0
  let currentNode = node

  const showSource = (): void => {
    diagram.hidden = true
    pre.hidden = false
    error.hidden = true
  }

  const render = (nextNode: typeof node): void => {
    currentNode = nextNode
    if (!isMermaid(nextNode)) {
      showSource()
      return
    }

    ensureMermaid()
    const source = nextNode.textContent
    const token = ++renderToken
    pre.hidden = true
    error.hidden = true
    diagram.hidden = false
    diagram.textContent = 'Rendering Mermaid…'

    mermaid.render(`colamd-mermaid-${++nextDiagramId}`, source)
      .then(({ svg }) => {
        if (token !== renderToken || currentNode !== nextNode) return
        diagram.innerHTML = svg
        diagram.hidden = false
        pre.hidden = true
      })
      .catch((reason: unknown) => {
        if (token !== renderToken || currentNode !== nextNode) return
        diagram.hidden = true
        pre.hidden = false
        error.textContent = `Mermaid 渲染失败：${reason instanceof Error ? reason.message : '语法错误'}`
        error.hidden = false
      })
  }

  // ProseMirror fills contentDOM after constructing the view.
  queueMicrotask(() => render(currentNode))

  return {
    dom,
    contentDOM: code,
    update(nextNode) {
      if (nextNode.type !== currentNode.type) return false
      render(nextNode)
      return true
    },
    stopEvent: () => false,
    ignoreMutation: (mutation) => mutation.type === 'attributes' && mutation.target === diagram,
  }
}

// This view keeps ordinary code blocks as editable pre/code nodes and only
// replaces Mermaid blocks with a safe, generated SVG when rendering succeeds.
export const mermaidView = $view(codeBlockSchema.node, () => mermaidViewConstructor)
