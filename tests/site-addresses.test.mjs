// node --test tests/site-addresses.test.mjs
// Nothing may depend on the old github.io site once it is switched off.
// Sabel's own pages read from the site they are on; a link handed to a client
// is that client's own address /c/<hub>/ once their hub is published, and the
// old site only until then.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => readFileSync(resolve(ROOT, f), 'utf8');
const HUBS = 'https://hubs.sabelcustomersuccess.com/';
const OLD = 'https://sabel-intercom.github.io/Intake-forms/';
function slice(src, from, to) {
  const a = src.indexOf(from), b = src.indexOf(to, a + from.length);
  assert.ok(a >= 0 && b > a, `markers not found: ${from} ... ${to}`);
  return src.slice(a, b);
}
const at = (href) => { const u = new URL(href); return { protocol: u.protocol, origin: u.origin, hostname: u.hostname, pathname: u.pathname }; };
const run = (code, ctx) => vm.runInContext(code, vm.createContext({ encodeURIComponent, String, RegExp, ...ctx }));

test('team pages read the client list and tracker files from the site they are on', () => {
  const pages = {
    'SabelKickoffDesk.html': /BASE=([^,]+\/'), KEY=/,
    'SabelPortfolioDashboard_v2.html': /var BASE = ([^;]+);/,
    'SabelTaskHub.html': /const BASE=([^;]+);/,
    'SabelInternalOps.html': /const PAGES = ([^;]+);/,
  };
  for (const [file, re] of Object.entries(pages)) {
    const expr = re.exec(read(file));
    assert.ok(expr, file);
    assert.equal(run(expr[1], { location: at(HUBS + 'SabelTaskHub') }), HUBS, file);
    assert.equal(run(expr[1], { location: at('https://abc123.sabel-hubs.pages.dev/SabelTaskHub') }), 'https://abc123.sabel-hubs.pages.dev/', file);
    assert.equal(run(expr[1], { location: at('http://localhost:8000/SabelTaskHub.html') }), 'http://localhost:8000/', file);
    assert.equal(run(expr[1], { location: at('file:///Users/x/SabelTaskHub.html') }), HUBS, file);
  }
});

test('Kick-off Desk: the team link is the staff address; the client link is /c/<hub>/ once published, the old site until then', () => {
  const code = slice(read('SabelKickoffDesk.html'), "var OLD_SITE=", 'function trackerOf(');
  const x = { name: 'RMS Cloud', r: { hubKey: { slug: 'rms', k: 'ea2c08a55b3877bd', rdy: 'rms' } } };
  const q = '?client=rms&k=ea2c08a55b3877bd&rdy=rms&name=RMS%20Cloud';
  const link = (reg, team) => run(code + '\nformLink(x,team);', { BASE: HUBS, x, team, trackerOf: () => reg });
  assert.equal(link({ hub: 'rms-cloud' }, true), HUBS + 'SabelKickoff.html' + q + '&team=1');
  assert.equal(link({ hub: 'rms-cloud' }, false), HUBS + 'c/rms-cloud/SabelKickoff' + q);
  for (const reg of [null, {}, { hub: '' }, { hub: '../x' }, { hub: 'Has Space' }, { hub: 'a/b' }])
    assert.equal(link(reg, false), OLD + 'SabelKickoff.html' + q, JSON.stringify(reg));
});

test('Internal Ops: readiness and migration links for a client follow the same rule', () => {
  const code = slice(read('SabelInternalOps.html'), 'const OLD_SITE = ', '\n}\n') + '\n}\n';
  const url = (reg) => run(code + '\nclientFormUrl({}, "SabelReadinessCheck", "?client=elmo&name=ELMO");', {
    PAGES: HUBS, trackerKeyFor: () => 'elmo-tracker-v1', S: { reg },
  });
  assert.equal(url([{ key: 'elmo-tracker-v1', hub: 'elmo' }]), HUBS + 'c/elmo/SabelReadinessCheck?client=elmo&name=ELMO');
  for (const reg of [[], [{ key: 'elmo-tracker-v1' }], [{ key: 'other-tracker-v1', hub: 'other' }], [{ key: 'elmo-tracker-v1', hub: 'x/../y' }]])
    assert.equal(url(reg), OLD + 'SabelReadinessCheck.html?client=elmo&name=ELMO', JSON.stringify(reg));
  const src = read('SabelInternalOps.html');
  assert.ok(!/PAGES\+"Sabel(ReadinessCheck|MigrationIntake)/.test(src), 'a client form link still built from the plain staff address');
});

test('kick-off form: its readiness link stays at the address it was opened from', () => {
  const src = read('SabelKickoff.html');
  const code = slice(src, 'var BASE   = ', 'var ') + slice(src, 'var HERE   = ', '\n');
  const link = (href) => run(code + "\nBASE+(HERE?HERE+'SabelReadinessCheck':'SabelReadinessCheck.html')", { location: at(href) });
  assert.ok(src.includes("return BASE+(HERE?HERE+'SabelReadinessCheck':'SabelReadinessCheck.html')+'?client='"));
  assert.equal(link(HUBS + 'c/rms-cloud/SabelKickoff'), HUBS + 'c/rms-cloud/SabelReadinessCheck');
  assert.equal(link(HUBS + 'SabelKickoff'), HUBS + 'SabelReadinessCheck.html');
  assert.equal(link(OLD + 'SabelKickoff.html'), OLD + 'SabelReadinessCheck.html');
  assert.equal(link(HUBS + 'c/Bad Slug/SabelKickoff'), HUBS + 'SabelReadinessCheck.html');
});

test('a published hub names this site as its own address', () => {
  const list = JSON.parse(read('trackers.json'));
  for (const t of list.filter(t => t.hub)) {
    const m = /const PROG_URL="([^"]*)"/.exec(read(t.file));
    if (m) assert.equal(m[1], HUBS + t.file.replace(/\.html$/, ''), t.file);
  }
});

// What is still allowed to name the old site, and why. Anything else fails.
test('the old site is named only where it is still needed', () => {
  const allowed = {
    // forwards visitors off the old copy, and maps old saved form links
    'hub-auth.js': 3,
    // a client whose hub is not published yet still gets the old link
    'SabelKickoffDesk.html': 1, 'SabelInternalOps.html': 1,
    // the form itself still runs on the old copy for those clients
    'SabelKickoff.html': 2,
    // switched by onboard-hub when the hub is published; wording in its report
    'scripts/onboard-hub.mjs': 4,
  };
  const count = (f) => read(f).split('github.io').length - 1;
  for (const f of [...readdirSync(ROOT).filter(f => /\.(html|js|json)$/.test(f)), ...readdirSync(resolve(ROOT, 'scripts')).map(f => 'scripts/' + f), ...readdirSync(resolve(ROOT, 'functions'), { recursive: true }).filter(f => /\.js$/.test(f)).map(f => 'functions/' + f)]) {
    const src = read(f);
    // A client hub: only its saved form links and, until it is published, its own address.
    const hub = /\.html$/.test(f) && (/const PROG_URL=/.test(src) || /"link": "https:\/\/sabel-intercom\.github\.io/.test(src));
    if (hub) {
      const rest = src.replace(/"(link|src)": "https:\/\/sabel-intercom\.github\.io\/Intake-forms\/Sabel[A-Za-z_]+\.html[^"]*"/g, '').replace(/const PROG_URL="https:\/\/sabel-intercom\.github\.io\/Intake-forms\/[A-Za-z0-9_]+\.html"/, '');
      assert.ok(!rest.includes('github.io'), `${f}: the old site is named outside a saved form link`);
      continue;
    }
    assert.ok(count(f) <= (allowed[f] || 0), `${f}: names the old site ${count(f)} times, ${allowed[f] || 0} allowed`);
  }
});
