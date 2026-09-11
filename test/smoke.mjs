import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { Config, SettingsSchema, apply, inject, name } from '../index.js';

assert.strictEqual(name, 'token-stack', 'name mismatch');
assert.ok(Array.isArray(inject), 'inject is not an array');
for (const dep of ['systemPrompt', 'fs', 'settings', 'tools', 'tokenMeter', 'commands']) {
  assert.ok(inject.includes(dep), `inject missing ${dep}`);
}
assert.strictEqual(typeof apply, 'function', 'apply is not a function');
assert.ok(Config, 'Config missing');
assert.ok(SettingsSchema, 'SettingsSchema missing');

// Client half: the shipped bundle must be in the module-loader wrapper format.
const clientSrc = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
assert.ok(clientSrc.startsWith('window.__ModuleLoader__.load'), 'client bundle wrapper missing');
assert.ok(clientSrc.includes('dsh-token-stack'), 'client bundle id missing');

console.log('[smoke] dsh-token-stack exports OK');
