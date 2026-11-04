import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Guards the things that rot silently in a static site: a README that links a
 * screenshot nobody committed, an import typo that only fails once deployed,
 * and — the important one here — a "nothing leaves the browser" promise that
 * the code stops keeping.
 *
 * The model itself is tested in journey.test.mjs, and the drawings in
 * render.test.mjs.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');
const exists = (...parts) => fs.existsSync(path.join(ROOT, ...parts));

const html = read('index.html');
const app = read('assets', 'app.js');
const journey = read('assets', 'journey.js');
const presets = read('assets', 'presets.js');
const render = read('assets', 'render.js');
const css = read('assets', 'style.css');

let readme = '';
try {
  readme = read('README.md');
} catch {
  // The README test below reports this as a failure with a useful message.
}

/** Anything that is not a remote URL, an anchor or an inline data URI. */
const isLocalRef = (ref) => ref && !/^(https?:|mailto:|data:|#|\/\/)/i.test(ref);

test('every local src/href in index.html exists on disk', () => {
  const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
    .map((match) => match[1])
    .filter(isLocalRef)
    .map((ref) => ref.split('?')[0].split('#')[0])
    .filter(Boolean);

  assert.ok(refs.length >= 3, 'expected stylesheet and script references');
  for (const ref of refs) {
    assert.equal(exists(ref), true, `index.html references missing file: ${ref}`);
  }
});

test('every relative import resolves to a real file', () => {
  const sources = [
    ['app.js', app],
    ['render.js', render],
  ];
  for (const [name, source] of sources) {
    const imports = [...source.matchAll(/from\s+'(\.[^']+)'/g)].map((match) => match[1]);
    assert.ok(imports.length > 0, `${name} should import the model`);
    for (const specifier of imports) {
      const target = path.join('assets', specifier);
      assert.equal(exists(target), true, `${name} imports missing file: ${target}`);
    }
  }
});

test('README exists and every screenshot it points at was committed', () => {
  assert.ok(readme.length > 0, 'README.md is missing');
  const refs = [...readme.matchAll(/docs\/screenshots\/[A-Za-z0-9._-]+\.png/g)].map((match) => match[0]);
  assert.ok(refs.length >= 5, 'README should show the captured screenshots');

  for (const ref of new Set(refs)) {
    assert.equal(exists(ref), true, `README references missing image: ${ref}`);
    assert.ok(fs.statSync(path.join(ROOT, ref)).size > 40 * 1024, `${ref} looks too small to be a real capture`);
  }
});

test('index.html has the metadata a shared link needs', () => {
  assert.match(html, /<html lang="[a-z]{2}/i);
  assert.match(html, /<meta charset="utf-8">/i);
  assert.match(html, /name="viewport"/i);
  assert.match(html, /<title>[^<]{20,}<\/title>/i);
  assert.match(html, /name="description" content="[^"]{80,}"/i);
  assert.match(html, /rel="icon"/i);
  assert.match(html, /property="og:title"/i);
  assert.match(html, /property="og:description"/i);
  assert.match(html, /property="og:image" content="https:\/\//i);
  assert.match(html, /name="twitter:card"/i);
});

test('the page explains itself without JavaScript, and announces updates with it', () => {
  assert.match(html, /<noscript>/i);
  assert.match(html, /id="summary"[^>]*aria-live="polite"|aria-live="polite"[^>]*id="summary"/i);
  assert.match(html, /<h1>[^<]{10,}<\/h1>/i);
  assert.equal((html.match(/<h1/g) || []).length, 1, 'the page should have exactly one h1');
});

test('every slider has a real label, a formatted output and a note where it needs one', () => {
  for (const id of ['rtt', 'serverMs', 'documentKb', 'assets', 'mbps']) {
    assert.match(html, new RegExp(`<label for="${id}"`), `${id} has no <label>`);
    assert.match(html, new RegExp(`id="${id}"`), `${id} input is missing`);
    assert.match(html, new RegExp(`<output id="${id}-out"`), `${id} has no output`);
    assert.match(app, new RegExp(`setOutput\\('${id}'`), `${id} is never updated`);
  }

  for (const name of ['dns', 'connection', 'tls', 'http']) {
    assert.match(html, new RegExp(`<fieldset[^>]*class="control segmented"`), 'expected segmented controls');
    assert.match(html, new RegExp(`name="${name}"`), `${name} radio group is missing`);
  }
});

test('the page loads nothing from a third party', () => {
  const remote = [...html.matchAll(/<(?:script|link)\b[^>]*(?:src|href)="(https?:[^"]+)"/g)].map(
    (match) => match[1]
  );
  assert.deepEqual(remote, [], 'index.html must not load remote scripts or styles');

  for (const [name, source] of [['app.js', app], ['render.js', render]]) {
    assert.equal(/from\s+'https?:/.test(source), false, `${name} imports from a CDN`);
  }
});

test('the page keeps its promise: no code path can send anything anywhere', () => {
  const forbidden = [
    /\bfetch\s*\(/,
    /\bXMLHttpRequest\b/,
    /\bWebSocket\b/,
    /\bsendBeacon\b/,
    /\bnew\s+Image\s*\(/,
    /\bnavigator\.sendBeacon\b/,
  ];

  for (const [name, source] of [
    ['app.js', app],
    ['journey.js', journey],
    ['presets.js', presets],
    ['render.js', render],
  ]) {
    for (const pattern of forbidden) {
      assert.equal(pattern.test(source), false, `${name} contains ${pattern}: the page claims no network`);
    }
  }
});

test('the only state is the URL: no cookies, no storage', () => {
  for (const source of [app, journey, render]) {
    assert.equal(/localStorage|sessionStorage|document\.cookie|indexedDB/i.test(source), false);
  }
  assert.match(app, /new URLSearchParams\(window\.location\.search\)|URLSearchParams\(location\.search\)/);
  assert.match(app, /history\.replaceState/);
});

test('the model module is pure: no DOM, no clock, no randomness', () => {
  const domAccess = /\b(?:document|window)\s*\.\s*(?:getElement|querySelector|querySelectorAll|body|createElement|createTextNode|addEventListener|documentElement|matchMedia|location|history)/;
  for (const [name, source] of [['journey.js', journey], ['render.js', render]]) {
    assert.equal(domAccess.test(source), false, `${name} touches the DOM`);
    assert.equal(/Math\.random|Date\.now|performance\.now/.test(source), false, `${name} is not deterministic`);
  }
});

test('the page says, in the places that matter, that this is a model', () => {
  assert.match(html, /not a measurement/i);
  assert.match(html, /<strong>This is a model, not a measurement\.<\/strong>/i);
  assert.match(html, /No cookies, no storage, no network requests/i);
  assert.match(readme, /not a measurement/i);
});

test('the layout variables and accessibility hooks are defined', () => {
  for (const token of ['--bg', '--panel', '--ink', '--muted', '--cyan', '--amber', '--violet', '--green', '--blue', '--rose', '--grey']) {
    assert.match(css, new RegExp(`${token}:`), `style.css is missing ${token}`);
  }
  assert.match(css, /prefers-reduced-motion/, 'style.css should respect reduced motion');
  assert.match(css, /:focus-visible/, 'style.css should show keyboard focus');
  assert.match(app, /prefers-reduced-motion/, 'app.js should respect reduced motion when playing');
});

test('no debugging leftovers in the shipped JavaScript', () => {
  for (const [name, source] of [['app.js', app], ['journey.js', journey], ['render.js', render], ['presets.js', presets]]) {
    assert.equal(/debugger;/.test(source), false, `${name} contains a debugger statement`);
    assert.equal(/console\.(log|debug|trace)\(/.test(source), false, `${name} logs to the console`);
    assert.equal(/TODO|FIXME|XXX/.test(source), false, `${name} has a leftover marker`);
  }
});

test('deep links are documented where they are implemented', () => {
  assert.match(app, /const KEYS = \[/);
  assert.match(app, /syncUrl/);
  assert.match(readme, /\?rtt=120/);
  assert.match(html, /id="model"/);
  assert.match(html, /id="limits"/);
});

test('the README documents how to run, test and read the limits', () => {
  assert.match(readme, /node --test/);
  assert.match(readme, /## Quick start/i);
  assert.match(readme, /## What this is not/i);
  assert.match(readme, /## Known limitations/i);
  assert.match(readme, /MIT/);
  assert.match(readme, /No install step/i);
  assert.match(readme, /tests-59%20passing/);
});
