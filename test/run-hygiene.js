/*
  Repo hygiene and cross-file integrity.

  The other suites test behaviour. This one tests the things that go wrong
  between files, and the things that embarrass a public repository — both of
  which are invisible to any amount of runtime testing:

    - a getElementById for markup that no longer exists
    - a host function the panel calls that was renamed or deleted
    - functions nothing calls any more, left behind by a feature that was cut
    - a client's document name or copy sitting in a test fixture
    - a path that only exists on the machine the code was written on

  Every one of these has actually happened here. The dead-code check found two
  functions orphaned when Export CSV was removed, and the scrub found a real
  client filename in the mock host.

  Run:  node test/run-hygiene.js
*/

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const HTML = read('client/index.html');
const CSS = read('client/css/panel.css');
const PANEL = read('client/js/panel.js');
const CEP = read('client/js/cep.js');
const COLOR = read('client/js/color.js');
const HOST = read('host/index.jsx');
const CLIENT_JS = PANEL + '\n' + CEP + '\n' + COLOR;

let pass = 0, fail = 0;
const failures = [];

function ok(cond, label, extra) {
    if (cond) { pass++; console.log('PASS  ' + label); }
    else { fail++; failures.push(label); console.log('FAIL  ' + label + (extra ? '  -> ' + extra : '')); }
}
function section(t) { console.log('\n=== ' + t + ' ==='); }

const uniq = (a) => [...new Set(a)];
const matches = (s, re, group = 1) => uniq([...s.matchAll(re)].map(x => x[group]).filter(Boolean));

// ---------------------------------------------------------------------------
section('the panel and its markup agree');

const htmlIds = matches(HTML, /\bid="([^"]+)"/g);
const jsIds = uniq([...CLIENT_JS.matchAll(/\bel\('([^']+)'\)|getElementById\('([^']+)'\)/g)]
    .map(x => x[1] || x[2]));

const phantom = jsIds.filter(id => !htmlIds.includes(id));
ok(phantom.length === 0,
    'every element the panel reaches for exists in the markup', phantom.join(', '));

/*
  The other direction. Markup nothing references is either dead weight or a
  wiring bug where the handler was never attached — and the two look identical
  from the outside, which is why this is worth failing on.
*/
const unreferenced = htmlIds.filter(id =>
    !jsIds.includes(id) &&
    !CLIENT_JS.includes("'" + id + "'") &&
    !CSS.includes('#' + id));
ok(unreferenced.length === 0,
    'every id in the markup is used by the panel or the stylesheet',
    unreferenced.join(', '));

// ---------------------------------------------------------------------------
section('the panel and the host agree');

/*
  Calls made through a variable are still calls. `BRIDGE.call(fn, ...)` where fn
  was chosen a line earlier reads as an unused host function to anything that
  only looks at the call site, so collect the string literals too.
*/
const calledDirect = matches(CLIENT_JS, /BRIDGE\.call\('(\w+)'/g);
const calledIndirect = matches(CLIENT_JS, /'(wcag\w+)'/g);
const called = uniq(calledDirect.concat(calledIndirect));
const defined = matches(HOST, /^function (wcag\w+)\(/gm);

const missingHost = called.filter(f => !defined.includes(f));
ok(missingHost.length === 0,
    'every host function the panel calls is defined in the host', missingHost.join(', '));

const unusedHost = defined.filter(f => !called.includes(f));
ok(unusedHost.length === 0,
    'every host function is reachable from the panel', unusedHost.join(', '));

// ---------------------------------------------------------------------------
section('no orphaned code');

for (const [name, src] of [['panel.js', PANEL], ['cep.js', CEP], ['color.js', COLOR]]) {
    const fns = matches(src, /^\s*function (\w+)\s*\(/gm);
    const dead = fns.filter(f => {
        const uses = (src.match(new RegExp('\\b' + f + '\\b', 'g')) || []).length;
        // Declared once and never mentioned again — unless it is exported by
        // name, in which case the export IS the second mention.
        const exported = new RegExp('\\b' + f + ':\\s*' + f + '\\b').test(src);
        return uses <= 1 && !exported;
    });
    ok(dead.length === 0, name + ' has no functions nothing calls', dead.join(', '));
}

// ---------------------------------------------------------------------------
section('nothing personal, nothing local, nothing borrowed');

/*
  A public repository should carry no author's name, no client's material and no
  path from the machine it was built on. Fixtures are the usual leak: they get
  copied from whatever document was open at the time.

  Every file in the repository, discovered — not a list.

  A hand-maintained list is the wrong shape for this check: the file most likely
  to leak something is the one somebody added last week and did not think to add
  here. Walk the tree and skip only what git already ignores.
*/
const SKIP_DIRS = new Set(['node_modules', '.git', '.idea', '.vscode']);
/*
  Skip what is never committed anyway. macOS drops a .DS_Store into any folder it
  has been looked at in, and reading one as text made the sweep scan a binary blob
  full of filenames — a false positive waiting to happen, and a check count that
  changed depending on whose Finder had visited the folder.
*/
const SKIP_FILES = new Set(['.DS_Store', 'Thumbs.db', 'package-lock.json']);
function walk(dir, into) {
    for (const name of fs.readdirSync(path.join(ROOT, dir || '.'))) {
        const rel = dir ? dir + '/' + name : name;
        const stat = fs.statSync(path.join(ROOT, rel));
        if (stat.isDirectory()) {
            if (!SKIP_DIRS.has(name)) walk(rel, into);
        } else if (!SKIP_FILES.has(name) &&
                   !/\.(png|jpg|jpeg|gif|zxp|p12|lock)$/i.test(name)) {
            into.push(rel);
        }
    }
    return into;
}
const SHIPPED = walk('', []).sort();
ok(SHIPPED.length > 15, 'the sweep found the repository', SHIPPED.length + ' files');

/*
  Built from fragments rather than written as literals, so this file does not
  match its own patterns — the first version of this check failed on itself,
  which is funny once and noise forever.
*/
const FORBIDDEN = [
    ['/Users/(?!<you>)[a-z0-9._-]+', 'a real home directory path'],
    ['/home/[a-z0-9._-]+/', 'a build-machine path'],
    ['[a-z0-9._-]+@[a-z0-9.-]+\\.[a-z]{2,}', 'an email address'],
    ['npm' + '-global', 'a machine-specific module path'],
    ['My' + ' Drive', 'a cloud-drive path'],
    ['C:\\\\Users\\\\(?!<you>)[a-z0-9._-]+', 'a Windows home directory'],
    ['i' + 'Cloud|Drop' + 'box|One' + 'Drive|Google' + ' Drive', 'a personal cloud folder'],
    ['ssh-' + 'rsa |BEGIN [A-Z ]*PRIVATE ' + 'KEY', 'a key'],
    ['xox[baprs]-|ghp' + '_[A-Za-z0-9]{20}|sk' + '-[A-Za-z0-9]{20}', 'an API token']
].map(([source, what]) => [new RegExp(source, 'i'), what]);

for (const file of SHIPPED) {
    let src;
    try { src = read(file); } catch (e) { ok(false, file + ' exists'); continue; }

    const hits = [];
    for (const [re, what] of FORBIDDEN) {
        const m = src.match(re);
        // The Windows install path in the docs uses a literal <you> placeholder.
        if (m && !/<you>/.test(m[0])) hits.push(what + ': ' + m[0]);
    }
    ok(hits.length === 0, file + ' carries nothing identifying', hits.join('; '));
}

// ---------------------------------------------------------------------------
section('the extension ships without dependencies');

ok(!/require\s*\(/.test(CLIENT_JS.replace(/\/\*[\s\S]*?\*\//g, '')),
    'no module loader in the panel — it is loaded by <script> tags');
ok(!/\bimport\s+[\w{]/.test(CLIENT_JS), 'and no ES module syntax either');

const scripts = matches(HTML, /<script src="([^"]+)"/g);
ok(scripts.every(s => !/^https?:/.test(s)),
    'the panel loads nothing from the network', scripts.join(', '));

for (const s of scripts) {
    ok(fs.existsSync(path.join(ROOT, 'client', s)), 'client/' + s + ' exists');
}

// ---------------------------------------------------------------------------
section('the manifest matches what is on disk');

const MANIFEST = read('CSXS/manifest.xml');
const mainPath = (MANIFEST.match(/<MainPath>\.\/(.*?)<\/MainPath>/) || [])[1];
const scriptPath = (MANIFEST.match(/<ScriptPath>\.\/(.*?)<\/ScriptPath>/) || [])[1];
ok(mainPath && fs.existsSync(path.join(ROOT, mainPath)), 'MainPath points at a real file', mainPath);
ok(scriptPath && fs.existsSync(path.join(ROOT, scriptPath)), 'ScriptPath points at a real file', scriptPath);

const bundleVersion = (MANIFEST.match(/ExtensionBundleVersion="([^"]+)"/) || [])[1];
const extVersion = (MANIFEST.match(/<Extension Id="[^"]+" Version="([^"]+)"/) || [])[1];
const hostVersion = (HOST.match(/version: '([^']+)'/) || [])[1];
ok(bundleVersion === extVersion,
    'the bundle and extension versions match', bundleVersion + ' vs ' + extVersion);
ok(bundleVersion === hostVersion,
    'and the host reports the same version', bundleVersion + ' vs ' + hostVersion);

// ---------------------------------------------------------------------------
section('the documentation describes the code that is here');

/*
  Documentation drifts silently, and a wrong instruction is worse than a missing
  one — it costs someone an afternoon before they stop believing it. Every one of
  these has been wrong in this repository at some point.
*/
const SUITES = fs.readdirSync(path.join(ROOT, 'test'))
    .filter(f => /^run-.*\.js$/.test(f)).sort();
const PKG = JSON.parse(read('test/package.json'));

for (const suite of SUITES) {
    ok(PKG.scripts.test.indexOf(suite) >= 0,
        'npm test runs ' + suite, 'it is on disk but not in the test script');
}

const DOCS = ['README.md', 'INSTALL.md'];
const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight'];
for (const doc of DOCS) {
    const src = read(doc);

    /*
      "four suites" when there are five. "the other four suites" is a different
      claim — it counts everything except the one under discussion — so allow
      both the total and the total minus one when "other" precedes it.
    */
    const claims = [...src.matchAll(/\b(other )?(\w+) suites\b/g)]
        .map(m => ({ other: !!m[1], n: WORDS.indexOf(m[2].toLowerCase()) }));
    const wrong = claims.filter(c => c.n >= 0 &&
        c.n !== SUITES.length && !(c.other && c.n === SUITES.length - 1));
    ok(wrong.length === 0,
        doc + ' counts the test suites correctly',
        'says ' + wrong.map(c => WORDS[c.n]).join('/') + ', there are ' + SUITES.length);

    /*
      A hard-coded "134 checks" is a number nobody remembers to update, and once
      it is wrong the whole table reads as untrustworthy. The suites print their
      own counts; the docs should point at that instead of copying it.
    */
    const frozen = [...src.matchAll(/\b\d{2,} checks\b/g)].map(m => m[0]);
    ok(frozen.length === 0,
        doc + ' does not hard-code a check count that will go stale',
        frozen.join(', '));
}

/*
  The product is "Umbra Contrast Checker", and nothing else.

  The working name was carried in the bundle ID, the folder name and the menu
  entry, and Illustrator treats every one of those as the extension's identity —
  a stray one is a second product in the Extensions menu. It was also in the
  docs, where the only people it could reach are the ones reading them for the
  first time. It appears nowhere now, and this fails if it comes back.
*/
const OLD_NAME = new RegExp('umbra' + 'check|umbra' + '-check|UMBRA' + ' CHECK', 'i');
for (const file of SHIPPED) {
    if (file === 'test/run-hygiene.js') continue;   // it holds the pattern itself
    let src;
    try { src = read(file); } catch (e) { continue; }
    ok(!OLD_NAME.test(src), file + ' does not carry the old working name',
        (src.match(OLD_NAME) || [''])[0]);
}

/*
  Nothing in the panel navigates the panel away.

  A CEP panel is a chrome-less webview with no back button, so an <a href> does
  not open a page — it REPLACES the extension with one, and the only way back is
  reloading the panel. Every outbound link goes through cep.util's browser
  opener instead, which is why they are buttons. run-panel.js checks this inside
  the options popover; a link anywhere else in the markup is the same bug.
*/
ok(!/<a\s[^>]*href=/i.test(HTML),
    'the markup contains no <a href> that would replace the panel with a web page',
    (HTML.match(/<a\s[^>]*href=[^>]*>/i) || [''])[0]);

// ---------------------------------------------------------------------------
section('house style: no long dashes in anything a person reads as prose');

/*
  Em dashes and en dashes are out. Every documentation file, every issue
  template, and every string the panel puts on screen uses commas, full stops
  and rewritten sentences instead.

  Code is exempt on purpose. A comment working through a compositing model can
  use whatever punctuation makes it clearest, and so can a fenced example. What
  ships to a reader cannot.

  Written as escapes rather than as the characters themselves so this file does
  not fail its own check.
*/
const LONG_DASH = new RegExp('[—–]');

for (const file of SHIPPED.filter(f => /\.(md|yml|yaml)$/.test(f))) {
    let src;
    try { src = read(file); } catch (e) { continue; }
    // Fenced blocks and inline code are code, and code is exempt.
    const prose = src.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');
    const line = prose.split('\n').find(l => LONG_DASH.test(l));
    ok(!line, file + ' uses no long dash in its prose', (line || '').trim());
}

/*
  The panel's own copy. Tooltips and accessible names are read by a person, so
  the same rule applies to them as to the documentation, and they are easy to
  miss because nothing renders them until you hover or turn on a screen reader.
*/
const spoken = [...HTML.matchAll(/(?:title|aria-label|placeholder)="([^"]*)"/g)]
    .map(m => m[1]).filter(v => LONG_DASH.test(v));
ok(spoken.length === 0,
    'no long dash in a tooltip or an accessible name', spoken.join(' / '));

/*
  Features that were removed on purpose. They may be discussed in a history or
  changelog section, but must not appear in the instructions as if they were
  still there — "click Swap" for a button that no longer exists.
*/
// ---------------------------------------------------------------------------
section('the licence travels with the code');

/*
  This is not open source. The licence grants use, not redistribution, and it
  forbids stripping the notice. A notice that only exists in one file at the
  root does not travel with a copied file, so every source file carries it.
*/
const NOTICE = 'Copyright (c) 2026 Artchemy Labs LLC';
const SOURCES = ['client/index.html', 'client/css/panel.css', 'client/js/panel.js',
                 'client/js/cep.js', 'client/js/color.js', 'host/index.jsx'];
for (const file of SOURCES) {
    ok(read(file).indexOf(NOTICE) >= 0, file + ' carries the copyright notice');
}

const LICENCE = read('LICENSE');
ok(LICENCE.indexOf(NOTICE) >= 0, 'LICENSE names the copyright holder');
ok(!/\bMIT\b/.test(LICENCE), 'and is no longer the MIT text it started as');
ok(!/\bMIT\b/.test(read('README.md')), 'the README does not still advertise MIT');

/*
  The debug port exposes the panel to Chrome DevTools. It is a local
  convenience, and a shipped extension has no business carrying one, so it is
  gitignored rather than committed. tools/package.sh refuses to build with one
  present; this stops it being committed in the first place.
*/
ok(!fs.existsSync(path.join(ROOT, '.debug')),
    'no .debug file is committed, so no build can inherit one');

// ---------------------------------------------------------------------------
section('removed controls leave nothing behind');

const GONE = ['btn-swap', 'btn-health', 'btn-export',
    // 1.10.0: the scan, which nobody used, and everything it needed.
    'btn-scan-toggle', 'btn-scan', 'btn-select-fails', 'scan-body', 'scan-list',
    'scan-scope', 'scan-summary', 'scan-count', 'scan-fails-only', 'scan-caret',
    // 1.11.0: the Render button, which nobody could tell the purpose of, and
    // Diagnose, which was always meant to come out once the panel had settled.
    'btn-refresh', 'btn-diagnose', 'btn-diag-copy', 'btn-diag-close', 'diag-out',
    'diag-actions'];
for (const id of GONE) {
    ok(!CLIENT_JS.includes("'" + id + "'") && !HTML.includes('"' + id + '"'),
        'the removed control ' + id + ' leaves nothing behind');
}

/*
  A removed feature also has to leave the HOST and the stylesheet. The scan's
  host half walked every text frame in the document and kept a second set of
  page item handles alive between calls; finding either back in the file would
  mean the cost came back without the feature.
*/
for (const fn of ['wcagScan', 'wcagSelectTokens', 'chooseArtboard', 'artboardHolding',
                  'wcagSnapshot', 'wcagSnapshotView', 'captureRect', 'wcagCleanupSnapshots',
                  'wcagDiagnose']) {
    ok(!new RegExp('function ' + fn + '\\(').test(HOST),
        'the host no longer defines ' + fn);
}
ok(!/WCAG_REG_SCAN/.test(HOST), 'and keeps no second registry of stored handles');
/*
  imageCapture drives the same rasteriser as Save For Web and was the least
  stable API the host touched: its failures are often native, so no try block
  sees them. The Render button was its only caller. It must not creep back in.
*/
ok(!/\.imageCapture\(/.test(HOST), 'the host never calls imageCapture');
ok(!/\.diag-|#diag-/.test(CSS), 'the stylesheet carries no diagnose rules');
ok(!/\.scan-|#scan-/.test(CSS), 'the stylesheet carries no scan rules');

// ---------------------------------------------------------------------------
console.log('\n' + pass + ' passed, ' + fail + ' failed');
if (fail) {
    console.log('\nFailures:');
    failures.forEach(f => console.log('  - ' + f));
    process.exitCode = 1;
}
