/** Render every registered client component with a mock React to catch runtime wiring errors. */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import vm from 'node:vm'

const SOURCE = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

/** Minimal React surface the client half uses. */
function createReact(stateQueue) {
  return {
    createElement(type, props, ...children) {
      return { type, props: { ...(props ?? {}), children } }
    },
    useState(initial) {
      if (stateQueue.length > 0) return [stateQueue.shift(), () => {}]
      return [typeof initial === 'function' ? initial() : initial, () => {}]
    },
    useRef(initial) { return { current: initial } },
    useEffect() {},
    useCallback(fn) { return fn },
    useMemo(fn) { return fn() },
  }
}

/** Load the client module and run its factory. */
function loadClient() {
  const mounted = []
  const loader = { load(definition) { mounted.push(definition) } }
  const sandbox = {
    window: { __ModuleLoader__: loader },
    require: spec => (spec === 'react' ? createReact([]) : {}),
    console,
    WebSocket: function WebSocket() {},
    AudioContext: function AudioContext() {},
    location: { protocol: 'http:', host: '127.0.0.1:3080', hash: '' },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    JSON,
    Math,
    Date,
    Promise,
    Array,
    Object,
    String,
    Number,
    Int16Array,
    Float32Array,
    Uint8Array,
    ArrayBuffer,
    Map,
    Set,
    document: { createElement: () => ({}), head: { appendChild() {} } },
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  vm.runInContext(SOURCE, sandbox, { filename: 'client.js' })
  assert.equal(mounted.length, 1, 'client bundle registers exactly one module')
  return { definition: mounted[0], sandbox }
}

/** Render a node tree, invoking function components so their bodies execute. */
function render(node, depth = 0) {
  if (node === null || node === undefined || typeof node === 'boolean') return 0
  if (typeof node === 'string' || typeof node === 'number') return 1
  if (Array.isArray(node)) return node.reduce((sum, child) => sum + render(child, depth), 0)
  if (typeof node.type === 'function') {
    assert.ok(depth < 40, 'render depth stays bounded')
    return render(node.type(node.props ?? {}), depth + 1)
  }
  let count = 1
  for (const child of node.props?.children ?? []) count += render(child, depth + 1)
  return count
}

/** A fully populated view model, matching what the engine emits. */
const RICH_VIEW = {
  phase: 'live',
  socketState: 'open',
  statusText: '会话已建立',
  notice: '',
  muted: false,
  micOpen: true,
  inputText: '帮我看看当前目录下有什么',
  outputText: '好的，我去看一下。',
  task: { title: '列出当前目录', status: '执行中' },
  reply: '',
  keyState: { configured: true, masked: '••••abcd', source: 'key-file', path: '/tmp/x', error: '' },
  history: [
    { role: 'user', text: '你好' },
    { role: 'assistant', text: '你好，我是 MOSS。' },
  ],
  typing: true,
  level: 0.4,
  aiSpeaking: true,
}

/** Build a fake client context that records registrations. */
function createContext() {
  const registrations = []
  const context = {
    slots: {
      inject(_name, callback) { return callback() },
      register(options, component) {
        registrations.push({ options, component })
        return () => {}
      },
    },
    sidebarRightTabs: { register: () => () => {} },
    sidebarRight: { openTab() {}, active: () => undefined, isExpanded: () => false, toggleExpanded() {} },
    layout: { openRightbar() {}, closeRightbar() {} },
    effect(fn) { fn() },
  }
  return { context, registrations }
}

test('module declares the right-column services and registers its slots', () => {
  const { definition, sandbox } = loadClient()
  const react = createReact([])
  sandbox.require = spec => (spec === 'react' ? react : {})
  const api = definition.factory(sandbox.require)
  assert.deepEqual([...api.inject], ['slots', 'sidebarRightTabs', 'sidebarRight'])
  const { context, registrations } = createContext()
  api.apply(context)
  const names = registrations.map(entry => entry.options.name)
  assert.deepEqual(names.sort(), [
    'sidebar.footer.action',
    'sidebar.right.pane.tab',
    'sidebar.right.pane.tab.title',
  ])
  assert.ok(registrations.every(entry => entry.options.key === 'moss-live-voice'
    || entry.options.id === 'moss-live-voice' || entry.options.key === undefined))
})

test('the panel renders its empty state without throwing', () => {
  const { definition, sandbox } = loadClient()
  const register = []
  const react = createReact([])
  sandbox.require = spec => (spec === 'react' ? react : {})
  const api = definition.factory(sandbox.require)
  api.apply({
    slots: {
      inject: (_name, callback) => callback(),
      register: (options, component) => { register.push({ options, component }); return () => {} },
    },
    sidebarRightTabs: { register: () => () => {} },
    sidebarRight: { openTab() {}, active: () => undefined, isExpanded: () => false, toggleExpanded() {} },
    layout: { openRightbar() {}, closeRightbar() {} },
    effect(fn) { fn() },
  })
  const panel = register.find(entry => entry.options.name === 'sidebar.right.pane.tab')
  assert.ok(panel !== undefined)
  assert.ok(render(react.createElement(panel.component, {})) > 10)
})

test('the panel renders a live conversation with task and setting sheet', () => {
  const { definition, sandbox } = loadClient()
  const queue = [RICH_VIEW]
  const react = createReact(queue)
  sandbox.require = spec => (spec === 'react' ? react : {})
  const api = definition.factory(sandbox.require)
  const register = []
  api.apply({
    slots: {
      inject: (_name, callback) => callback(),
      register: (options, component) => { register.push({ options, component }); return () => {} },
    },
    sidebarRightTabs: { register: () => () => {} },
    sidebarRight: { openTab() {}, active: () => undefined, isExpanded: () => false, toggleExpanded() {} },
    layout: { openRightbar() {}, closeRightbar() {} },
    effect(fn) { fn() },
  })
  const panel = register.find(entry => entry.options.name === 'sidebar.right.pane.tab')
  assert.ok(render(react.createElement(panel.component, {})) > 10)

  // Settings sheet open: the panel's own state follows the view model.
  queue.push(RICH_VIEW, true)
  assert.ok(render(react.createElement(panel.component, {})) > 10)
})

test('every tracked file is free of credentials', () => {
  const root = new URL('..', import.meta.url)
  let files
  try {
    files = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' })
      .split('\n')
      .filter(Boolean)
  } catch {
    // Outside a checkout (for example an unpacked tarball) fall back to the
    // files that ship to a user.
    files = ['client.js', 'index.js', 'cordis.patch.yml', 'PROTOCOL.md', 'README.md']
  }
  assert.ok(files.length > 10, 'the scan covers the published files')
  for (const file of files) {
    const text = readFileSync(new URL(file, root), 'utf8')
    assert.equal(/sk-[A-Za-z0-9]{20,}/.test(text), false, `${file} must not embed a key`)
    assert.equal(/\/Users\/(?!you\/)[a-z][\w.-]+\//i.test(text), false, `${file} must not embed a home path`)
  }
})
