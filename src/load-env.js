const fs = require('node:fs');
const path = require('node:path');

function loadEnvFile(filePath = path.resolve(__dirname, '..', '.env')) {
  if (!fs.existsSync(filePath)) return [];
  const loaded = [];
  for (const line of fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    const [, name] = match;
    if (Object.hasOwn(process.env, name)) continue;
    let value = match[2];
    if (value.length >= 2 && ((value[0] === '"' && value.at(-1) === '"') || (value[0] === "'" && value.at(-1) === "'"))) {
      const quote = value[0];
      value = value.slice(1, -1);
      if (quote === '"') value = value.replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    } else {
      value = value.replace(/\s+#.*$/, '').trim();
    }
    process.env[name] = value;
    loaded.push(name);
  }
  return loaded;
}

module.exports = { loadEnvFile };
