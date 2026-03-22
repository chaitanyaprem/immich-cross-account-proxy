/**
 * Config loader — reads config.yml from the project root.
 * Falls back to env vars for CI/container deployments.
 */

const fs = require('fs');
const path = require('path');

function loadConfig() {
  const configPath = path.resolve(process.cwd(), 'config.yml');

  if (!fs.existsSync(configPath)) {
    throw new Error(
      `config.yml not found at ${configPath}.\n` +
      `Copy config.example.yml to config.yml and fill in your values.`
    );
  }

  // Minimal YAML parser for our simple structure (avoids a dependency)
  const raw = fs.readFileSync(configPath, 'utf8');
  const config = parseYaml(raw);

  validate(config);
  return config;
}

/**
 * Minimal YAML parser sufficient for our config schema.
 * Handles: strings, numbers, booleans, arrays of objects with indentation.
 */
function parseYaml(text) {
  // Strip comments
  const lines = text.split('\n').map(l => l.replace(/#.*$/, '').trimEnd());

  const result = {};
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }

    const topMatch = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*):\s*(.*)/);
    if (!topMatch) { i++; continue; }

    const key = topMatch[1];
    const val = topMatch[2].trim();

    if (val === '') {
      // Could be a list or nested object — look ahead
      const nextLines = [];
      let j = i + 1;
      while (j < lines.length && (lines[j].startsWith('  ') || !lines[j].trim())) {
        nextLines.push(lines[j]);
        j++;
      }
      result[key] = parseBlock(nextLines);
      i = j;
    } else {
      result[key] = parseScalar(val);
      i++;
    }
  }

  return result;
}

function parseBlock(lines) {
  // List of objects (each starting with '  -')
  if (lines.some(l => l.match(/^\s+-\s+/))) {
    const items = [];
    let current = null;
    for (const line of lines) {
      if (!line.trim()) continue;
      const itemStart = line.match(/^(\s+)-\s+(.*)/);
      if (itemStart) {
        const rest = itemStart[2].trim();
        current = {};
        items.push(current);
        const kv = rest.match(/^([a-zA-Z_][a-zA-Z0-9_]*):\s*(.*)/);
        if (kv) current[kv[1]] = parseScalar(kv[2].trim());
      } else {
        const kv = line.match(/^\s+([a-zA-Z_][a-zA-Z0-9_]*):\s*(.*)/);
        if (kv && current) {
          const v = kv[2].trim();
          // Handle inline arrays like: can_act_as: ["Bob"]
          if (v.startsWith('[')) {
            current[kv[1]] = v.replace(/[\[\]"']/g, '').split(',').map(s => s.trim()).filter(Boolean);
          } else {
            current[kv[1]] = parseScalar(v);
          }
        }
      }
    }
    return items;
  }
  return {};
}

function parseScalar(val) {
  if (val === 'true') return true;
  if (val === 'false') return false;
  if (val === 'null' || val === '') return null;
  if (/^\d+$/.test(val)) return parseInt(val, 10);
  return val.replace(/^["']|["']$/g, ''); // strip surrounding quotes
}

function validate(config) {
  if (!config.immich_url) throw new Error('config: immich_url is required');
  if (!Array.isArray(config.accounts) || config.accounts.length === 0)
    throw new Error('config: at least one account is required');

  for (const acct of config.accounts) {
    if (!acct.name) throw new Error('config: each account needs a name');
    if (!acct.api_key) throw new Error(`config: account "${acct.name}" needs an api_key`);
    if (!acct.user_id) throw new Error(`config: account "${acct.name}" needs a user_id`);
  }
}

module.exports = { loadConfig };
