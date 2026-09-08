// The counter fixture (docs/CHANGES.md item 208): installs the fake document,
// imports the built program, then clicks its buttons and prints the tree
// after each step.
//   node fake_dom.mjs <program.js> [args...]
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { install } from './fake_document.mjs';
const body = install();
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
