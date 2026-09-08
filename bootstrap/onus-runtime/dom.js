/**
 * The DOM capability and the view primitive (language spec §22; docs/CHANGES.md
 * item 208): `Root` over one subtree of the document, `subtree`, `patch` (diff two
 * `View` trees and apply the minimal mutations) and `run` (the render, patch,
 * event, update loop installed on the host's event loop). The document is
 * whatever `globalThis.document` is: a browser's, or a fake supplied for tests.
 * View values are the compiler's union objects: `{ tag: "Element", element: {tag},
 * attrs, children, key }`, `{ tag: "Text", value }`, `{ tag: "Keyed", key, child }`;
 * attributes `{ tag: "Attribute", name: {tag}, value }`, `{ tag: "On", event: {tag},
 * msg }`, `{ tag: "Property", name: {tag}, value }`.
 */
import { Capability } from './capability.js';
/** A host that cannot supply what `dom` needs; not an obligation, so not a `Panic`. */
class HostError extends Error {
    constructor(message) {
        super(message);
        this.name = 'HostError';
    }
}
function document() {
    const d = globalThis.document;
    if (d === undefined)
        throw new HostError('dom: this host has no document; `dom.Root` exists on the JavaScript host in a browser (§22.1)');
    return d;
}
export class Root extends Capability {
    node;
    /** @internal */
    constructor(node) {
        super('dom.Root');
        this.node = node;
    }
    /** The root capability the runtime supplies to `main`: the document's body (§22.1). */
    static root() {
        const d = document();
        const body = d.body ?? d.getElementById('root');
        if (body === null || body === undefined)
            throw new HostError('dom: the document has no body to render into');
        return new Root(body);
    }
}
export function subtree(root, id) {
    const found = document().getElementById(id);
    return found === null ? root : new Root(found);
}
// ---------------------------------------------------------------------------
// The vocabulary, as the document spells it
// ---------------------------------------------------------------------------
const TAGS = { Div: 'div', Span: 'span', P: 'p', H1: 'h1', H2: 'h2', H3: 'h3', Ul: 'ul', Ol: 'ol', Li: 'li', Button: 'button', Input: 'input', Label: 'label', Form: 'form', Table: 'table', Thead: 'thead', Tbody: 'tbody', Tr: 'tr', Th: 'th', Td: 'td', A: 'a', Img: 'img', Pre: 'pre', Code: 'code', Section: 'section', Header: 'header', Footer: 'footer', Nav: 'nav', Main: 'main', Select: 'select', OptionItem: 'option', Textarea: 'textarea' };
const ATTRS = { Id: 'id', Class: 'class', Href: 'href', Src: 'src', Alt: 'alt', Title: 'title', For: 'for', Type: 'type', Placeholder: 'placeholder', Name: 'name', Role: 'role', AriaLabel: 'aria-label', Disabled: 'disabled', Style: 'style' };
const PROPS = { Value: 'value', Checked: 'checked', Selected: 'selected' };
const EVENTS = { Click: 'click', Edited: 'input', Change: 'change', Submit: 'submit', KeyDown: 'keydown', Focus: 'focus', Blur: 'blur' };
function spelled(table, v) {
    const s = table[v.tag];
    if (s === undefined)
        throw new HostError(`dom: unknown vocabulary ${v.tag}`);
    return s;
}
// ---------------------------------------------------------------------------
// Rendering and patching
// ---------------------------------------------------------------------------
/** Listeners installed on a node, by event name, so a patch can replace them. */
const listeners = new WeakMap();
function unkey(v) {
    return v.tag === 'Keyed' ? unkey(v.child) : v;
}
function keyOf(v) {
    if (v.tag === 'Keyed')
        return v.key;
    if (v.tag === 'Element')
        return v.key.tag === 'Some' ? v.key.value : null;
    return null;
}
function create(d, view, dispatch) {
    const v = unkey(view);
    if (v.tag === 'Text')
        return d.createTextNode(v.value);
    const node = d.createElement(spelled(TAGS, v.element));
    setAttrs(node, [], v.attrs, dispatch);
    for (const c of v.children)
        node.appendChild(create(d, c, dispatch));
    return node;
}
function setAttrs(node, before, after, dispatch) {
    const oldAttrs = new Map();
    const oldProps = new Map();
    const oldEvents = new Set();
    for (const a of before) {
        if (a.tag === 'Attribute')
            oldAttrs.set(spelled(ATTRS, a.name), a.value);
        else if (a.tag === 'Property')
            oldProps.set(spelled(PROPS, a.name), a.value);
        else
            oldEvents.add(spelled(EVENTS, a.event));
    }
    const newAttrs = new Map();
    const newProps = new Map();
    const newEvents = new Map();
    for (const a of after) {
        if (a.tag === 'Attribute')
            newAttrs.set(spelled(ATTRS, a.name), a.value);
        else if (a.tag === 'Property')
            newProps.set(spelled(PROPS, a.name), a.value);
        else
            newEvents.set(spelled(EVENTS, a.event), a.msg);
    }
    for (const [name, value] of newAttrs)
        if (oldAttrs.get(name) !== value)
            node.setAttribute?.(name, value);
    for (const name of oldAttrs.keys())
        if (!newAttrs.has(name))
            node.removeAttribute?.(name);
    const target = node;
    for (const [name, value] of newProps)
        if (oldProps.get(name) !== value)
            target[name] = name === 'checked' || name === 'selected' ? value === 'true' : value;
    for (const name of oldProps.keys())
        if (!newProps.has(name))
            target[name] = name === 'checked' || name === 'selected' ? false : '';
    let installed = listeners.get(node);
    if (installed === undefined) {
        installed = new Map();
        listeners.set(node, installed);
    }
    for (const [name, msg] of newEvents) {
        const previous = installed.get(name);
        if (previous !== undefined)
            node.removeEventListener?.(name, previous);
        const handler = (event) => {
            const e = event;
            if (name === 'submit')
                e.preventDefault?.();
            dispatch(msg);
        };
        installed.set(name, handler);
        node.addEventListener?.(name, handler);
    }
    for (const name of oldEvents) {
        if (!newEvents.has(name)) {
            const previous = installed.get(name);
            if (previous !== undefined)
                node.removeEventListener?.(name, previous);
            installed.delete(name);
        }
    }
}
function sameShape(a, b) {
    const x = unkey(a);
    const y = unkey(b);
    if (x.tag !== y.tag)
        return false;
    if (x.tag === 'Text' || y.tag === 'Text')
        return true;
    return x.element.tag === y.element.tag && keyOf(a) === keyOf(b);
}
/** Reconciles `node`, which renders `before`, into `after`; returns the node in place afterwards. */
function reconcile(d, parent, node, before, after, dispatch) {
    if (!sameShape(before, after)) {
        const fresh = create(d, after, dispatch);
        parent.insertBefore(fresh, node);
        parent.removeChild(node);
        return fresh;
    }
    const x = unkey(before);
    const y = unkey(after);
    if (x.tag === 'Text' && y.tag === 'Text') {
        if (x.value !== y.value)
            node.textContent = y.value;
        return node;
    }
    if (x.tag === 'Element' && y.tag === 'Element') {
        setAttrs(node, x.attrs, y.attrs, dispatch);
        reconcileChildren(d, node, x.children, y.children, dispatch);
    }
    return node;
}
function reconcileChildren(d, parent, before, after, dispatch) {
    // The existing nodes, in order, paired with the views they render.
    const nodes = [];
    for (let n = parent.firstChild; n !== null; n = n.nextSibling)
        nodes.push(n);
    const oldByKey = new Map();
    before.forEach((v, i) => {
        const k = keyOf(v);
        const n = nodes[i];
        if (k !== null && n !== undefined)
            oldByKey.set(k, { node: n, view: v });
    });
    const used = new Set();
    let cursor = parent.firstChild;
    after.forEach((v, i) => {
        const k = keyOf(v);
        let placed;
        if (k !== null && oldByKey.has(k)) {
            const old = oldByKey.get(k);
            if (old === undefined)
                throw new HostError('dom: keyed child vanished');
            placed = reconcile(d, parent, old.node, old.view, v, dispatch);
            if (placed !== cursor)
                parent.insertBefore(placed, cursor);
            else
                cursor = cursor.nextSibling;
        }
        else if (k === null && i < before.length && keyOf(before[i]) === null && nodes[i] !== undefined && !used.has(nodes[i])) {
            const n = nodes[i];
            placed = reconcile(d, parent, n, before[i], v, dispatch);
            if (placed === cursor)
                cursor = cursor.nextSibling;
            else if (cursor !== null && placed !== cursor)
                parent.insertBefore(placed, cursor);
        }
        else {
            placed = create(d, v, dispatch);
            parent.insertBefore(placed, cursor);
        }
        used.add(placed);
    });
    // Whatever remains after the last placed node is stale.
    const stale = [];
    for (let n = parent.firstChild; n !== null; n = n.nextSibling)
        if (!used.has(n))
            stale.push(n);
    for (const n of stale)
        parent.removeChild(n);
}
/** The tree rendered under each root, so `patch` and `run` can diff against it. */
const rendered = new WeakMap();
/** `std.view.patch`: with no previous tree the root is emptied and `next` rendered; otherwise reconciled. */
export function patch(root, previous, next, dispatch = () => undefined) {
    const d = document();
    const current = rendered.get(root.node);
    if (previous.tag === 'None' || current === undefined) {
        while (root.node.firstChild !== null)
            root.node.removeChild(root.node.firstChild);
        const node = create(d, next, dispatch);
        root.node.appendChild(node);
        rendered.set(root.node, { view: next, node });
        return;
    }
    const node = reconcile(d, root.node, current.node, current.view, next, dispatch);
    rendered.set(root.node, { view: next, node });
}
/** `std.view.run`: render, and on every message update and re-render (§22.3). Returns at once; the host's loop dispatches. */
/** Function values reach the runtime positionally (§19.3): `view(state)`, `update(state, msg)`. */
export function run(root, init, view, update) {
    let state = init;
    let stopped = false;
    const dispatch = (msg) => {
        if (stopped)
            return;
        const r = update(state, msg);
        if (r.tag === 'Err') {
            stopped = true;
            const c = globalThis.console;
            c?.error(`std.view.run: update returned Err: ${JSON.stringify(r.error)}`);
            return;
        }
        state = r.value;
        const current = rendered.get(root.node);
        patch(root, current === undefined ? { tag: 'None' } : { tag: 'Some', value: current.view }, view(state), dispatch);
    };
    patch(root, { tag: 'None' }, view(state), dispatch);
}
//# sourceMappingURL=dom.js.map