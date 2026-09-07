import assert from 'node:assert';
import { Config, SettingsSchema, apply, inject, name } from '../index.js';

assert.strictEqual(name, 'token-stack', 'name mismatch');
assert.ok(Array.isArray(inject), 'inject is not an array');
for (const dep of ['systemPrompt', 'fs', 'settings', 'tools']) {
  assert.ok(inject.includes(dep), `inject missing ${dep}`);
}
assert.strictEqual(typeof apply, 'function', 'apply is not a function');
assert.ok(Config, 'Config missing');
assert.ok(SettingsSchema, 'SettingsSchema missing');

console.log('[smoke] dsh-token-stack exports OK');
