// Release hygiene (CLAUDE.md): versions match, and the service worker's offline
// list covers every app file and nothing that doesn't exist.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { APP_VERSION } from '../../app/version.js';

const root = new URL('../../', import.meta.url);
const read = (p) => readFileSync(new URL(p, root), 'utf8');
const sw = read('sw.js');
const shell = JSON.parse(/const SHELL_FILES = (\[[\s\S]*?\]);/.exec(sw)[1]);

function walk(dir) {
  return readdirSync(new URL(dir, root)).flatMap((name) => {
    const rel = `${dir}${name}`;
    return statSync(new URL(rel, root)).isDirectory() ? walk(`${rel}/`) : [rel];
  });
}

test('APP_VERSION, service-worker cache version and package.json agree', () => {
  assert.equal(/const CACHE_VERSION = '([^']+)'/.exec(sw)[1], APP_VERSION);
  assert.equal(JSON.parse(read('package.json')).version, APP_VERSION);
});

test('every app, coach and icon file is cached for offline use', () => {
  const needed = [...walk('app/'), ...walk('coach/'), ...walk('icons/')];
  const missing = needed.filter((f) => !shell.includes(f));
  assert.deepEqual(missing, []);
});

test('every cached file exists', () => {
  assert.deepEqual(shell.filter((f) => !existsSync(new URL(f, root))), []);
});

test('index.html has the iOS PWA head tags (spec §3)', () => {
  const html = read('index.html');
  for (const needle of [
    'viewport-fit=cover', 'name="apple-mobile-web-app-capable" content="yes"', 'content="black-translucent"',
    'name="apple-mobile-web-app-title"', 'name="color-scheme" content="dark"', 'href="icons/apple-touch-icon-180.png"',
  ]) assert.ok(html.includes(needle), needle);
  const manifest = JSON.parse(read('manifest.webmanifest'));
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.start_url, './');
  assert.equal(manifest.theme_color, '#0A0A0B');
  assert.equal(manifest.background_color, '#0A0A0B');
  assert.deepEqual(manifest.icons.map((i) => i.sizes), ['192x192', '512x512']);
});

test('coach/ stays pure: no DOM or storage APIs', () => {
  for (const f of walk('coach/')) {
    const code = read(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    assert.ok(!/\b(document|window|localStorage|sessionStorage|indexedDB|navigator|fetch)\s*[.(]/.test(code), `${f} touches a browser API`);
  }
});
