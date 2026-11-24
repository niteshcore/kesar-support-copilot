// Turns a file in code/ into the exact source that goes into an n8n node:
// inlines the shared helpers and the prompt files. Used by build_workflow.js and simulate.js,
// so the offline test runs the same code that the workflow runs.
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

function assemble(file, vars) {
  let src = read(path.join('code', file));
  src = src.replace(/^\/\/ @include (\S+)\s*$/gm, (_, inc) => read(path.join('code', inc)).trimEnd());
  src = src.replace(/__PROMPT:([a-z0-9_]+)__/g, (_, name) => JSON.stringify(read(path.join('prompts', name + '.md')).trim()));
  for (const [k, v] of Object.entries(vars || {})) src = src.split('__' + k + '__').join(String(v));
  const left = src.match(/__[A-Z_]+(:[a-z0-9_]+)?__/);
  if (left) throw new Error(file + ': unresolved placeholder ' + left[0]);
  return src;
}

module.exports = { ROOT, read, assemble };
