// A fake document for the counter fixture (docs/CHANGES.md item 208): enough
// of the DOM for `std.view.run` to render into and for clicks to be delivered.
// Installs itself as `globalThis.document`, imports the built program, then
// clicks its buttons and prints the tree after each step.
//   node fake_dom.mjs <program.js> [args...]
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
class Node {
  constructor(type) { this.nodeType = type; this.parentNode = null; this.childNodes = []; this.listeners = new Map(); }
  get firstChild() { return this.childNodes[0] ?? null; }
  get nextSibling() {
    if (this.parentNode === null) return null;
    const i = this.parentNode.childNodes.indexOf(this);
    return this.parentNode.childNodes[i + 1] ?? null;
  }
  appendChild(child) { return this.insertBefore(child, null); }
  insertBefore(child, before) {
    if (child.parentNode !== null) child.parentNode.removeChild(child);
    const i = before === null ? this.childNodes.length : this.childNodes.indexOf(before);
    this.childNodes.splice(i < 0 ? this.childNodes.length : i, 0, child);
    child.parentNode = this;
    return child;
  }
  removeChild(child) {
    const i = this.childNodes.indexOf(child);
    if (i >= 0) this.childNodes.splice(i, 1);
    child.parentNode = null;
    return child;
  }
  addEventListener(kind, handler) { this.listeners.set(kind, handler); }
  removeEventListener(kind, handler) { if (this.listeners.get(kind) === handler) this.listeners.delete(kind); }
  dispatch(kind) { const h = this.listeners.get(kind); if (h !== undefined) h({ type: kind, preventDefault() {} }); }
}
class Text extends Node {
  constructor(text) { super(3); this.textContent = text; }
  render() { return this.textContent; }
}
class Element extends Node {
  constructor(tagName) { super(1); this.tagName = tagName; this.attributes = new Map(); }
  setAttribute(name, value) { this.attributes.set(name, value); }
  removeAttribute(name) { this.attributes.delete(name); }
  get textContent() { return this.childNodes.map((c) => c.textContent).join(''); }
  set textContent(text) { this.childNodes = []; if (text !== '') this.appendChild(new Text(text)); }
  render() {
    const attrs = [...this.attributes].map(([k, v]) => ` ${k}="${v}"`).join('');
    const listeners = [...this.listeners.keys()].sort().map((k) => ` @${k}`).join('');
    return `<${this.tagName}${attrs}${listeners}>${this.childNodes.map((c) => c.render()).join('')}</${this.tagName}>`;
  }
  find(id) {
    if (this.attributes.get('id') === id) return this;
    for (const c of this.childNodes) if (c instanceof Element) { const f = c.find(id); if (f !== null) return f; }
    return null;
  }
}
const body = new Element('body');
globalThis.document = {
  body,
  createElement: (tag) => new Element(tag),
  createTextNode: (text) => new Text(text),
  getElementById: (id) => body.find(id),
};
const program = process.argv[2];
const exit = process.exit;
process.exit = () => undefined; // the program's entry sets a status; keep the process alive for the steps below
await import(pathToFileURL(resolve(program)).href);
process.exit = exit;
const step = (label) => process.stdout.write(`${label}: ${body.render()}\n`);
step('rendered');
for (const id of ['inc', 'inc', 'dec', 'reset', 'inc']) {
  const target = body.find(id);
  if (target === null) { process.stdout.write(`no element ${id}\n`); break; }
  target.dispatch('click');
  step(`click ${id}`);
}
