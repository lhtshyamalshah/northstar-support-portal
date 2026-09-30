/**
 * Interactive Preview — the half that ships inside the generated app.
 *
 * Two jobs:
 *   1. stamp every JSX host element with `data-zb-loc="<relPath>:<line>:<col>"`
 *      so a click in the browser points at an exact node in an exact source file;
 *   2. inject an overlay runtime that turns those stamps into a selection the
 *      parent frame can act on.
 *
 * Plain `.mjs` on purpose. A `.ts` file here would be pulled into
 * `tsconfig.node.json`'s composite project through vite.config.ts's import while
 * sitting outside its closed `include` list, which fails the generated app's
 * `tsc && vite build` with TS6307.
 *
 * Everything here must be TOTAL. Apps are scaffolded from this template and are
 * never patched afterwards, so a throw in `transform` is a permanently broken
 * dev server for every app already carrying it — hence the blanket try/catch and
 * "return the source unchanged" failure mode.
 *
 * PARSER NOTE: this uses `@babel/parser`, NOT vite's re-exported `parseAst`.
 * `parseAst` is Rollup's parser: it needs `{ jsx: true }` to see JSX at all, and it
 * cannot read TypeScript annotations in any configuration — which is every file in
 * this template. It fails inside the try/catch above, so the symptom is not an
 * error but silence: nothing stamped, nothing selectable, and no clue why.
 * Babel is already in the tree (`@vitejs/plugin-react` → `@babel/core`) and is
 * declared in package.json so this file's use of it is not accidental.
 */

import path from 'node:path'
import { parse } from '@babel/parser'

// ─── Constants ────────────────────────────────────────────────────────────────

const LOC_ATTR = 'data-zb-loc'
/** Boolean marker: the element is rendered from a `.map()` body, so the server refuses instance-level edits on it. */
const KEY_ATTR = 'data-zb-key'
/** The enclosing user component. Nothing in the DOM carries it, and we are deliberately not reading React internals. */
const NAME_ATTR = 'data-zb-name'

const RUNTIME_VERSION = 1

/** Both walk a list and both make an element's identity per-instance rather than per-source-node. */
const LIST_METHODS = new Set(['map', 'flatMap'])

/**
 * A relative path is spliced verbatim into a JSX string attribute, where `"`
 * terminates the value and `&`/`{` change how it is parsed. Rather than invent
 * an escaping scheme for filenames nobody sane writes, refuse to stamp the file.
 */
const UNSAFE_IN_ATTRIBUTE = /["'\\<>&{}\n\r\t]/

const COMPONENT_NAME = /^[A-Z][\w$]*$/

// ─── Stamping ─────────────────────────────────────────────────────────────────

/**
 * Adds the addressing attributes to every JSX host element in `code`.
 *
 * Exported so the stamper can be unit-tested without a browser or a dev server —
 * the whole reason addressing is done with a stamped attribute rather than
 * React's `__source`.
 *
 * @param {string} code Raw on-disk source.
 * @param {string} relPath Workspace-relative path, forward slashes. Goes into the Loc verbatim.
 * @returns {string | null} The stamped source, or null meaning "unchanged".
 */
export function stampSource(code, relPath) {
  try {
    if (typeof code !== 'string' || typeof relPath !== 'string') return null
    if (!/\.[jt]sx$/.test(relPath)) return null
    // A Loc must be workspace-relative and free of `..` — see isSafeLocPath in
    // the contract. Anything else is a file we simply do not address.
    if (relPath.startsWith('/') || /^[a-zA-Z]:/.test(relPath)) return null
    if (relPath.split('/').some((segment) => segment === '..')) return null
    if (UNSAFE_IN_ATTRIBUTE.test(relPath)) return null

    // Annotations only exist in .tsx; enabling the plugin for .jsx would change how
    // some valid JS parses, so the plugin set follows the extension.
    const plugins = relPath.endsWith('.tsx') ? ['typescript', 'jsx'] : ['jsx']
    const ast = parse(code, { sourceType: 'module', plugins }).program
    const lineStarts = buildLineIndex(code)

    /** @type {{ pos: number, text: string }[]} */
    const inserts = []

    walk(ast, { component: undefined, inList: false }, (node, context) => {
      let next = context

      const name = declaredComponentName(node)
      if (name) next = { component: name, inList: next.inList }
      if (isListCall(node)) next = { component: next.component, inList: true }

      if (node.type === 'JSXElement') {
        const insert = stampFor(lineStarts, relPath, node, next)
        if (insert) inserts.push(insert)
      }

      return next
    })

    if (inserts.length === 0) return null

    // Right-to-left so every offset collected against the original source is
    // still valid when its turn comes.
    inserts.sort((a, b) => b.pos - a.pos)
    let out = code
    for (const insert of inserts) {
      out = out.slice(0, insert.pos) + insert.text + out.slice(insert.pos)
    }
    return out
  } catch {
    return null
  }
}

/**
 * @returns {{ pos: number, text: string } | null}
 */
function stampFor(lineStarts, relPath, element, context) {
  const opening = element.openingElement
  if (!opening || !opening.name) return null

  // Components are the user's call site, which is what we want to leave alone;
  // only lowercase names reach the DOM as real elements.
  if (opening.name.type !== 'JSXIdentifier') return null
  if (!/^[a-z]/.test(opening.name.name)) return null

  for (const attribute of opening.attributes ?? []) {
    // A spread can carry any of our attributes and, depending on where it sits,
    // silently win over the one we inject. Leave the element unaddressed.
    if (attribute.type === 'JSXSpreadAttribute') return null
    if (attribute.type === 'JSXAttribute' && attribute.name?.name === LOC_ATTR) return null
  }

  const { line, col } = lineColAt(lineStarts, element.start)

  let text = ` ${LOC_ATTR}="${relPath}:${line}:${col}"`
  if (context.component) text += ` ${NAME_ATTR}="${context.component}"`
  if (context.inList) text += ` ${KEY_ATTR}="1"`

  // Straight after the tag name: valid for self-closing and normal elements
  // alike, and it never moves a newline, so line numbers survive the splice.
  return { pos: opening.name.end, text }
}

// ─── AST helpers ──────────────────────────────────────────────────────────────

const SKIP_KEYS = new Set([
  'type', 'start', 'end', 'loc', 'range', 'parent',
  // Babel hangs comment nodes off the nodes around them; they hold no JSX and
  // re-walking them multiplies the traversal for nothing.
  'leadingComments', 'trailingComments', 'innerComments',
])

/**
 * Depth-first walk over the ESTree-shaped AST `@babel/parser` returns. `visit` gets
 * the node and the inherited context and returns the context for its children.
 */
function walk(node, context, visit) {
  if (node === null || typeof node !== 'object') return

  if (Array.isArray(node)) {
    for (const child of node) walk(child, context, visit)
    return
  }
  if (typeof node.type !== 'string') return

  const next = visit(node, context)
  for (const key in node) {
    if (SKIP_KEYS.has(key)) continue
    walk(node[key], next, visit)
  }
}

/** The capitalised binding a JSX tree is being declared under, if any. */
function declaredComponentName(node) {
  let name
  if (node.type === 'FunctionDeclaration' || node.type === 'ClassDeclaration') {
    name = node.id?.name
  } else if (node.type === 'VariableDeclarator' && node.id?.type === 'Identifier') {
    const init = node.init
    // CallExpression covers the wrapper forms — memo(), forwardRef(), styled().
    if (
      init &&
      (init.type === 'ArrowFunctionExpression' ||
        init.type === 'FunctionExpression' ||
        init.type === 'CallExpression')
    ) {
      name = node.id.name
    }
  }
  return name && COMPONENT_NAME.test(name) ? name : undefined
}

function isListCall(node) {
  return (
    node.type === 'CallExpression' &&
    node.callee?.type === 'MemberExpression' &&
    !node.callee.computed &&
    node.callee.property?.type === 'Identifier' &&
    LIST_METHODS.has(node.callee.property.name)
  )
}

/**
 * Line starts using the same terminator set as TypeScript's `computeLineStarts` —
 * LF, CR, CRLF, U+2028 and U+2029. A Loc is read by the agent as a file:line:col
 * to open, so a line counted differently here sends it to the wrong place.
 */
function buildLineIndex(code) {
  const starts = [0]
  for (let i = 0; i < code.length; i++) {
    const ch = code.charCodeAt(i)
    if (ch === 13 /* CR */) {
      if (code.charCodeAt(i + 1) === 10) i++
      starts.push(i + 1)
    } else if (ch === 10 || ch === 0x2028 || ch === 0x2029) {
      starts.push(i + 1)
    }
  }
  return starts
}

function lineColAt(starts, offset) {
  let low = 0
  let high = starts.length - 1
  while (low < high) {
    const mid = (low + high + 1) >> 1
    if (starts[mid] <= offset) low = mid
    else high = mid - 1
  }
  return { line: low + 1, col: offset - starts[low] + 1 }
}

// ─── Overlay runtime ──────────────────────────────────────────────────────────

/**
 * Serialised with Function.prototype.toString() and injected as an inline module
 * script, so the app's own source needs no import and no change.
 *
 * It MUST stay self-contained: it can reference nothing from this module's
 * scope, only its `config` argument. That includes the contract's caps, which
 * are duplicated below because a generated app cannot import server code.
 *
 * Message shapes, which debug-chat and the preview pane must match:
 *   out  { source: 'zbrain-inspector', version, type: 'zb:ready' }
 *        { source: 'zbrain-inspector', version, type: 'zb:select', payload: SelectionPayload }
 *        { source: 'zbrain-inspector', version, type: 'zb:route',  payload: { route } }
 *        { source: 'zbrain-inspector', version, type: 'zb:mode',   payload: { mode } }
 *   in   { type: 'zb:mode', mode: 'interact' | 'select' }
 *        { type: 'zb:clear' }
 *        { type: 'zb:highlight', loc: Loc }
 *        { type: 'zb:navigate', path: '/pricing' }
 *
 * @param {{ parentOrigin: string, version: number, attrs: { loc: string, key: string, name: string } }} config
 */
function zbrainOverlayRuntime(config) {
  const PARENT_ORIGIN = config.parentOrigin
  // No known parent means no safe postMessage target, and '*' would hand this
  // app's DOM to any page that frames it. Stay completely inert.
  if (!PARENT_ORIGIN) return
  if (window.__zbrainInspector) return

  const LOC_ATTR = config.attrs.loc
  const KEY_ATTR = config.attrs.key
  const NAME_ATTR = config.attrs.name

  // Duplicated from the contract's caps — enforced here as well as on the
  // server, because the page posting these messages is model-authored code.
  const TEXT_CAP = 200
  const CLASSES_CAP = 50
  const PROPS_CAP = 20
  const PROP_VALUE_CAP = 200
  const READABLE_PROPS = [
    'src', 'alt', 'href', 'title', 'placeholder', 'aria-label', 'target', 'rel', 'type', 'name', 'id',
  ]

  const FLASH_MS = 900

  let mode = 'interact'
  let hovered = null
  let flashUntil = 0
  let lastRoute = location.pathname
  let reduceMotion = false

  try {
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)')
    reduceMotion = motion.matches
    motion.addEventListener('change', (event) => { reduceMotion = event.matches })
  } catch { /* matchMedia is optional */ }

  // ── Overlay surface ──
  // A shadow root keeps app CSS out; a fixed, full-viewport host keeps React
  // portals coverable. Inline !important beats any app rule selecting a bare div.
  const host = document.createElement('div')
  host.setAttribute('data-zbrain-inspector', '')
  const hostStyle = {
    position: 'fixed', top: '0px', left: '0px', width: '100%', height: '100%',
    margin: '0px', padding: '0px', border: '0px', background: 'transparent',
    'pointer-events': 'none', 'z-index': '2147483647',
  }
  for (const property in hostStyle) host.style.setProperty(property, hostStyle[property], 'important')

  const shadow = host.attachShadow({ mode: 'open' })
  shadow.innerHTML = [
    '<style>',
    ':host, * { box-sizing: border-box; pointer-events: none; }',
    '.box, .flash {',
    '  position: fixed; display: none;',
    '  border: 1px solid rgb(99 102 241); background: rgb(99 102 241 / 0.12);',
    '  border-radius: 2px;',
    '}',
    '.flash { border-color: rgb(16 185 129); background: rgb(16 185 129 / 0.18); }',
    '.label {',
    '  position: fixed; display: none; max-width: 320px;',
    '  padding: 2px 6px; border-radius: 3px;',
    '  font: 11px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;',
    '  color: #fff; background: rgb(79 70 229);',
    '  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;',
    '}',
    '</style>',
    '<div class="box"></div><div class="label"></div><div class="flash"></div>',
  ].join('')

  const box = shadow.querySelector('.box')
  const label = shadow.querySelector('.label')
  const flash = shadow.querySelector('.flash')

  const mount = () => { (document.body || document.documentElement).appendChild(host) }
  if (document.body) mount()
  else document.addEventListener('DOMContentLoaded', mount, { once: true })

  // ── Messaging ──

  function post(type, payload) {
    const message = { source: 'zbrain-inspector', version: config.version, type }
    if (payload !== undefined) message.payload = payload
    try {
      window.parent.postMessage(message, PARENT_ORIGIN)
    } catch { /* a closed or cross-origin parent is not our problem */ }
  }

  window.addEventListener('message', (event) => {
    // Origin alone is not enough: the console's origin also serves every other preview, so
    // any frame or opener from it could otherwise drive this inspector. The parent window is
    // the only sender we ever accept — the same check debug-chat makes in the other direction.
    if (event.source !== window.parent) return
    if (event.origin !== PARENT_ORIGIN) return
    const data = event.data
    if (!data || typeof data !== 'object') return

    // The app around us is model-authored and may have replaced any DOM API we
    // touch. One bad command must not take the whole inspector down.
    try {
      if (data.type === 'zb:mode') setMode(data.mode)
      else if (data.type === 'zb:clear') clearHover()
      else if (data.type === 'zb:highlight') highlight(data.loc)
      else if (data.type === 'zb:navigate') navigate(data.path)
    } catch { /* ignore */ }
  })

  // ── Modes ──

  function setMode(next) {
    if (next !== 'interact' && next !== 'select') return
    if (next === mode) return
    mode = next
    if (mode === 'select') listen(document.addEventListener.bind(document), window.addEventListener.bind(window))
    else {
      listen(document.removeEventListener.bind(document), window.removeEventListener.bind(window))
      clearHover()
    }
    post('zb:mode', { mode })
  }

  /**
   * In `interact` mode nothing is bound at all — the app has to behave exactly
   * as it does with the inspector absent.
   */
  function listen(onDocument, onWindow) {
    onDocument('mouseover', onMouseOver, true)
    onDocument('click', onClick, true)
    onDocument('mousedown', swallow, true)
    onDocument('mouseup', swallow, true)
    onDocument('dblclick', swallow, true)
    onDocument('contextmenu', swallow, true)
    onWindow('keydown', onKeyDown, true)
    onWindow('scroll', redraw, true)
    onWindow('resize', redraw, true)
  }

  function swallow(event) {
    event.preventDefault()
    event.stopPropagation()
  }

  function onKeyDown(event) {
    if (event.key !== 'Escape') return
    swallow(event)
    setMode('interact')
  }

  function onMouseOver(event) {
    const element = closestStamped(event.target)
    if (element === hovered) return
    hovered = element
    redraw()
  }

  function onClick(event) {
    swallow(event)
    const element = closestStamped(event.target)
    if (!element) return
    const payload = buildPayload(element)
    if (payload) post('zb:select', payload)
  }

  // ── Element resolution ──

  function closestStamped(target) {
    let node = target
    while (node) {
      if (node.nodeType === 1 && node.hasAttribute(LOC_ATTR)) return node
      const root = node.parentElement ? null : node.getRootNode && node.getRootNode()
      node = node.parentElement || (root && root.host) || null
    }
    return null
  }

  function parseLoc(raw) {
    if (typeof raw !== 'string') return null
    // Split from the right: only the file half may itself contain a colon.
    const parts = raw.split(':')
    if (parts.length < 3) return null
    const col = Number(parts.pop())
    const line = Number(parts.pop())
    const file = parts.join(':')
    if (!file || !Number.isInteger(line) || !Number.isInteger(col)) return null
    return { file, line, col }
  }

  function findByLoc(loc) {
    if (!loc || typeof loc !== 'object') return null
    const candidates = document.querySelectorAll('[' + LOC_ATTR + ']')
    for (const element of candidates) {
      const parsed = parseLoc(element.getAttribute(LOC_ATTR))
      if (parsed && parsed.file === loc.file && parsed.line === loc.line && parsed.col === loc.col) {
        return element
      }
    }
    return null
  }

  function buildPayload(element) {
    const loc = parseLoc(element.getAttribute(LOC_ATTR))
    if (!loc) return null

    const rect = element.getBoundingClientRect()
    const payload = {
      loc,
      tag: element.localName,
      rect: {
        x: Math.round(rect.left), y: Math.round(rect.top),
        w: Math.round(rect.width), h: Math.round(rect.height),
      },
      route: location.pathname,
    }

    const component = element.getAttribute(NAME_ATTR)
    if (component) payload.componentName = component

    const text = (element.textContent || '').replace(/\s+/g, ' ').trim()
    if (text) payload.text = text.slice(0, TEXT_CAP)

    const classes = []
    element.classList.forEach((name) => {
      if (classes.length < CLASSES_CAP) classes.push(name)
    })
    if (classes.length) payload.classes = classes

    const props = {}
    let count = 0
    for (const name of READABLE_PROPS) {
      if (count >= PROPS_CAP) break
      if (!element.hasAttribute(name)) continue
      props[name] = String(element.getAttribute(name)).slice(0, PROP_VALUE_CAP)
      count++
    }
    if (count) payload.props = props

    if (element.hasAttribute(KEY_ATTR)) payload.inMappedList = true
    return payload
  }

  // ── Drawing ──

  function place(node, rect) {
    node.style.display = 'block'
    node.style.left = rect.left + 'px'
    node.style.top = rect.top + 'px'
    node.style.width = rect.width + 'px'
    node.style.height = rect.height + 'px'
  }

  function redraw() {
    if (!hovered || !hovered.isConnected) {
      box.style.display = 'none'
      label.style.display = 'none'
      return
    }
    const rect = hovered.getBoundingClientRect()
    place(box, rect)

    const component = hovered.getAttribute(NAME_ATTR)
    label.textContent = component ? hovered.localName + ' · ' + component : hovered.localName
    label.style.display = 'block'
    // Above the element when there is room, otherwise tucked just inside it.
    const above = rect.top >= 20
    label.style.top = (above ? rect.top - 18 : rect.top + 2) + 'px'
    label.style.left = Math.max(0, rect.left) + 'px'
  }

  function clearHover() {
    hovered = null
    box.style.display = 'none'
    label.style.display = 'none'
  }

  function highlight(loc) {
    const element = findByLoc(loc)
    if (!element) return
    if (typeof element.scrollIntoView === 'function') {
      element.scrollIntoView({ block: 'center', behavior: reduceMotion ? 'auto' : 'smooth' })
    }

    flashUntil = Date.now() + FLASH_MS
    const track = () => {
      if (Date.now() > flashUntil || !element.isConnected) {
        flash.style.display = 'none'
        return
      }
      // Re-measure every frame: a smooth scrollIntoView is still moving.
      place(flash, element.getBoundingClientRect())
      requestAnimationFrame(track)
    }
    requestAnimationFrame(track)
  }

  // ── Routing ──

  function reportRoute() {
    if (location.pathname === lastRoute) return
    lastRoute = location.pathname
    post('zb:route', { route: lastRoute })
  }

  function navigate(path) {
    if (typeof path !== 'string' || !path.startsWith('/')) return
    if (path === location.pathname) return
    // pushState rather than assigning location.pathname: a reload would drop the
    // HMR session and every bit of app state the user is inspecting.
    history.pushState({}, '', path)
    window.dispatchEvent(new PopStateEvent('popstate'))
    reportRoute()
  }

  for (const method of ['pushState', 'replaceState']) {
    const original = history[method]
    if (typeof original !== 'function') continue
    history[method] = function () {
      const result = original.apply(this, arguments)
      reportRoute()
      return result
    }
  }
  window.addEventListener('popstate', reportRoute)

  window.__zbrainInspector = { version: config.version, setMode }
  post('zb:ready')
  post('zb:route', { route: lastRoute })
}

// ─── Plugin ───────────────────────────────────────────────────────────────────

/**
 * @returns {import('vite').Plugin | false}
 */
export default function zbrainInspector() {
  // Read process.env directly. Vite's loadEnv(mode, dir, '') merges every key of
  // every .env* file in the workspace, so an agent-authored frontend/.env could
  // otherwise switch the inspector on in a build we ship.
  if (process.env.ZBRAIN_INSPECTOR !== '1') return false
  // vitest reuses this very config object; stamping every host element would
  // break the tester sub-agent's DOM assertions.
  if (process.env.VITEST) return false

  let enabled = true
  let stampRoot = process.cwd()
  let parentOrigin = ''

  return {
    name: 'zbrain-inspector',
    apply: 'serve',
    // Ahead of every other transform so line and column describe the raw on-disk
    // bytes the agent will read back, not some other plugin's output.
    enforce: 'pre',

    configResolved(config) {
      enabled = config.mode !== 'test'
      // Vite's root is the service directory (usually `frontend/`), but a Loc is
      // workspace-relative. The preview orchestrator injects WORKSPACE_ROOT.
      stampRoot = process.env.WORKSPACE_ROOT ? path.resolve(process.env.WORKSPACE_ROOT) : config.root
      // config.env is exactly what import.meta.env resolves to in the client, so
      // this is import.meta.env.VITE_ZBRAIN_PARENT_ORIGIN — read here rather than
      // in the runtime so it does not depend on the injected script being run
      // through Vite's html-proxy transform.
      parentOrigin = normaliseOrigin(config.env?.VITE_ZBRAIN_PARENT_ORIGIN)
    },

    transform(code, id) {
      if (!enabled) return null
      const file = id.split('?')[0]
      if (!/\.[jt]sx$/.test(file)) return null
      if (file.includes('/node_modules/') || file.includes('\\node_modules\\')) return null
      // ?raw and friends have already been turned into a string export by an
      // earlier load hook; what arrives here is no longer the component source.
      if (/[?&](raw|url|inline|worker|sharedworker)\b/.test(id.slice(file.length))) return null

      const relPath = path.relative(stampRoot, file).split(path.sep).join('/')
      const stamped = stampSource(code, relPath)
      if (stamped === null) return null
      // No sourcemap: every insertion is intra-line, so line numbers — the only
      // part a stack trace or an HMR error overlay needs — are already correct.
      return { code: stamped, map: null }
    },

    transformIndexHtml() {
      if (!enabled) return
      return [{
        tag: 'script',
        attrs: { type: 'module' },
        children: renderRuntime(parentOrigin),
        injectTo: 'body',
      }]
    },
  }
}

function normaliseOrigin(value) {
  if (typeof value !== 'string' || value.trim() === '') return ''
  try {
    return new URL(value.trim()).origin
  } catch {
    return ''
  }
}

function renderRuntime(parentOrigin) {
  const config = {
    parentOrigin,
    version: RUNTIME_VERSION,
    attrs: { loc: LOC_ATTR, key: KEY_ATTR, name: NAME_ATTR },
  }
  return `(${zbrainOverlayRuntime.toString()})(${JSON.stringify(config)});`
}
