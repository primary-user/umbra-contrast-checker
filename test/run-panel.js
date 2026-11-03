/*
  Headless panel test.

  Loads the real index.html, panel.css, color.js, cep.js and panel.js into jsdom,
  swaps Illustrator for the mock host, and drives the UI the way a user would.
  Catches wiring, rendering and event bugs without needing Illustrator.

  Run:  node test/run-panel.js
*/

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { makeHost } = require('./mock-host');

const ROOT = path.join(__dirname, '..');
const CLIENT = path.join(ROOT, 'client');

let pass = 0, fail = 0;
const failures = [];
const openWindows = [];   // panel.js runs setInterval; jsdom keeps node alive unless we close
const sharedStorage = {}; // stands in for the extension's localStorage across boots

function ok(cond, label, extra) {
    if (cond) { pass++; console.log('PASS  ' + label); }
    else { fail++; failures.push(label); console.log('FAIL  ' + label + (extra ? '  → ' + extra : '')); }
}

function section(title) { console.log('\n=== ' + title + ' ==='); }

/*
  Canvas is not implemented in jsdom. Stub just enough for the preview and
  eyedropper paths.

  `pixel` is either a fixed [r,g,b], or the string 'xy' for a colour derived
  from the coordinates being read. The coordinate mode is what makes the
  crosshair maths testable: if the panel samples the wrong pixel — the middle of
  the image instead of the pointer, or the scaled display canvas instead of the
  native one — the returned colour changes, and the assertion catches it.
*/
function pixelAt(pixel, x, y) {
    if (pixel === 'xy') return [10 + x * 10, 20 + y * 10, 30];
    return [pixel[0], pixel[1], pixel[2]];
}

function stubCanvas(win, pixel) {
    win.HTMLCanvasElement.prototype.getContext = function () {
        return {
            fillStyle: '',
            strokeStyle: '',
            lineWidth: 1,
            imageSmoothingEnabled: true,
            fillRect() {},
            strokeRect() {},
            drawImage() {},
            beginPath() {},
            moveTo() {},
            lineTo() {},
            stroke() {},
            getImageData(x, y) {
                const rgb = pixelAt(pixel, x, y);
                return { data: [rgb[0], rgb[1], rgb[2], 255] };
            }
        };
    };
    Object.defineProperty(win.HTMLCanvasElement.prototype, 'width', {
        get() { return this._w || 220; }, set(v) { this._w = v; }, configurable: true
    });
    Object.defineProperty(win.HTMLCanvasElement.prototype, 'height', {
        get() { return this._h || 92; }, set(v) { this._h = v; }, configurable: true
    });
}

/*
  `keepPrefs` models a panel RELOAD: a new page against storage that survived.
  Every other boot starts clean, so one section cannot silently configure the
  next — the settings really do persist now, which makes leakage between tests a
  live hazard rather than a theoretical one.
*/
function boot(pixel, keepPrefs) {
    if (!keepPrefs) {
        for (const k of Object.keys(sharedStorage)) delete sharedStorage[k];
    }

    /*
      Close the previous panel first.

      Every booted window keeps its own poll chain and loupe chain running, and
      leaving twenty of them alive by the end of the suite made the shared event
      loop late enough that timing-sensitive assertions became flaky — the
      failure looked like a bug in the panel rather than in the harness.
    */
    closeAll();

    const html = fs.readFileSync(path.join(CLIENT, 'index.html'), 'utf8');
    const host = makeHost();
    const errors = [];

    const dom = new JSDOM(html, {
        runScripts: 'outside-only',
        pretendToBeVisual: true,
        url: 'file://' + CLIENT + '/index.html'
    });

    const win = dom.window;
    win.onerror = (msg) => errors.push(String(msg));
    // Asks the panel to expose its read-only probe. Nothing in Illustrator sets this.
    win.__UMBRA_TEST__ = true;

    host.install(win);
    stubCanvas(win, pixel || [14, 140, 130]);

    // jsdom has no layout, so element boxes read as zero. Give the snapshot
    // frame and canvas believable dimensions.
    win.Element.prototype.getBoundingClientRect = function () {
        return { left: 0, top: 0, right: 220, bottom: 92, width: 220, height: 92, x: 0, y: 0 };
    };
    Object.defineProperty(win.Element.prototype, 'clientWidth', { get() { return 220; }, configurable: true });
    Object.defineProperty(win.Element.prototype, 'clientHeight', { get() { return 92; }, configurable: true });

    /*
      One storage across boots, because that is what a panel reload is.

      Each JSDOM window gets its own localStorage, so a saved setting would look
      lost on the next boot no matter what the panel did — the harness would
      guarantee the test could never fail for the right reason. A CEP panel
      reload is a new page against the SAME storage; model that.
    */
    Object.defineProperty(win, 'localStorage', {
        configurable: true,
        value: {
            getItem: (k) => (k in sharedStorage ? sharedStorage[k] : null),
            setItem: (k, v) => { sharedStorage[k] = String(v); },
            removeItem: (k) => { delete sharedStorage[k]; },
            clear: () => { for (const k of Object.keys(sharedStorage)) delete sharedStorage[k]; }
        }
    });

    win.URL.createObjectURL = () => 'blob:mock';
    win.URL.revokeObjectURL = () => {};

    // jsdom's Image never fires load for data URLs; fire it synchronously.
    class FakeImage {
        constructor() { this.width = 4; this.height = 4; }
        set src(v) { this._src = v; if (this.onload) setTimeout(() => this.onload(), 0); }
        get src() { return this._src; }
    }
    win.Image = FakeImage;

    for (const file of ['js/color.js', 'js/cep.js', 'js/panel.js']) {
        try {
            win.eval(fs.readFileSync(path.join(CLIENT, file), 'utf8'));
        } catch (e) {
            errors.push(file + ': ' + e.message);
        }
    }

    // jsdom fires its own DOMContentLoaded once parsing settles. Only force one
    // if the document is already past that point, otherwise boot runs twice.
    if (win.document.readyState !== 'loading') {
        win.document.dispatchEvent(new win.Event('DOMContentLoaded'));
    }

    openWindows.push(win);
    return { win, doc: win.document, host, errors };
}

function closeAll() {
    for (const w of openWindows) {
        try { w.close(); } catch (e) {}
    }
    openWindows.length = 0;
}

const wait = (ms) => new Promise(r => setTimeout(r, ms));
const txt = (doc, id) => (doc.getElementById(id) || {}).textContent;
const click = (doc, id) => doc.getElementById(id).dispatchEvent(
    new (doc.defaultView.MouseEvent)('click', { bubbles: true })
);
const press = (doc, key) => doc.dispatchEvent(
    new (doc.defaultView.KeyboardEvent)('keydown', { key, bubbles: true, cancelable: true })
);
const clickCanvas = (win, doc, x, y) => doc.getElementById('snapshot').dispatchEvent(
    new win.MouseEvent('click', { bubbles: true, clientX: x, clientY: y })
);

/*
  "Auto" is a mode, not a label: it stays lit while the panel reads the artwork
  and dims the moment a colour is overridden by hand. These read that state.
*/
const isAuto = (doc) => doc.getElementById('mode-chip').className.indexOf('on') >= 0;
const overridden = (doc) => doc.getElementById('mode-chip').className.indexOf('off') >= 0;
const dotSet = (doc, side) =>
    doc.getElementById('dot-' + side).className.indexOf('set') >= 0;
const chipTip = (doc) => doc.getElementById('mode-chip').getAttribute('title') || '';

/*
  The panel's internal counters, read through the probe it exposes to the
  harness. Diagnose used to be the only window onto these; it is gone, so the
  facts arrive as data instead of as lines to pattern-match.
*/
async function probe(win) {
    await wait(80);
    return win.__umbraProbe();
}

(async function main() {

    section('boot with a selection');
    let { win, doc, host, errors } = boot();
    await wait(80);

    ok(errors.length === 0, 'no script errors on boot', errors.join(' | '));
    ok(txt(doc, 'status-dot') === 'live', 'status shows live', txt(doc, 'status-dot'));
    ok(txt(doc, 'ratio') === '4.12', 'ratio reads 4.12 for white on teal', txt(doc, 'ratio'));
    ok(doc.getElementById('ratio').className.includes('fail'), 'ratio styled as failing');
    ok(txt(doc, 'hex-fg') === '#FFFFFF', 'foreground hex', txt(doc, 'hex-fg'));
    ok(txt(doc, 'hex-bg') === '#0E8C82', 'background hex', txt(doc, 'hex-bg'));
    ok(/12pt body text/.test(txt(doc, 'ratio-note')), 'note names the size class', txt(doc, 'ratio-note'));

    section('AA/AAA matrix');
    ok(txt(doc, 'm-normal-aa') === '✕', 'normal AA fails at 4.12');
    ok(txt(doc, 'm-normal-aaa') === '✕', 'normal AAA fails');
    ok(txt(doc, 'm-large-aa') === '✓', 'large AA passes');
    ok(txt(doc, 'm-large-aaa') === '✕', 'large AAA fails');
    ok(txt(doc, 'm-graphic-aa') === '✓', 'graphic passes');

    section('the rung swatches appear only when the slider cannot help');
    /*
      Measured over 3,504 failing pairs: the brightness slider alone reaches AA
      for 78.6% of them, the swatches add 4.1% the slider cannot reach at that
      hue, and for 17.3% nothing on this side works at all.

      So for four cases in five the row duplicated what the slider marks already
      offer, in 34px of a 240px panel. White on teal is one of those: brightness
      alone gets there, so the row stays away.
    */
    ok(doc.getElementById('fix-block').hidden === true,
        'white on teal is reachable by brightness, so no swatches are shown');
    ok(doc.querySelectorAll('#bg-marks .mark').length > 0,
        'the slider carries the thresholds instead');

    /*
      Now a pair where brightness genuinely cannot do it: #B1548B pink on
      #76318F purple, 1.73:1. No brightness of that pink clears AA against that
      purple — the saturation is what has to move — so the swatches become the
      only way through, and #FFA7DB at 4.53:1 is what they offer.
    */
    ({ win, doc, host, errors } = boot());
    host.recolour('foreground', [0xB1, 0x54, 0x8B]);
    host.recolour('background', [0x76, 0x31, 0x8F]);
    await wait(1200);

    ok(doc.getElementById('fix-block').hidden === false,
        'when no brightness passes, the swatches appear');
    let fixes = doc.querySelectorAll('#fixes .fix');
    ok(fixes.length === 3, 'three rungs, one per WCAG threshold', String(fixes.length));

    const rungLabels = [...fixes].map(f => f.querySelector('.rung-label').textContent);
    ok(rungLabels.join(',') === '3:1,4.5:1,7:1', 'labelled with the thresholds themselves',
        rungLabels.join(','));
    ok(/No brightness passes/.test(doc.querySelector('.block-head span').textContent),
        'and the header says why they are there',
        doc.querySelector('.block-head span').textContent);

    const blockedRungs = [...fixes].filter(f => f.className.indexOf('blocked') >= 0);
    ok(blockedRungs.length > 0, 'unreachable rungs are marked, not dropped',
        [...fixes].map(f => f.className).join(' | '));
    ok(/1\.4\./.test(fixes[2].title), 'each citing its success criterion', fixes[2].title);

    // Stay on the pink-on-purple pair: it is exactly the case where the rung
    // swatches are the only route, so it is the right one to apply from.

    section('applying a fix');
    const applyBefore = host.applied().length;
    const applicable = [...fixes].filter(b => !b.disabled);
    ok(applicable.length > 0, 'there is a rung to apply', String(fixes.length));
    applicable[0].dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await wait(120);
    ok(host.applied().length === applyBefore + 1, 'apply reached the host',
        JSON.stringify(host.applied()));
    const wrote = host.applied()[host.applied().length - 1];
    /*
      Asserted by SIDE, not token name. The host clears its registry and reissues
      token names on every read, so a name is an implementation detail; which
      side of the pair was written is the intent.
    */
    ok(wrote.side === 'foreground' || wrote.side === 'background',
        'writing to one of the two objects the panel is measuring', wrote.side);
    ok(/changing text/.test(txt(doc, 'fix-target'))
        ? wrote.side === 'foreground' : wrote.side === 'background',
        'and it is the side the label named',
        txt(doc, 'fix-target') + ' -> ' + wrote.side);
    ok(/Applied|Fill set|Set /.test(txt(doc, 'fix-note')), 'confirmation shown', txt(doc, 'fix-note'));

    section('fix target can be overridden by clicking the label');
    // Still the pink-on-purple pair, because that is where the row is visible.
    ({ win, doc, host, errors } = boot());
    host.recolour('foreground', [0xB1, 0x54, 0x8B]);
    host.recolour('background', [0x76, 0x31, 0x8F]);
    await wait(1200);
    const startedOn = txt(doc, 'fix-target');
    ok(/changing/.test(startedOn), 'the label names a side to begin with', startedOn);
    click(doc, 'fix-target');
    await wait(120);
    ok(txt(doc, 'fix-target') !== startedOn, 'clicking it switches sides',
        startedOn + ' -> ' + txt(doc, 'fix-target'));
    /*
      Whichever side is now targeted, the panel must still offer a route: either
      swatches, or a brightness slider with a passing stretch on it. "Neither" is
      the one state that would leave someone stuck with no next move.
    */
    const otherSide = /changing text/.test(txt(doc, 'fix-target')) ? 'fg' : 'bg';
    const hasSwatches = doc.querySelectorAll('#fixes .fix').length > 0;
    const hasZone = doc.querySelectorAll('#' + otherSide + '-marks .zone').length > 0;
    ok(hasSwatches || hasZone,
        'and the other side still has a route through — swatches or a passing stretch',
        'swatches:' + hasSwatches + ' zone:' + hasZone);

    section('large heading scenario (white on blue)');
    ({ win, doc, host, errors } = boot());
    host.setScenario('blueHeading');
    await wait(700);
    // 8.0469... The panel truncates rather than rounding, so the printed figure
    // is always a ratio the artwork actually reaches.
    ok(txt(doc, 'ratio') === '8.04', 'ratio 8.04 for white on blue', txt(doc, 'ratio'));
    ok(doc.getElementById('ratio').className.includes('pass'), 'styled as passing');
    ok(/large text/.test(txt(doc, 'ratio-note')), 'detected as large text', txt(doc, 'ratio-note'));
    ok(doc.querySelectorAll('#fixes .fix').length === 0, 'no fixes offered when already passing');
    /*
      And the whole block goes away. A header reading "Fixes · click to apply"
      over an empty row is visual noise pretending to be an offer — the verdict
      above it already says the artwork is fine.
    */
    ok(doc.getElementById('fix-block').hidden === true,
        'and the Fixes block hides rather than sitting there empty');

    section('transparency: 50% black on 80% teal');
    ({ win, doc, host, errors } = boot());
    host.setScenario('transparent');
    await wait(700);
    // teal at 80% over white = #3EA39B; black at 50% over that = #1F524E
    ok(txt(doc, 'hex-bg') === '#3EA39B', 'background composited', txt(doc, 'hex-bg'));
    ok(txt(doc, 'hex-fg') === '#1F514D' || txt(doc, 'hex-fg') === '#1F524E', 'foreground composited over it', txt(doc, 'hex-fg'));
    const composited = txt(doc, 'ratio');
    doc.getElementById('opt-rendered').checked = false;
    doc.getElementById('opt-rendered').dispatchEvent(new win.Event('change', { bubbles: true }));
    await wait(30);
    ok(txt(doc, 'hex-bg') === '#0E8C82', 'raw mode shows authored fill', txt(doc, 'hex-bg'));
    ok(txt(doc, 'ratio') !== composited, 'toggling rendered mode changes the ratio',
        composited + ' vs ' + txt(doc, 'ratio'));

    section('a gradient is graded on its WORST stop, not averaged');
    /*
      The tool used to refuse a gradient outright, which left "text on the hero
      gradient" permanently unmeasurable — the most common real case, and the one
      people most need checked.

      It is now graded, but on the worst stop. Averaging is the trap: white
      text on a white-to-near-black ramp averages to mid-grey and would "pass",
      while at the light end the text is invisible. WCAG asks the ratio to hold
      everywhere the text sits.
    */
    ({ win, doc, host, errors } = boot());
    host.setScenario('gradient');
    await wait(900);

    ok(txt(doc, 'ratio') === '1.00',
        'white on a white-to-black ramp reads 1.00 — its worst point', txt(doc, 'ratio'));
    ok(txt(doc, 'ratio') !== '21.00', 'specifically not the fabricated 21.00');
    ok(txt(doc, 'ratio') !== '5.75',
        'and not an average, which would have been a comfortable pass',
        txt(doc, 'ratio'));
    ok(doc.getElementById('ratio').className.includes('fail'), 'graded as the failure it is');
    ok(txt(doc, 'm-normal-aa') === '✕', 'the matrix agrees', txt(doc, 'm-normal-aa'));
    ok(/across the gradient/.test(txt(doc, 'ratio-note')),
        'the note says the number is a range', txt(doc, 'ratio-note'));
    ok(/1\.00 to 19\.02|1\.00 to 19\.0/.test(txt(doc, 'ratio-note')),
        'naming both ends, so "it passes over there" is visible', txt(doc, 'ratio-note'));
    /*
      And the swatch shows the ramp. Painting the first stop and printing its hex
      read as a solid colour that is not there, and hid the very thing the
      verdict is about.
    */
    ok(txt(doc, 'hex-bg') === 'gradient',
        'the background swatch says gradient rather than a stop hex', txt(doc, 'hex-bg'));
    ok(/linear-gradient/.test(doc.getElementById('swatch-bg').style.background),
        'and paints the ramp',
        doc.getElementById('swatch-bg').style.background);

    section('a gradient at partial opacity is not treated as opaque');
    /*
      A gradient scrim over a photo is the canonical case, and it read as a
      confident pass. The panel assigned each stop's alpha to
      alphaOverBackground, which REPLACED the object's own opacity rather than
      multiplying with it — so a black gradient card at 50% over white paper
      measured as solid black: 21.00 and green, where the same artwork described
      as a solid correctly read 3.95 and failed.
    */
    ({ win, doc, host, errors } = boot());
    // A black scrim at 50% over white paper: both stops black, so the ramp is a
    // flat tint and the correct answer is unambiguous.
    host.setGradientStops([{ rgb: [0, 0, 0], alpha: 1 }, { rgb: [0, 0, 0], alpha: 1 }]);
    host.setGradientOpacity(0.5);
    host.setScenario('gradient');
    await wait(1000);
    const halfRatio = txt(doc, 'ratio');
    ok(halfRatio !== '21.00',
        'a 50% black scrim is NOT read as opaque black', halfRatio);
    ok(halfRatio === '3.94' || halfRatio === '3.95',
        'white on it renders #808080 — 3.94, a failure', halfRatio);
    ok(doc.getElementById('ratio').className.includes('fail'), 'and it is graded as one');

    // The decisive comparison: identical artwork described as a solid.
    ({ win, doc, host, errors } = boot());
    host.recolour('background', [0, 0, 0]);
    await wait(1000);
    host.setScenario('teal');
    await wait(400);

    ({ win, doc, host, errors } = boot());
    host.setGradientStops([{ rgb: [255, 255, 255], alpha: 1 }, { rgb: [16, 16, 16], alpha: 1 }]);
    host.setGradientOpacity(1);
    host.setScenario('gradient');
    await wait(1000);

    section('and a fix must clear EVERY stop, not just the worst one');
    /*
      A colour that clears the dark end and fails the light one has solved
      nothing. Every suggestion is judged against the whole ramp.
    */
    const gradRungs = [...doc.querySelectorAll('#fixes .fix')];
    const gradLive = gradRungs.filter(b => !b.disabled);
    const gradBlocked = gradRungs.filter(b => b.className.indexOf('blocked') >= 0);

    /*
      On a white-to-near-black ramp NO single text colour clears any rung.

      1.10.0 offered a mid-grey here as the 3:1 fix: 3.03 against white, 6.27
      against the dark end. But a mid-grey's luminance lies between the two
      ends, so the ramp passes through it and the "fix" vanishes partway along.
      This test used to assert that one rung survived, which is to say it
      asserted the false pass. Graded along the path, every rung is genuinely
      impossible, and the panel says so instead of offering a shade that only
      fixes the two ends.
    */
    ok(gradLive.length === 0, 'no rung survives the whole ramp', String(gradLive.length));
    ok(/No single text colour clears/.test(txt(doc, 'fix-note')),
        'and the panel says no single text colour clears the whole gradient',
        txt(doc, 'fix-note'));
    /*
      Not "try the background instead". That was the generic advice, and a
      gradient is the one background the panel cannot write. Until gradients were
      graded along their length this message was unreachable here, which is how
      it went unnoticed.
    */
    ok(!/changing the background/.test(txt(doc, 'fix-note')),
        'and does not send the user to a gradient fill it cannot write', txt(doc, 'fix-note'));

    section('text that matches a colour inside the gradient fails there');
    /*
      #767676 on a white to black ramp. Against the two stops it is 4.54 and
      4.62, an AA pass at either end. A little past halfway the ramp IS #767676,
      and the text is not there at all. The engine pins the maths in
      run-color.js; this pins that the main view actually grades the path.
    */
    ({ win, doc, host, errors } = boot());
    host.setScenario('gradientCrossing');
    await wait(1000);
    ok(txt(doc, 'ratio') === '1.00', 'it reads 1.00, its worst point, not the 4.54 at a stop',
        txt(doc, 'ratio'));
    ok(txt(doc, 'm-normal-aa') === '✕', 'and fails AA', txt(doc, 'm-normal-aa'));
    ok(/1\.00 to 4\.6\d across the gradient/.test(txt(doc, 'ratio-note')),
        'the range names the crossing as its low end', txt(doc, 'ratio-note'));
    ok(doc.getElementById('swatch-bg').title.split('→').length === 2,
        'the swatch is still painted and titled from the two stops, not the samples',
        doc.getElementById('swatch-bg').title);

    section('a gradient that is darker in the middle is graded there');
    /*
      No crossing at all. Black text on a red to green ramp is 5.25 against both
      stops, an AA pass, and 3.94 where the ramp is darkest, because the mix runs
      in gamma-encoded RGB. Only sampling the segment finds it; the crossing rule
      alone cannot, which is why this case has its own test.
    */
    ({ win, doc, host, errors } = boot());
    host.setScenario('gradientMuddy');
    await wait(1000);
    ok(txt(doc, 'ratio') === '3.94', 'it reads 3.94 in the darker middle, not 5.25 at the stops',
        txt(doc, 'ratio'));
    ok(txt(doc, 'm-normal-aa') === '✕', 'and fails AA', txt(doc, 'm-normal-aa'));

    section('a gradient whose stops cannot be read still refuses');
    /*
      An older host, or stop colours that failed to resolve. Without stops there
      is nothing to grade, and inventing white paper is the original sin.
    */
    ({ win, doc, host, errors } = boot());
    host.stripGradientStops();
    host.setScenario('gradient');
    await wait(900);
    ok(txt(doc, 'ratio') === '·', 'no ratio is shown', txt(doc, 'ratio'));
    ok(txt(doc, 'ratio-note') === 'Not measured', 'says it was not measured', txt(doc, 'ratio-note'));
    ok(txt(doc, 'm-normal-aa') === '·', 'matrix is blank, not ticked', txt(doc, 'm-normal-aa'));
    ok(txt(doc, 'hex-bg') === '·', 'background swatch blank, not a fake white', txt(doc, 'hex-bg'));
    ok(/gradient/i.test(doc.getElementById('notice').textContent),
        'the notice names the gradient', doc.getElementById('notice').textContent);
    ok(/eyedropper|sample/i.test(doc.getElementById('notice').textContent),
        'and says what to do about it');

    section('a placed image is an opaque stop, not a hole to see through');
    /*
      A raster has no fillColor, so reading one threw and the host reported "no
      fill" — indistinguishable from a transparent object. The backdrop search
      then stepped straight THROUGH the photo onto the white card underneath it,
      and white text over the photo was measured against the card: 12.63:1, a
      confident AAA pass, for artwork that renders at about 1.42.
    */
    ({ win, doc, host, errors } = boot());
    host.setScenario('photo');
    await wait(900);
    ok(txt(doc, 'ratio') === '·', 'no ratio over a placed image', txt(doc, 'ratio'));
    ok(txt(doc, 'hex-bg') === '·', 'and no invented white background', txt(doc, 'hex-bg'));
    ok(/placed image/i.test(doc.getElementById('notice').textContent),
        'the notice names it as an image, not "something the panel can\'t read"',
        doc.getElementById('notice').textContent);
    ok(/eyedropper|sample/i.test(doc.getElementById('notice').textContent),
        'and points at the eyedropper');

    ({ win, doc, host, errors } = boot());
    host.setScenario('gradient');
    await wait(900);

    section('sampling a gradient with the loupe restores a real verdict');
    click(doc, 'btn-pick-bg');
    await wait(300);
    ok(doc.getElementById('snapshot-frame').className.includes('tracking'),
        'arming a slot starts the loupe tracking');
    press(doc, 'Enter');
    await wait(60);
    ok(txt(doc, 'hex-bg') !== '·', 'a colour was locked in', txt(doc, 'hex-bg'));
    ok(txt(doc, 'ratio') !== '·', 'a ratio appears once measurable', txt(doc, 'ratio'));
    ok(txt(doc, 'm-normal-aa') !== '·', 'matrix populates too', txt(doc, 'm-normal-aa'));
    ok(overridden(doc), 'Auto dims once a colour is picked by hand',
        doc.getElementById('mode-chip').className);
    ok(dotSet(doc, 'bg'), 'and the Bg button carries the colour it now holds');
    ok(!dotSet(doc, 'fg'), 'while the untouched side shows nothing');

    section('the loupe reads the screen around the pointer');
    ({ win, doc, host, errors } = boot());
    await wait(150);
    ok(!!doc.getElementById('btn-camera'), 'eyedropper button exists');
    click(doc, 'btn-camera');
    await wait(300);

    const calls = host.processCalls();
    const exes = calls.map(c => String(c[0]));
    ok(calls.length > 0, 'native processes were started', String(calls.length));

    /*
      Two processes, with different jobs. The pointer server starts once and
      keeps answering "where is the mouse"; the grab script then costs a
      screenshot and nothing else. Asking osascript that question once per frame
      was most of a measured 381ms.
    */
    ok(exes.some(e => /osascript$/.test(e)),
        'the pointer server is started once, through osascript', exes.join(', '));
    ok(exes.some(e => /\/bin\/sh$/.test(e)),
        'and frames are grabbed through sh', exes.join(', '));

    const serverCall = calls.find(c => /osascript$/.test(String(c[0])));
    const grabCall = calls.find(c => /\/bin\/sh$/.test(String(c[0])));

    const scripts = host.written();
    const names = Object.keys(scripts);
    const serverPath = names.find(k => /umbra-pointer\.js$/.test(k));
    const grabPath = names.find(k => /umbra-grab\.sh$/.test(k));
    const soloPath = names.find(k => /umbra-loupe\.sh$/.test(k));

    ok(!!serverPath && !!grabPath && !!soloPath,
        'all three helpers are written to the temp folder', names.join(', '));

    const server = scripts[serverPath] || '';
    ok(/NSEvent\.mouseLocation/.test(server), 'the server asks the OS where the pointer is');
    ok(/sleepForTimeInterval\(0\.03\)/.test(server), 'and keeps answering, about 30 times a second');
    ok(/fileExistsAtPath\(stop\)/.test(server), 'it watches for a stop file');
    ok(/Date\.now\(\) < deadline/.test(server), 'and gives up on its own deadline regardless');

    const grab = scripts[grabPath] || '';
    ok(!/osascript/.test(grab), 'the per-frame grab never launches osascript');
    ok(/screencapture/.test(grab), 'it grabs a region of the screen');
    ok(/-R"\$RX,\$RY,\$SIZE,\$SIZE"/.test(grab), 'a region, not the whole display');
    ok(/mv -f/.test(grab),
        'and moves each finished file into place, so a half-written PNG is never read');

    const solo = scripts[soloPath] || '';
    ok(/NSEvent\.mouseLocation/.test(solo) && /screencapture/.test(solo),
        'the self-contained fallback still does both jobs itself');

    ok(String(serverCall[3]) === serverPath, 'the server process runs the server script',
        calls.filter(c => /osascript$/.test(String(c[0]))).map(c => c.join(' ')).join(' | '));
    ok(String(grabCall[1]) === grabPath, 'and the frame process runs the fast grab script',
        String(grabCall[1]));
    ok(grabCall.some(a => String(a).indexOf('umbra-pointer.txt') >= 0),
        'which is handed the pointer file instead of asking for itself', grabCall.join(' '));

    section('it keeps tracking rather than grabbing once');
    const liveProbe = await probe(win);
    ok(liveProbe.frames > 1, 'more than one frame has been captured', String(liveProbe.frames));
    ok(liveProbe.mode === 'loupe' && liveProbe.live,
        'and it reports itself as tracking', liveProbe.mode + (liveProbe.live ? ' (tracking)' : ''));
    ok(!/base64 read failed/.test(liveProbe.captureDetail), 'no base64 read failure was recorded',
        liveProbe.captureDetail);
    ok(liveProbe.tainted === false, 'it used a data URL, so the canvas stays samplable');

    section('the crosshair tracks between captures, not just on them');
    /*
      The capture covers far more than the pane shows, so ordinary small
      movements are served by panning inside the frame already held — no
      process, no screenshot, no wait. This is the difference between a loupe
      that feels live and one that lurches once a frame.
    */
    ({ win, doc, host, errors } = boot('xy'));
    await wait(150);
    click(doc, 'btn-camera');
    await wait(400);
    const beforeMove = txt(doc, 'pick-hint');
    /*
      Move the pointer, staying well inside the captured region. The jsdom
      fixture is only 4x4 for a 128-point region, so the step has to be a whole
      fixture pixel — run-render.js checks fine-grained tracking against a real
      96x96 capture.
    */
    host.setPointerLine('132 132 0 0 1920 1080');
    await wait(120);
    const afterMove = txt(doc, 'pick-hint');
    ok(afterMove !== beforeMove,
        'the readout follows the pointer', beforeMove + ' -> ' + afterMove);
    ok(/^#[0-9A-F]{6} · /.test(afterMove), 'and shows the new pixel\'s hex', afterMove);
    press(doc, 'Escape');

    section('the loupe shows the ratio live, before anything is committed');
    /*
      Hovering tells you where the text would pass, instead of forcing you to
      lock a colour, read the verdict, undo and try again. The counterpart has
      to be a colour we actually know — never the black-on-white default, which
      would make the number fiction.
    */
    ({ win, doc, host, errors } = boot('xy'));
    await wait(150);
    click(doc, 'btn-pick-fg');           // measuring a text colour against the teal
    await wait(400);
    const readout = txt(doc, 'pick-hint');
    ok(/^#[0-9A-F]{6} · \d+\.\d\d:1 · /.test(readout),
        'hex and live ratio, before Enter is pressed', readout);
    const liveSpan = doc.querySelector('#pick-hint .live-ratio');
    ok(!!liveSpan, 'the ratio is marked up so it can be coloured');
    ok(/live-(pass|fail)/.test(liveSpan.className),
        'and says pass or fail against the current target', liveSpan.className);
    press(doc, 'Escape');

    section('no counterpart, no invented ratio');
    ({ win, doc, host, errors } = boot('xy'));
    host.setScenario('gradient');         // background is unreadable
    await wait(700);
    click(doc, 'btn-pick-fg');            // so a text pick has nothing to measure against
    await wait(400);
    const noPair = txt(doc, 'pick-hint');
    ok(/^#[0-9A-F]{6} · click or ⏎/.test(noPair),
        'the hex is shown but no ratio is fabricated', noPair);
    ok(!doc.querySelector('#pick-hint .live-ratio'),
        'and nothing is marked up as a verdict');
    press(doc, 'Escape');

    section('a pointer that outruns the frame does not get a guessed colour');
    /*
      Panning is exact only while the pointer is inside the frame. Once it is
      outside, locking the nearest edge pixel would hand back a colour the user
      never pointed at, so the lock waits for a frame that actually contains it.
    */
    ({ win, doc, host, errors } = boot('xy'));
    await wait(150);
    click(doc, 'btn-camera');
    await wait(400);
    host.setPointerLine('9000 9000 0 0 20000 20000');   // far outside the held frame
    await wait(120);
    press(doc, 'Enter');
    await wait(80);
    ok(/Catching up/.test(txt(doc, 'pick-hint')),
        'it says it is waiting rather than locking something wrong', txt(doc, 'pick-hint'));
    ok(txt(doc, 'mode-chip') === 'Auto', 'and nothing was sampled', txt(doc, 'mode-chip'));

    ok(/Catching up/.test(txt(doc, 'pick-hint')),
        'and the pending state survives the next redraw, so Enter looks heard',
        txt(doc, 'pick-hint'));

    // Once a frame arrives that contains that point, the pending lock completes.
    host.setLoupePosition('9000 9000 8936 8936 128');
    await wait(600);
    ok(overridden(doc), 'the lock completes by itself once the frame catches up',
        doc.getElementById('mode-chip').className);

    section('a deferred lock takes the pixel Enter was pressed over');
    /*
      Recording only the INTENT to lock meant the sample fired wherever the
      pointer had wandered to by the time a frame arrived — on a photo, an
      entirely different colour, with nothing to show anything had gone wrong.
    */
    ({ win, doc, host, errors } = boot('xy'));
    await wait(150);
    click(doc, 'btn-camera');
    await wait(400);

    // Pointer leaves the held frame, then Enter, then it wanders somewhere else.
    host.setPointerLine('9000 9000 0 0 20000 20000 5');
    await wait(120);
    press(doc, 'Enter');
    await wait(60);
    host.setPointerLine('9032 9032 0 0 20000 20000 6');
    await wait(120);
    ok(isAuto(doc), 'wandering off does not satisfy the pending lock',
        doc.getElementById('mode-chip').className);

    /*
      Now a frame that contains BOTH points, at different pixels: (9000,9000) is
      64 points into the region and lands on pixel 2; (9032,9032) is 96 points in
      and lands on pixel 3. Locking the wrong one is therefore visible, which the
      earlier version of this test could not tell apart.
    */
    host.setLoupePosition('9032 9032 8936 8936 128');
    await wait(700);
    ok(overridden(doc), 'a frame that contains it completes the lock',
        doc.getElementById('mode-chip').className);
    ok(txt(doc, 'hex-bg') === '#1E281E',
        'and takes pixel 2 — where Enter was pressed — not pixel 3, where the ' +
        'pointer had wandered to', txt(doc, 'hex-bg'));

    section('a pixel that never comes back gives up rather than hanging');
    ({ win, doc, host, errors } = boot('xy'));
    await wait(150);
    click(doc, 'btn-camera');
    await wait(400);
    host.setPointerLine('9000 9000 0 0 20000 20000 5');
    await wait(120);
    press(doc, 'Enter');
    await wait(2100);
    ok(/Press Enter again/.test(txt(doc, 'pick-hint')),
        'it says so on its own timer, not whenever a frame happens to land',
        txt(doc, 'pick-hint'));
    ok(isAuto(doc), 'and still nothing was sampled', doc.getElementById('mode-chip').className);
    press(doc, 'Escape');

    section('arming drops the previous frame before the new one lands');
    /*
      The old image and its offscreen copy used to survive arming, so for the
      second before a capture arrived the readout described the PREVIOUS frame —
      and Enter committed a pixel from it, labelled "Screen".
    */
    ({ win, doc, host, errors } = boot('xy'));
    await wait(150);
    click(doc, 'btn-camera');
    await wait(400);
    press(doc, 'Enter');
    await wait(80);
    ok(overridden(doc), 'first pick lands', doc.getElementById('mode-chip').className);

    press(doc, 'Escape');
    click(doc, 'mode-chip');               // back to the artwork's own colours
    await wait(60);
    ok(isAuto(doc), 'samples cleared', doc.getElementById('mode-chip').className);

    host.setPointerServerBroken(true);     // keeps the next frame from arriving quickly
    click(doc, 'btn-camera');
    await wait(60);
    press(doc, 'Enter');                   // before any new frame exists
    await wait(80);
    ok(isAuto(doc), 'Enter before the first frame commits nothing from the old one',
        doc.getElementById('mode-chip').className);
    ok(txt(doc, 'pick-hint') === '' || /Catching up|Enter to lock/.test(txt(doc, 'pick-hint')),
        'and the readout does not describe a frame that is gone',
        txt(doc, 'pick-hint'));
    press(doc, 'Escape');

    section('a pointer server that dies mid-session is noticed');
    /*
      A dead server leaves its last position on disk, which looks exactly like a
      stationary pointer. Without a heartbeat the loupe would sit on a stale
      frame showing a plausible hex and a plausible ratio for where the pointer
      used to be.
    */
    ({ win, doc, host, errors } = boot());
    await wait(150);
    click(doc, 'btn-camera');
    await wait(400);
    const alive = await probe(win);
    ok(alive.pointerServer === 'fast', 'the fast path is live to begin with', alive.pointerServer);

    // Freeze the heartbeat: the file still parses, it just stops advancing.
    host.setPointerLine('100 100 0 0 1920 1080 99');
    await wait(2000);
    const demoted = await probe(win);
    ok(demoted.pointerServer === 'slow',
        'a frozen heartbeat demotes it to the self-contained script', demoted.pointerServer);
    ok(doc.getElementById('capture-note').hidden === true,
        'quietly — it is slower, not broken', txt(doc, 'capture-note'));
    press(doc, 'Escape');

    section('a pointer server that never answers falls back, it does not break');
    ({ win, doc, host, errors } = boot());
    await wait(150);
    host.setPointerServerBroken(true);
    click(doc, 'btn-camera');
    await wait(1500);
    ok(doc.getElementById('snapshot-frame').className.includes('tracking'),
        'the loupe is still running');
    ok(doc.getElementById('capture-note').hidden === true,
        'with no error shown to the user', txt(doc, 'capture-note'));
    const fallbackProbe = await probe(win);
    ok(fallbackProbe.pointerServer === 'slow',
        'and it took the slow route', fallbackProbe.pointerServer);
    ok(fallbackProbe.frames >= 1, 'frames are still arriving on the fallback path',
        String(fallbackProbe.frames));
    press(doc, 'Escape');

    section('a click anywhere locks the colour');
    /*
      The pick gesture people expect. The panel cannot see clicks outside its
      own window except through the pointer server, and cannot stop one reaching
      Illustrator at all — so it detects the press here and has the host put the
      selection back, which makes the click a no-op in the document.
    */
    ({ win, doc, host, errors } = boot('xy'));
    await wait(150);
    click(doc, 'btn-camera');
    await wait(400);
    ok(isAuto(doc), 'nothing picked yet', doc.getElementById('mode-chip').className);

    const releasesBefore = host.selectionReleases();
    host.setPointerLine('100 100 0 0 1920 1080 50 1');   // button down
    await wait(200);

    ok(overridden(doc), 'the click locked a colour', doc.getElementById('mode-chip').className);
    ok(txt(doc, 'hex-bg') === '#1E281E', 'the pixel under the pointer', txt(doc, 'hex-bg'));
    ok(!doc.getElementById('snapshot-frame').className.includes('tracking'),
        'and the loupe stopped tracking');
    ok(host.selectionReleases() > releasesBefore,
        'the host was asked to put the selection back',
        releasesBefore + ' -> ' + host.selectionReleases());
    /*
      Exactly once. The release used to happen in two places — stopLoupe and
      pickAtClick — which raced on the same flag: whichever ran first cleared it,
      and the other one's callback, the one that asks the panel to re-read the
      restored selection, never ran at all.
    */
    ok(host.selectionReleases() === releasesBefore + 1,
        'exactly once, not twice and not zero times',
        releasesBefore + ' -> ' + host.selectionReleases());
    await wait(900);
    ok(host.calls('wcagSelection') > 0,
        'and the panel re-reads the selection the restore put back',
        String(host.calls('wcagSelection')));

    section('holding the button down does not pick again');
    const afterFirst = txt(doc, 'hex-bg');
    host.setPointerLine('132 132 0 0 1920 1080 51 1');   // still down, moved
    await wait(200);
    ok(txt(doc, 'hex-bg') === afterFirst,
        'only the press picks, not the hold', txt(doc, 'hex-bg'));

    section('but a click on the panel\'s own chrome does not');
    /*
      The screen detector sees a mouse press; it cannot see WHERE. Clicking the
      gear, or Auto, or the Bg button while the loupe was armed ran that control
      AND locked whatever pixel happened to sit under it — so opening the options
      popover mid-pick quietly overwrote the colour the user was choosing.
    */
    ({ win, doc, host, errors } = boot('xy'));
    await wait(150);
    click(doc, 'btn-camera');
    await wait(400);
    ok(isAuto(doc), 'armed, nothing picked yet');

    // The pointer moving over the panel is what the real chrome reports.
    doc.getElementById('btn-options').dispatchEvent(
        new win.MouseEvent('mouseover', { bubbles: true }));
    host.setPointerLine('100 100 0 0 1920 1080 60 1');   // button down, over the panel
    await wait(200);

    ok(isAuto(doc), 'no colour was locked by a click on the panel itself',
        doc.getElementById('mode-chip').className);
    ok(txt(doc, 'hex-bg') === '·' || txt(doc, 'hex-bg') === '#0E8C82',
        'the background reading is untouched', txt(doc, 'hex-bg'));

    // Pointer leaves the panel; the very next press is a real pick again.
    doc.dispatchEvent(new win.MouseEvent('mouseout', { bubbles: true }));
    host.setPointerLine('100 100 0 0 1920 1080 61 0');   // released
    await wait(120);
    host.setPointerLine('100 100 0 0 1920 1080 62 1');   // pressed, off-panel
    await wait(200);
    ok(overridden(doc), 'and a press outside the panel still picks',
        doc.getElementById('mode-chip').className);

    section('a tap too quick for the button state still picks');
    /*
      A trackpad tap is down and up again between two samples of the button
      state, so the click reached Illustrator and the loupe never saw it. The
      macOS helper also reports a running count of presses; a count that moved
      is a click, whatever the buttons say now. Positions may carry half points.
    */
    ({ win, doc, host, errors } = boot('xy'));
    await wait(150);
    click(doc, 'btn-camera');
    await wait(400);
    host.setPointerLine('100.5 100.5 0 0 1920 1080 70 0 5');   // baseline count
    await wait(200);
    ok(isAuto(doc), 'a steady count picks nothing', doc.getElementById('mode-chip').className);
    host.setPointerLine('100.5 100.5 0 0 1920 1080 71 0 6');   // a press came and went
    await wait(200);
    ok(overridden(doc), 'a press counted between samples locks the colour',
        doc.getElementById('mode-chip').className);

    section('grouped artwork explains itself');
    /*
      Black text inside a group at 50% renders as mid-grey. Measuring the grey is
      correct; reporting only the number against artwork the designer knows is
      black reads as a broken tool. Grouping is how people organise work and
      should not cost them an explanation.
    */
    ({ win, doc, host, errors } = boot());
    host.setAppearance('foreground', [
        { kind: 'group', name: 'Header', opacity: 50, blend: 'normal', own: false }
    ]);
    host.setScenario('teal');
    await wait(900);

    const note = doc.getElementById('appearance-note');
    ok(!note.hidden, 'the note is shown');
    ok(/Text is #FFFFFF/.test(note.textContent), 'it names the authored colour', note.textContent);
    ok(/renders #/.test(note.textContent), 'and the colour it actually becomes', note.textContent);
    ok(/group “Header” at 50% opacity/.test(note.textContent),
        'naming the container and why', note.textContent);
    ok(!!note.querySelector('.link-btn'), 'with a way to measure the authored colours instead');

    section('and that switch works');
    note.querySelector('.link-btn').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await wait(80);
    ok(doc.getElementById('opt-rendered').checked === false, 'rendered measurement is off');
    ok(txt(doc, 'hex-fg') === '#FFFFFF', 'and the authored colour is measured',
        txt(doc, 'hex-fg'));
    ok(doc.getElementById('appearance-note').hidden,
        'the note steps aside once you have taken its advice');

    section('no note when nothing is changing the colour');
    ({ win, doc, host, errors } = boot());
    await wait(900);
    ok(doc.getElementById('appearance-note').hidden,
        'ungrouped artwork says nothing', txt(doc, 'appearance-note'));

    section('a rung out of reach is shown, not hidden');
    /*
      Hiding an unreachable rung made the ladder look as though the tool had
      nothing further to offer, when the real answer is "not by moving this
      colour — move the other one". Near-black text on black: 7:1 cannot be
      reached by any shade of the text, and saying so is the useful answer.
    */
    ({ win, doc, host, errors } = boot());
    /*
      Pink on purple: brightness alone cannot clear AA at that hue, so the
      swatch row is showing — and 7:1 is beyond anything a shade of that pink can
      do against that purple, so it is the rung that has to say so.
    */
    host.recolour('foreground', [0xB1, 0x54, 0x8B]);
    host.recolour('background', [0x76, 0x31, 0x8F]);
    await wait(1200);

    const rungs = doc.querySelectorAll('#fixes .fix');
    ok(rungs.length === 3, 'all three rungs are present whatever the artwork', String(rungs.length));
    const blocked = [...rungs].filter(r => r.className.indexOf('blocked') >= 0);
    ok(blocked.length > 0, 'the unreachable ones are marked, not dropped',
        [...rungs].map(r => r.className).join(' | '));
    ok(blocked.every(r => r.disabled), 'and are not clickable');
    ok(blocked[0].querySelector('.rung-ratio').textContent === '·',
        'showing a dash rather than a number they cannot deliver',
        blocked[0].querySelector('.rung-ratio').textContent);

    blocked[0].dispatchEvent(new win.MouseEvent('mouseenter', { bubbles: true }));
    await wait(40);
    ok(/Change the/.test(txt(doc, 'fix-note')),
        'and the note says what to do instead', txt(doc, 'fix-note'));

    section('fix swatches say what each rung buys');
    // Pink on purple again: the pair where the swatches are the route.
    ({ win, doc, host, errors } = boot());
    host.recolour('foreground', [0xB1, 0x54, 0x8B]);
    host.recolour('background', [0x76, 0x31, 0x8F]);
    await wait(1200);
    const swatches = doc.querySelectorAll('#fixes .fix');
    ok(swatches.length === 3, 'three rungs', String(swatches.length));
    const labels = [];
    swatches.forEach(function (b) {
        const l = b.querySelector('.rung-label');
        if (l) labels.push(l.textContent);
    });
    ok(labels.join(',') === '3:1,4.5:1,7:1', 'each names its threshold', labels.join(' '));

    const live = [...swatches].filter(b => !b.disabled);
    const nums = live.map(b => b.querySelector('.rung-ratio').textContent);
    ok(nums.every(function (l) { return /^\d+\.\d\d$/.test(l); }),
        'and every actionable one carries the ratio it achieves', nums.join(' '));
    ok(/↑|↓/.test(txt(doc, 'fix-note')),
        'the note says how far it moves from where you are', txt(doc, 'fix-note'));
    ok(/body text|Large text|icons/i.test(txt(doc, 'fix-note')),
        'and who the rung is for', txt(doc, 'fix-note'));

    section('Esc cancels without picking anything');
    press(doc, 'Escape');
    await wait(60);
    ok(!doc.getElementById('snapshot-frame').className.includes('tracking'), 'tracking stops');
    ok(isAuto(doc), 'nothing was sampled', doc.getElementById('mode-chip').className);
    ok(txt(doc, 'pick-hint') === '', 'and the hint clears', txt(doc, 'pick-hint'));

    section('the crosshair follows the pointer, not the middle of the image');
    /*
      Coordinate-derived pixels: reading image pixel (x, y) yields a colour that
      encodes x and y. The fixture puts the pointer 24 points into a 48-point
      region, which on the 4x4 capture is pixel (2, 2) -> #1E281E.
    */
    ({ win, doc, host, errors } = boot('xy'));
    await wait(150);
    click(doc, 'btn-camera');
    await wait(300);
    press(doc, 'Enter');
    await wait(60);
    ok(txt(doc, 'hex-bg') === '#1E281E',
        'locked the pixel under the pointer, at image (2,2)', txt(doc, 'hex-bg'));

    section('a region clamped at the screen edge still marks the right pixel');
    // Pointer at the very top-left: the grab cannot centre on it, so the region
    // origin equals the pointer and the crosshair belongs at pixel (0, 0).
    ({ win, doc, host, errors } = boot('xy'));
    host.setLoupePosition('0 0 0 0 128');
    host.setPointerLine('0 0 0 0 1920 1080');
    await wait(150);
    click(doc, 'btn-camera');
    await wait(400);
    press(doc, 'Enter');
    await wait(120);
    ok(txt(doc, 'hex-bg') === '#0A141E',
        'locked image (0,0), not the middle of the frame', txt(doc, 'hex-bg'));

    section('samples come from the native image, never the scaled canvas');
    /*
      The display canvas is 220x92 and the loupe magnifies about nine times.
      Sampling the visible canvas would encode a coordinate in the hundreds; the
      4x4 source can only produce x and y in 0..3. It would also be interpolated,
      which is what made sampling anti-aliased text wrong.
    */
    ({ win, doc, host, errors } = boot('xy'));
    await wait(150);
    click(doc, 'btn-camera');
    await wait(300);
    press(doc, 'Enter');
    await wait(60);
    const locked = txt(doc, 'hex-bg');
    const lr = parseInt(locked.slice(1, 3), 16), lg = parseInt(locked.slice(3, 5), 16);
    ok(lr <= 10 + 3 * 10 && lg <= 20 + 3 * 10,
        'the sampled coordinates lie inside the 4x4 source image', locked);

    section('clicking inside the held frame refines the pick');
    ok(/Click a pixel/.test(txt(doc, 'pick-hint')),
        'the frozen frame invites a refining click', txt(doc, 'pick-hint'));
    /*
      Straight into the held frame — no button press first. The refining click
      goes back to the slot it filled, which is the background here.

      Derived rather than hard-coded, so changing the loupe's magnification does
      not silently turn this into an assertion about a different pixel.
    */
    const canvasW = doc.getElementById('snapshot').width;
    const magnify = Math.max(2, Math.round(canvasW / 40));
    const originX = Math.round(canvasW / 2 - 2.5 * magnify);
    const originY = Math.round(92 / 2 - 2.5 * magnify);
    clickCanvas(win, doc, originX + 1, originY + magnify + 1);
    await wait(60);
    ok(txt(doc, 'hex-bg') === '#0A1E1E',
        'the click set the background colour from image pixel (0,1)', txt(doc, 'hex-bg'));

    section('Text and Bg are eyedroppers, in one press');
    /*
      They always started the loupe — except while a frozen frame was held, where
      they set the slot and returned. The button appeared to do nothing, so people
      pressed the eyedropper next and learned a two-step gesture the tool never
      required. A held frame is stale the moment a fresh pick is asked for.
    */
    ok(doc.getElementById('snapshot-frame').className.indexOf('tracking') < 0,
        'a frame is held, and not tracking', doc.getElementById('snapshot-frame').className);

    click(doc, 'btn-pick-fg');
    await wait(300);
    ok(doc.getElementById('snapshot-frame').className.indexOf('tracking') >= 0,
        'pressing Text arms the loupe immediately, even over a held frame',
        doc.getElementById('snapshot-frame').className);
    ok(/lock text/.test(txt(doc, 'pick-hint')),
        'and it is sampling into the text slot', txt(doc, 'pick-hint'));

    press(doc, 'Escape');
    await wait(80);
    click(doc, 'btn-pick-bg');
    await wait(300);
    ok(doc.getElementById('snapshot-frame').className.indexOf('tracking') >= 0,
        'Bg does the same', doc.getElementById('snapshot-frame').className);
    ok(/lock bg/.test(txt(doc, 'pick-hint')),
        'into the background slot', txt(doc, 'pick-hint'));
    press(doc, 'Escape');
    await wait(60);

    // The affordance itself: an eyedropper glyph inside each button.
    ok(!!doc.querySelector('#btn-pick-fg .pick-tip') && !!doc.querySelector('#btn-pick-bg .pick-tip'),
        'both buttons carry an eyedropper glyph, so the gesture is visible');
    const beforeStray = txt(doc, 'hex-fg');
    clickCanvas(win, doc, 210, 88);
    await wait(60);
    ok(txt(doc, 'hex-fg') === beforeStray,
        'a click outside the captured image changes nothing', txt(doc, 'hex-fg'));

    section('the chip explains the colour-space caveat');
    const chipTitle = doc.getElementById('mode-chip').getAttribute('title') || '';
    ok(/wide-gamut/i.test(chipTitle), 'explains the display-space caveat', chipTitle);
    ok(/sRGB/i.test(chipTitle), 'naming what it differs from', chipTitle);
    ok(/Click to go back/i.test(chipTitle), 'and says how to undo the override', chipTitle);

    section('a selection poll must not cancel a pick in progress');
    ({ win, doc, host, errors } = boot());
    await wait(150);
    click(doc, 'btn-camera');
    await wait(120);
    host.setScenario('blueHeading');       // forces a signature change mid-pick
    await wait(900);
    ok(doc.getElementById('snapshot-frame').className.includes('tracking'),
        'the loupe is still tracking after the selection changed underneath it');
    ok(doc.getElementById('btn-pick-bg').className.includes('on'),
        'and the armed slot survives too');
    press(doc, 'Escape');

    section('a hand-picked colour survives a change of selection');
    /*
      It has to: the click that picks a colour also lands in Illustrator, and
      often IS the change of selection. Dropping it would make click-to-pick
      impossible. What keeps that honest is that it cannot be missed — Auto
      dims, the button carries the colour, and the panel says out loud that the
      number is not this artwork's own.
    */
    ({ win, doc, host, errors } = boot('xy'));
    await wait(150);
    click(doc, 'btn-camera');
    await wait(400);
    press(doc, 'Enter');
    await wait(80);
    ok(overridden(doc), 'a colour is picked', doc.getElementById('mode-chip').className);
    const pickedHex = txt(doc, 'hex-bg');

    host.setScenario('blueHeading');
    await wait(900);
    ok(txt(doc, 'hex-bg') === pickedHex, 'it is still in use after the selection changed',
        txt(doc, 'hex-bg'));
    ok(overridden(doc), 'and Auto is still dimmed', doc.getElementById('mode-chip').className);
    ok(!doc.getElementById('notice').hidden, 'a notice appears');
    ok(/picked by hand/i.test(doc.getElementById('notice').textContent),
        'saying the number is not this artwork\'s own',
        doc.getElementById('notice').textContent);
    ok(/Click Auto/i.test(doc.getElementById('notice').textContent),
        'and how to release it', doc.getElementById('notice').textContent);

    section('deselecting does not hide the warning, or invent the other colour');
    /*
      Two bugs on the same path, both of which end in a confident number for a
      measurement that was never made:

        - renderNotices() returned early when there was no selection, so
          deselecting removed the "this colour is not from this artwork" warning
          at exactly the moment it became most true.
        - renderAll() only refused when NOTHING was picked. With one colour
          picked and nothing selected it went on to call backgroundColour(),
          whose fallback is white paper — so a sampled #4B4B4B was graded 8.6:1
          against a background that exists nowhere but in that default.
    */
    host.setScenario('none');
    await wait(900);
    ok(txt(doc, 'ratio') === '·', 'no ratio for one colour and nothing to compare it to',
        txt(doc, 'ratio'));
    ok(txt(doc, 'ratio-note') === 'Not measured', 'and it says so', txt(doc, 'ratio-note'));
    ok(!doc.getElementById('notice').hidden, 'a warning is still on screen');
    ok(/One colour picked/i.test(doc.getElementById('notice').textContent),
        'naming exactly what is missing', doc.getElementById('notice').textContent);
    ok(/Sample the text/i.test(doc.getElementById('notice').textContent),
        'and which half to go and get', doc.getElementById('notice').textContent);
    ok(txt(doc, 'hex-bg') === pickedHex, 'the picked colour is still shown', txt(doc, 'hex-bg'));
    ok(txt(doc, 'hex-fg') === '·', 'and the missing half is shown as missing', txt(doc, 'hex-fg'));

    host.setScenario('blueHeading');
    await wait(900);

    section('and Auto hands both colours back to the artwork');
    click(doc, 'mode-chip');
    await wait(80);
    ok(isAuto(doc), 'Auto lights up again', doc.getElementById('mode-chip').className);
    ok(!dotSet(doc, 'bg'), 'the button stops carrying a colour');
    ok(txt(doc, 'ratio') === '8.04', 'and the ratio is the artwork\'s own again',
        txt(doc, 'ratio'));

    section('releasing Auto restores the refusal on unreadable artwork');
    /*
      A pinned colour legitimately makes a gradient measurable — that is the
      point of sampling one. But the refusal has to come straight back the
      moment the override is released, or the guard rail is gone for good.
    */
    ({ win, doc, host, errors } = boot('xy'));
    host.stripGradientStops();   // unreadable stops: the case that still refuses
    host.setScenario('gradient');
    await wait(900);
    ok(txt(doc, 'ratio') === '·', 'refuses to begin with', txt(doc, 'ratio'));

    click(doc, 'btn-camera');
    await wait(400);
    press(doc, 'Enter');
    await wait(120);
    ok(txt(doc, 'ratio') !== '·', 'sampling the gradient produces a real number',
        txt(doc, 'ratio'));

    click(doc, 'mode-chip');
    await wait(80);
    ok(txt(doc, 'ratio') === '·', 'and releasing it refuses again', txt(doc, 'ratio'));
    ok(!doc.getElementById('notice').hidden, 'with the gradient notice back');
    ok(/gradient/i.test(doc.getElementById('notice').textContent),
        'naming the reason', doc.getElementById('notice').textContent);

    section('Esc releases a picked colour, and says so');
    /*
      The hint read "Esc clears" and Esc did not clear: cancelPicking dropped the
      frozen frame and left pickFg/pickBg/pinned untouched. The only release was
      the Auto chip, which the hint never named — so the way out of a hand-picked
      reading was undiscoverable and the label was a lie.

      Esc escalates instead: the first closes the held frame, the second hands
      the colours back.
    */
    ({ win, doc, host, errors } = boot('xy'));
    await wait(150);
    click(doc, 'btn-camera');
    await wait(400);
    press(doc, 'Enter');
    await wait(120);
    ok(overridden(doc), 'a colour is picked');

    press(doc, 'Escape');
    await wait(100);
    ok(overridden(doc), 'the first Esc closes the held frame and keeps the colour',
        doc.getElementById('mode-chip').className);
    ok(/Esc or Auto releases/.test(txt(doc, 'pick-hint')),
        'and now the panel names the way out', txt(doc, 'pick-hint'));

    press(doc, 'Escape');
    await wait(100);
    ok(isAuto(doc), 'the second hands the colours back to the artwork',
        doc.getElementById('mode-chip').className);
    ok(!dotSet(doc, 'bg'), 'and the button stops carrying one');

    section('sampling a colour does not block fixing the artwork');
    /*
      The workflow this broke: select the text, eyedrop both colours to see the
      problem, then fix it — and nothing could be fixed at all, because both
      sides counted as "picked by hand". The object was selected the whole time.

      The hazard the old refusal was built for is real but different: a colour
      sampled off a photo, written to whichever shape the host detected
      underneath, silently recolours something unrelated. The answer to that is
      to NAME the object about to change, not to refuse every edit.
    */
    ({ win, doc, host, errors } = boot([200, 200, 200]));
    await wait(150);
    click(doc, 'btn-pick-bg');
    await wait(400);
    press(doc, 'Enter');
    await wait(200);
    ok(overridden(doc), 'a background colour is sampled');
    ok(txt(doc, 'ratio') !== '·' && parseFloat(txt(doc, 'ratio')) < 4.5,
        'and it fails, so fixes are in play', txt(doc, 'ratio'));

    /*
      The route may be the slider rather than the swatches — brightness reaches
      most targets — so what matters is that SOMETHING is now writable. Before
      this fix, both sides were locked out entirely the moment a colour was
      sampled, and there was no way to change the artwork at all.
    */
    ok(doc.getElementById('bg-b').disabled === false ||
       doc.getElementById('fg-b').disabled === false,
        'at least one side can still be edited after sampling');

    const before = host.applied().length;
    const bSlider = doc.getElementById('fg-b');
    bSlider.value = '20';
    bSlider.dispatchEvent(new win.Event('input', { bubbles: true }));
    bSlider.dispatchEvent(new win.Event('change', { bubbles: true }));
    await wait(250);
    ok(host.applied().length === before + 1,
        'and editing it reaches the artwork',
        JSON.stringify(host.applied().slice(before)));
    ok(/Set /.test(txt(doc, 'fix-note')), 'with a confirmation', txt(doc, 'fix-note'));
    ok(/“/.test(txt(doc, 'fix-note')),
        'that names the object it changed', txt(doc, 'fix-note'));

    section('and it says when the colour came from a screen sample');
    /*
      Disclosure in place of refusal. The pixel was picked off the screen; the
      object being written to is whatever the host detected. Those can disagree,
      and the panel says so rather than pretending or blocking.
    */
    // Edit the BACKGROUND — the side whose displayed colour came from a screen
    // pixel rather than from the object it will be written to.
    ({ win, doc, host, errors } = boot([200, 200, 200]));
    await wait(150);
    click(doc, 'btn-pick-bg');
    await wait(400);
    press(doc, 'Enter');
    await wait(250);

    const bgSlider = doc.getElementById('bg-b');
    ok(bgSlider.disabled === false, 'the background is still editable');
    bgSlider.value = '30';
    bgSlider.dispatchEvent(new win.Event('input', { bubbles: true }));
    bgSlider.dispatchEvent(new win.Event('change', { bubbles: true }));
    await wait(250);
    ok(/colour was sampled/.test(txt(doc, 'fix-note')),
        'and the note flags that the colour did not come from that object',
        txt(doc, 'fix-note'));

    section('a refining click goes back to the slot it filled');
    /*
      INSTALL.md tells the user to press Enter and then click to correct a pixel.
      Sending that click to the background regardless overwrote the wrong colour
      and produced a ratio between two pixels that were never text and
      background at all.
    */
    ({ win, doc, host, errors } = boot('xy'));
    await wait(150);
    click(doc, 'btn-pick-fg');
    await wait(300);
    press(doc, 'Enter');
    await wait(60);
    const lockedFg = txt(doc, 'hex-fg');
    const untouchedBg = txt(doc, 'hex-bg');
    ok(lockedFg === '#1E281E', 'Enter locked the text colour', lockedFg);
    clickCanvas(win, doc, 100, 40);
    await wait(60);
    ok(txt(doc, 'hex-fg') !== lockedFg, 'the refining click moved the text colour',
        txt(doc, 'hex-fg'));
    ok(txt(doc, 'hex-bg') === untouchedBg,
        'and left the background exactly where it was',
        txt(doc, 'hex-bg') + ' was ' + untouchedBg);
    press(doc, 'Escape');

    section('macOS blocking the screen grab is named, not guessed at');
    ({ win, doc, host, errors } = boot());
    await wait(150);
    host.setScreenBlocked(true);
    click(doc, 'btn-camera');
    await wait(1400);
    const blockedMsg = txt(doc, 'capture-note');
    ok(/Screen Recording/i.test(blockedMsg),
        'names the exact macOS permission to grant', blockedMsg);
    ok(/System Settings/i.test(blockedMsg), 'and where to find it', blockedMsg);
    ok(blockedMsg.length < 200, 'and stays short enough to actually read',
        blockedMsg.length + ' chars');
    ok(!doc.getElementById('snapshot-frame').className.includes('tracking'),
        'and it gives up rather than spinning on a permission it will never get');

    section('a helper that never ran is a different message');
    /*
      The sidecar is written before the capture, so its presence separates
      "macOS refused the grab" from "the script never got that far". Sending
      someone to a Privacy setting that is already correct wastes their time and
      hides the real fault.
    */
    ({ win, doc, host, errors } = boot());
    await wait(150);
    host.setHelperMissing(true);
    click(doc, 'btn-camera');
    await wait(1400);
    const missingMsg = txt(doc, 'capture-note');
    ok(!/Screen Recording/i.test(missingMsg),
        'does not blame a permission that is fine', missingMsg);
    ok(/helper/i.test(missingMsg), 'says the helper could not start', missingMsg);

    section('one dropped frame is not an error message');
    // Only a run of failures is worth interrupting the user for.
    ({ win, doc, host, errors } = boot());
    await wait(150);
    host.setScreenBlocked(true);
    click(doc, 'btn-camera');
    await wait(120);
    ok(doc.getElementById('capture-note').hidden === true,
        'nothing shouted after the first miss', txt(doc, 'capture-note'));

    section('the note clears when the screen starts working again');
    ({ win, doc, host, errors } = boot());
    await wait(150);
    host.setScreenBlocked(true);
    click(doc, 'btn-camera');
    await wait(1400);
    ok(/Screen Recording/i.test(txt(doc, 'capture-note')), 'the error appears',
        txt(doc, 'capture-note'));
    host.setScreenBlocked(false);
    click(doc, 'btn-camera');
    await wait(400);
    ok(doc.getElementById('capture-note').hidden === true,
        'a working grab clears the screen error', txt(doc, 'capture-note'));
    ok(txt(doc, 'capture-note') === '', 'and empties it, so no stale text lingers');
    press(doc, 'Escape');

    section('no process bridge at all');
    ({ win, doc, host, errors } = boot());
    await wait(150);
    host.setProcessMissing(true);
    click(doc, 'btn-camera');
    await wait(1400);
    const noProc = txt(doc, 'capture-note');
    // Plain language on screen; the raw reason never reaches the user.
    ok(/screenshot tool/i.test(noProc), 'says what failed in plain language', noProc);
    ok(!/createProcess|err \d/i.test(noProc), 'and does not dump internals at the user', noProc);

    section('nothing is captured until the user asks');
    /*
      An early build captured the artwork on every selection change. That is
      the kind of call implicated in the 1.9.0 crash, and when it failed it
      failed invisibly. Nothing may be grabbed until someone arms the eyedropper.
    */
    ({ win, doc, host, errors } = boot());
    await wait(500);
    ok(host.processCalls().length === 0,
        'nothing is captured until the user asks', String(host.processCalls().length));
    const idleProbe = await probe(win);
    ok(idleProbe.mode === 'idle', 'the preview sits idle', idleProbe.mode);

    section('no background found');
    ({ win, doc, host, errors } = boot());
    host.setScenario('noBackground');
    await wait(700);
    ok(!doc.getElementById('notice').hidden, 'paper notice shown');
    ok(/white paper/.test(doc.getElementById('notice').textContent), 'explains the paper fallback');

    section('empty selection');
    ({ win, doc, host, errors } = boot());
    host.setScenario('none');
    await wait(700);
    ok(txt(doc, 'ratio') === '·', 'ratio cleared', txt(doc, 'ratio'));
    ok(/Select artwork/.test(txt(doc, 'ratio-note')), 'prompts for a selection', txt(doc, 'ratio-note'));
    ok(doc.querySelectorAll('#fixes .fix').length === 0, 'no stale fix swatches');

    section('an empty artboard reports nothing, not black on white');
    /*
      The defaults behind the colour resolvers are black on white, so with no
      selection the old report printed a confident "ratio: 21.00", an invented
      number. The probe reads the same resolvers, so it pins the same rule.
    */
    ({ win, doc, host, errors } = boot());
    host.setScenario('none');
    await wait(700);
    const emptyProbe = await probe(win);
    ok(emptyProbe.ratio === null, 'no fabricated 21.00 for an empty selection', String(emptyProbe.ratio));
    ok(emptyProbe.measurable === 'nothing', 'it knows there is nothing to measure', emptyProbe.measurable);
    ok(emptyProbe.fixes === 0, 'and no stale fix swatches are still counted', String(emptyProbe.fixes));

    section('outlined text recolours every letter');
    ({ win, doc, host, errors } = boot());
    host.setScenario('outlined');
    await wait(900);
    /*
      Outlined text is a group of compound paths, one per letter. Whichever route
      the designer takes — a rung swatch or the slider — every letter has to
      travel with it. Recolouring one was the bug seen in the field.
    */
    const olSlider = doc.getElementById('fg-b');
    ok(olSlider.disabled === false, 'the outlined group is editable');
    olSlider.value = '15';
    olSlider.dispatchEvent(new win.Event('input', { bubbles: true }));
    olSlider.dispatchEvent(new win.Event('change', { bubbles: true }));
    await wait(250);

    const lastApply = host.applied()[host.applied().length - 1];
    ok(lastApply && lastApply.tokens.length === 47,
        'all 47 tokens sent to the host, not one',
        lastApply ? String(lastApply.tokens.length) : 'none');
    ok(/undoes it/.test(txt(doc, 'fix-note')), 'and undo is named', txt(doc, 'fix-note'));

    // The same guarantee through the swatch route, when it is on offer.
    const olFixes = [...doc.querySelectorAll('#fixes .fix')].filter(b => !b.disabled);
    if (olFixes.length) {
        const beforeOl = host.applied().length;
        olFixes[0].dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
        await wait(120);
        const viaSwatch = host.applied()[host.applied().length - 1];
        ok(host.applied().length === beforeOl + 1 && viaSwatch.tokens.length === 47,
            'and a rung swatch sends all 47 too',
            viaSwatch ? String(viaSwatch.tokens.length) : 'none');
    } else {
        ok(true, 'brightness alone reaches the target here, so no swatches are needed');
    }

    section('a group opacity is applied to the pair, once');
    /*
      Black text on #808080, both inside one group at 65% over white paper.
      Illustrator draws the group into a buffer and lays that buffer down once:
      #595959 on #ACACAC, 3.08:1, a failure.

      Charging the 65% to the background AND again to the text gives 4.86, a
      pass. Cancelling it from the text entirely gives pure black at 9.25, a
      bigger pass. Both were wrong in the direction that flatters the artwork.

      The engine maths is pinned in run-color.js. This pins the WIRING: that the
      main view actually hands the shared group to the engine. It used to be
      exercised only through a scan row, so removing the scan would otherwise
      have removed the only panel test of it.
    */
    ({ win, doc, host, errors } = boot());
    host.setScenario('group');
    await wait(1000);
    ok(txt(doc, 'ratio') === '3.08', 'black in a 65% group reads 3.08, not 4.86 or 9.25',
        txt(doc, 'ratio'));
    ok(txt(doc, 'm-normal-aa') === '✕', 'and the matrix calls it the failure it is',
        txt(doc, 'm-normal-aa'));

    section('settings survive a reload');
    /*
      Level, size override and the rendered-colour switch all reset on every
      panel reload — which in Illustrator means every restart. A studio working
      to AAA set it again every session, from inside a popover.
    */
    ({ win, doc, host, errors } = boot());
    await wait(120);
    ok(txt(doc, 'level-chip') === 'AA', 'starts at AA', txt(doc, 'level-chip'));

    click(doc, 'level-chip');
    await wait(120);
    ok(txt(doc, 'level-chip') === 'AAA', 'the header chip switches the target',
        txt(doc, 'level-chip'));
    ok(doc.querySelector('#seg-level button[data-value="AAA"]').className.indexOf('on') >= 0,
        'and the popover control agrees — they are one setting, not two');
    ok(/needs 7/.test(txt(doc, 'ratio-note')),
        'the verdict is regraded against it', txt(doc, 'ratio-note'));

    doc.getElementById('opt-rendered').checked = false;
    doc.getElementById('opt-rendered').dispatchEvent(new win.Event('change', { bubbles: true }));
    await wait(80);

    // A reload is a fresh window against the same storage.
    ({ win, doc, host, errors } = boot(null, true));
    await wait(200);
    ok(txt(doc, 'level-chip') === 'AAA', 'AAA is still selected after a reload',
        txt(doc, 'level-chip'));
    ok(doc.getElementById('opt-rendered').checked === false,
        'and so is the rendered-colour switch');
    ok(doc.querySelector('#seg-level button[data-value="AAA"]').className.indexOf('on') >= 0,
        'with the popover painted to match, not left on its markup default');

    section('outlined type is asked about, not silently graded as an icon');
    /*
      Outlined type is paths, so it is classed as a graphic and graded at 3:1.
      WCAG grades images of text as text, at 4.5:1 for body sizes. The panel
      cannot tell a word from an icon set, so it asks, and offers both sizes,
      because outlined type is usually display type.
    */
    ({ win, doc, host, errors } = boot());
    host.setScenario('outlined');
    await wait(1000);
    const outlineNote = doc.getElementById('outline-note');
    ok(outlineNote && !outlineNote.hidden, 'a group of same-coloured compound paths prompts the question');
    ok(/outlined type/.test(outlineNote.textContent) && /3:1/.test(outlineNote.textContent),
        'naming what it looks like and the threshold it is being held to', outlineNote.textContent);
    const answers = [...outlineNote.querySelectorAll('button')].map(b => b.textContent);
    ok(answers.join('|') === 'body text|large text', 'with both answers on offer', answers.join('|'));

    outlineNote.querySelectorAll('button')[1].dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await wait(80);
    ok(/^as large text/.test(txt(doc, 'ratio-note')),
        'one tap grades it as large text, and the verdict says it was told to',
        txt(doc, 'ratio-note'));
    ok(outlineNote.hidden, 'and the question goes away once it is answered');

    /*
      That answer was about THIS artwork. It must neither persist nor carry over.

      The note's buttons never save anything themselves, so the way it could leak
      is through ANOTHER setting being saved while it is active, which writes the
      whole preference set. Change the level, then reload.
    */
    click(doc, 'level-chip');
    await wait(80);
    ({ win, doc, host, errors } = boot(null, true));
    await wait(200);
    ok(txt(doc, 'level-chip') === 'AAA', 'the level change that was saved alongside it did persist',
        txt(doc, 'level-chip'));
    ok(doc.querySelector('#seg-size button[data-value="auto"]').className.indexOf('on') >= 0,
        'but the outlined type answer did not: a reload is back on Auto');

    ({ win, doc, host, errors } = boot());
    host.setScenario('outlined');
    await wait(1000);
    doc.getElementById('outline-note').querySelectorAll('button')[0]
       .dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await wait(80);
    ok(/^as body text/.test(txt(doc, 'ratio-note')), 'body text works the same way',
        txt(doc, 'ratio-note'));
    host.setScenario('teal');
    await wait(1200);
    ok(!/^as /.test(txt(doc, 'ratio-note')),
        'and selecting something else drops back to Auto', txt(doc, 'ratio-note'));
    ok(doc.getElementById('outline-note').hidden, 'ordinary text never sees the question');

    section('text with more than one colour is graded at its weakest');
    /*
      The host hands over every run in the frame. The black run comes first and
      reads 21:1; the grey one beside it reads 4.54. The verdict is the grey,
      the notice says the frame is mixed, and a fix replaces the grey and
      nothing else.
    */
    ({ win, doc, host, errors } = boot());
    host.setColorSpace('RGB');
    host.setScenario('mixedText');
    await wait(1000);
    ok(txt(doc, 'ratio') === '4.54', 'the grey run is the verdict, not the black one first in line', txt(doc, 'ratio'));
    ok(/mixes 2 colours/.test(txt(doc, 'notice')) && /#767676/.test(txt(doc, 'notice')),
        'the notice says the text is mixed and names the colour graded', txt(doc, 'notice'));
    ok(txt(doc, 'hex-fg') === '#767676', 'and the text swatch shows that colour', txt(doc, 'hex-fg'));

    // Snap the text to 7:1 from its slider: the write has to name the grey.
    const mixedMark = doc.querySelector('#fg-marks .mark.aaa');
    const mixedBefore = host.applied().length;
    if (mixedMark) {
        mixedMark.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
        await wait(300);
    }
    const mixedWrite = host.applied()[host.applied().length - 1];
    ok(!!mixedMark && host.applied().length === mixedBefore + 1 && mixedWrite.from === '#767676',
        'a fix tells the host which colour it replaces', JSON.stringify(mixedWrite));
    await wait(1000);
    ok(txt(doc, 'ratio') !== '4.54' && /mixes 2 colours/.test(txt(doc, 'notice')),
        'and the reading moves on, with the black run still there', txt(doc, 'ratio') + ' / ' + txt(doc, 'notice'));

    ({ win, doc, host, errors } = boot());
    host.setColorSpace('RGB');
    host.setScenario('mixedSizes');
    await wait(1000);
    ok(txt(doc, 'ratio') === '3.54', 'one colour at two sizes reads 3.54', txt(doc, 'ratio'));
    ok(/^12px body text/.test(txt(doc, 'ratio-note')) && /needs 4\.5/.test(txt(doc, 'ratio-note')),
        'and is graded at the 12px line, which needs 4.5, not the 24px headline that passes at 3',
        txt(doc, 'ratio-note'));
    ok(/mixes 2 sizes/.test(txt(doc, 'notice')), 'the notice names the sizes', txt(doc, 'notice'));
    ok(/Part of this text uses a gradient or pattern/.test(txt(doc, 'notice')),
        'and admits the run it could not grade', txt(doc, 'notice'));

    section('a gradient with unread stops says so, and the notice stays');
    ({ win, doc, host, errors } = boot());
    host.setScenario('gradient');
    host.setStopsMissed(2);
    await wait(1000);
    ok(/2 stops in this gradient could not be read/.test(txt(doc, 'notice')),
        'the warning is still on screen after the render finishes', txt(doc, 'notice'));
    host.setStopsMissed(0);

    section('what counts as large text depends on the medium');
    /*
      WCAG's 18pt is a CSS point, so on screen large text starts at 24px. An
      Illustrator web document treats one pixel as one point, so 18 units of
      type there is body text. 1.10.0 graded it as large and passed 3.94:1
      against a 3:1 target that does not apply to it.

      The host still says sizeClass 'large' in this fixture, as the real one
      would: it only knows points. The panel has to overrule it for text.
    */
    ({ win, doc, host, errors } = boot());
    host.setColorSpace('RGB');
    host.setScenario('heading18');
    await wait(1000);
    // 3.949, truncated rather than rounded, so the panel never flatters a ratio.
    ok(txt(doc, 'ratio') === '3.94', 'white on mid grey reads 3.94', txt(doc, 'ratio'));
    ok(/^18px body text/.test(txt(doc, 'ratio-note')),
        'in an RGB document 18 units is 18px body text, and the unit says so',
        txt(doc, 'ratio-note'));
    ok(/needs 4\.5/.test(txt(doc, 'ratio-note')), 'so it needs 4.5, and fails',
        txt(doc, 'ratio-note'));

    click(doc, 'btn-options');
    doc.querySelector('#seg-medium button[data-value="print"]')
       .dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await wait(150);
    click(doc, 'btn-options-close');
    ok(/^18pt large text/.test(txt(doc, 'ratio-note')),
        'set to Print, the same 18 is 18pt large text', txt(doc, 'ratio-note'));
    ok(/passes AA/.test(txt(doc, 'ratio-note')), 'and passes at 3:1', txt(doc, 'ratio-note'));

    // Auto follows the document. The mock reports CMYK unless told otherwise.
    ({ win, doc, host, errors } = boot());
    host.setScenario('heading18');
    await wait(1000);
    ok(/^18pt large text/.test(txt(doc, 'ratio-note')),
        'Auto treats a CMYK document as print', txt(doc, 'ratio-note'));

    // And the choice is remembered like every other setting.
    click(doc, 'btn-options');
    doc.querySelector('#seg-medium button[data-value="screen"]')
       .dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await wait(80);
    ({ win, doc, host, errors } = boot(null, true));
    await wait(200);
    ok(doc.querySelector('#seg-medium button[data-value="screen"]').className.indexOf('on') >= 0,
        'the medium survives a reload, with the control painted to match');

    section('switching document re-reads the document info');
    /*
      The colour space note is read when the document in front changes, which
      the panel learns from the first field of the signature. Illustrator
      restores panels before documents, so reading it once at boot described a
      file that was no longer open, CMYK caveat and all.
    */
    ({ win, doc, host, errors } = boot());
    await wait(900);
    ok(/Sample Layout\.ai/.test(txt(doc, 'doc-note')), 'the note names the document in front',
        txt(doc, 'doc-note'));

    host.setDocument('Another File.ai');   // a different document in front
    await wait(1200);
    ok(/Another File\.ai/.test(txt(doc, 'doc-note')),
        'and follows it when another document comes forward', txt(doc, 'doc-note'));

    section('recolouring the background updates the ratio, live');
    /*
      The bug: the signature stamped only the SELECTED items. The background is
      found by geometry and is not selected, so editing the card behind the text
      in Illustrator's own Color panel moved nothing in the fingerprint — and the
      panel went on presenting a pre-edit ratio as a live reading, which is the
      one thing a 700ms poll exists to prevent.
    */
    ({ win, doc, host, errors } = boot());
    await wait(900);
    ok(txt(doc, 'ratio') === '4.12', 'white on teal reads 4.12', txt(doc, 'ratio'));

    /*
      1.9.0 handed the host the tokens of both measured objects so it could stamp
      their colours into every poll. That is what made the refresh instant, and
      it is also what crashed Illustrator: the host had to keep the item wrappers
      between calls, and eventually read one whose art had been freed.

      The poll now sends nothing. The refresh below still has to work.
    */
    ok(!host.watched(),
        'the poll hands the host no stored tokens to dereference',
        JSON.stringify(host.watched()));

    // Recolour the background only. The selection is untouched.
    host.recolour('background', [0, 0, 0]);
    await wait(3400);
    ok(txt(doc, 'hex-bg') === '#000000',
        'the background swatch follows the edit', txt(doc, 'hex-bg'));
    ok(txt(doc, 'ratio') === '21.00',
        'and the ratio re-reads without the selection changing', txt(doc, 'ratio'));

    // And the foreground, equally.
    host.recolour('foreground', [128, 128, 128]);
    await wait(3400);
    ok(txt(doc, 'hex-fg') === '#808080', 'the text swatch too', txt(doc, 'hex-fg'));
    ok(txt(doc, 'ratio') !== '21.00', 'with a fresh ratio', txt(doc, 'ratio'));

    section('the poll stands down when nothing is happening');
    /*
      1.9.0 polled every 700ms from the moment it loaded until the page was
      destroyed, with no stop path anywhere in the file, no gate on visibility
      and no gate on the host quitting. That is roughly 5,100 evalScript calls
      an hour dispatched onto Illustrator's main thread whatever it was doing,
      and the crash log for the bug that produced this version caught one of
      them landing in the middle of a mouse click.

      The rate must fall off on its own when the user is not touching anything.
    */
    ({ win, doc, host, errors } = boot());
    await wait(600);
    const pollsAtStart = host.calls('wcagSelectionSignature');
    await wait(6000);
    const pollsWhileQuiet = host.calls('wcagSelectionSignature') - pollsAtStart;
    /*
      Six seconds at the old fixed rate is eight or nine polls. Backing off to
      idle after six quiet ones should land well under that. The bound is loose
      on purpose: this asserts that a stand-down happens, not its exact shape.
    */
    ok(pollsWhileQuiet > 0,
        'a quiet panel still polls, so it never goes deaf',
        String(pollsWhileQuiet));
    ok(pollsWhileQuiet <= 7,
        'but slower than the active rate, which fixed-cadence polling could not do',
        pollsWhileQuiet + ' polls in six quiet seconds');

    section('the compliance line, and the spec link');
    /*
      The panel has to say what standard it measures to without anyone opening a
      menu — that is the whole point of a compliance line. The long form lives in
      Settings, short, with a link out rather than a transcription of the spec.
    */
    ({ win, doc, host, errors } = boot());
    await wait(150);
    const conformance = doc.querySelector('.conformance').textContent;
    ok(/WCAG 2\.2/.test(conformance), 'the standard is named on the face of the panel', conformance);
    ok(/1\.4\.3/.test(conformance) && /1\.4\.6/.test(conformance) && /1\.4\.11/.test(conformance),
        'with all three success criteria it implements', conformance);
    ok(!doc.querySelector('.conformance').hidden, 'and it is not hidden behind anything');

    click(doc, 'btn-options');
    await wait(120);
    const detail = doc.querySelector('.conformance-block');
    ok(!!detail, 'Settings carries the long form');
    ok(detail.tagName === 'DETAILS' && !detail.open,
        'collapsed by default, so it does not fill the popover', detail.tagName);
    ok(/4\.5:1/.test(detail.textContent) && /7:1/.test(detail.textContent) &&
       /3:1/.test(detail.textContent), 'with the thresholds', detail.textContent.slice(0, 80));
    ok(/2\.1/.test(detail.textContent),
        'and the note that 2.2 conformance covers 2.1', detail.textContent);

    /*
      A link, not an <a href>. A CEP panel is a chrome-less webview: a normal
      link would navigate the panel itself to the W3C site and leave no way back.
    */
    ok(doc.querySelectorAll('#options a[href]').length === 0,
        'nothing in the popover is a raw link that would replace the panel');
    ok(!!doc.getElementById('btn-wcag-link'), 'the spec is reachable by a button');
    click(doc, 'btn-wcag-link');
    await wait(60);
    ok(/w3\.org/.test(txt(doc, 'doc-note')),
        'which falls back to showing the URL when there is no browser to open',
        txt(doc, 'doc-note'));
    click(doc, 'btn-options-close');
    await wait(60);

    section('colour sliders: preview while dragging, one write on release');
    /*
      The whole design turns on this split. CEP cannot group undo steps, so a
      slider that wrote on every frame would leave fifty entries between the
      designer and the colour they started from — Cmd+Z fifty times to undo one
      drag. Dragging previews in the panel; letting go writes once.
    */
    ({ win, doc, host, errors } = boot());
    await wait(900);
    const startRatio = txt(doc, 'ratio');
    const writesBefore = host.applied().length;

    const bgB = doc.getElementById('bg-b');
    ok(bgB.disabled === false, 'the background brightness slider is live');

    // Three `input` events: a drag in progress.
    for (const value of [60, 40, 20]) {
        bgB.value = String(value);
        bgB.dispatchEvent(new win.Event('input', { bubbles: true }));
        await wait(20);
    }
    ok(host.applied().length === writesBefore,
        'nothing is written to the artwork while the pointer is still down',
        String(host.applied().length - writesBefore));
    ok(txt(doc, 'ratio') !== startRatio,
        'but the panel tracks the drag live', startRatio + ' -> ' + txt(doc, 'ratio'));
    ok(txt(doc, 'hex-bg') !== '#0E8C82',
        'and the swatch previews the new colour', txt(doc, 'hex-bg'));

    // `change`: the pointer came up.
    bgB.dispatchEvent(new win.Event('change', { bubbles: true }));
    await wait(200);
    ok(host.applied().length === writesBefore + 1,
        'releasing writes exactly once — one undo step for the whole drag',
        String(host.applied().length - writesBefore));
    ok(host.applied()[host.applied().length - 1].side === 'background',
        'to the background object', host.applied()[host.applied().length - 1].side);
    ok(/Set /.test(txt(doc, 'fix-note')), 'with a confirmation', txt(doc, 'fix-note'));
    ok(/undoes it/.test(txt(doc, 'fix-note')), 'that names undo', txt(doc, 'fix-note'));

    section('a drag survives a poll landing mid-gesture');
    /*
      The bug this exists to stop, and it shipped: the host clears its token
      registry and reissues names on every wcagSelection, and the panel was
      stamping those NAMES into the selection signature. So the signature
      differed every single time, loadSelection fired on every poll forever, and
      clearSampleState nulled the slider draft — a drag held longer than 700ms
      had its thumb snapped back and its edit silently dropped, with no message.

      Pausing mid-drag to read the ratio is the normal gesture, which is what
      made this so bad. The bundled mock used fixed token names, so 335 panel
      assertions sailed over it; it now reissues names exactly as the host does.
    */
    ({ win, doc, host, errors } = boot());
    await wait(900);
    const readsBefore = host.calls('wcagSelection');
    await wait(2100);   // three polls with nothing touched
    /*
      Was: exactly zero re-reads. Now: at most one.

      The panel re-reads on a slow heartbeat, because that is how it notices a
      background recoloured elsewhere in the document now that it no longer
      hands the host stored tokens to stamp. What must never come back is a
      re-read on EVERY poll, which is what the token-name feedback loop caused.
    */
    const extraReads = host.calls('wcagSelection') - readsBefore;
    ok(extraReads <= 1,
        'an untouched selection re-reads on the heartbeat, not on every poll',
        extraReads + ' re-reads across three polls');

    const holdSlider = doc.getElementById('bg-b');
    const startValue = holdSlider.value;
    holdSlider.value = '25';
    holdSlider.dispatchEvent(new win.Event('input', { bubbles: true }));
    await wait(60);
    const midRatio = txt(doc, 'ratio');

    // Hold it. Two polls land while the pointer is still down.
    await wait(1600);
    ok(holdSlider.value === '25',
        'the thumb stays where the hand left it', holdSlider.value + ' (was ' + startValue + ')');
    ok(txt(doc, 'ratio') === midRatio,
        'and the preview holds too', midRatio + ' -> ' + txt(doc, 'ratio'));

    const writesBeforeRelease = host.applied().length;
    holdSlider.dispatchEvent(new win.Event('change', { bubbles: true }));
    await wait(250);
    ok(host.applied().length === writesBeforeRelease + 1,
        'and releasing after the pause still writes the edit',
        String(host.applied().length - writesBeforeRelease));

    section('semi-transparent artwork: no control is a silent no-op');
    /*
      The most complete dead end in the panel, and every part of it was silent.

      Black text at 50% opacity on white paper renders #808080 — 3.94:1 — and NO
      authored fill can render darker through 50%, so the text side is genuinely
      unfixable. The panel used to show a green passing zone across nearly half
      the brightness track, three "snap to" marks, and a hidden rung ladder;
      clicking the advertised 7:1 mark snapped the thumb back and wrote nothing,
      and the one sentence explaining why was written into #fix-note, which lived
      INSIDE the hidden #fix-block and so was never displayed.
    */
    ({ win, doc, host, errors } = boot());
    host.setScenario('transparent');
    await wait(1000);
    host.recolour('background', [255, 255, 255]);
    await wait(3400);
    ok(txt(doc, 'ratio') === '3.94', '50% black on paper renders 3.94', txt(doc, 'ratio'));

    ok(doc.querySelectorAll('#fg-marks .zone').length === 0,
        'no green passing zone is painted where nothing can pass',
        String(doc.querySelectorAll('#fg-marks .zone').length));

    const noteNode = doc.getElementById('fix-note');
    ok(!!noteNode.textContent.trim(), 'and the panel says something', noteNode.textContent);
    ok(/Try changing the background/.test(noteNode.textContent),
        'naming the side that CAN be changed', noteNode.textContent);
    ok(doc.getElementById('bg-b').disabled === false,
        'which is in fact editable — so there is a route out');

    /*
      The note has to live outside the collapsible block. Inside it, it was
      hidden in exactly the two states where it mattered: this one, and a
      successful edit (which hides the block because nothing is left to fix, and
      hid the sentence naming what just changed).
    */
    ok(!doc.getElementById('fix-block').contains(noteNode),
        'the outcome line is not inside the block that hides itself');

    section('the slider shows where compliance starts');
    /*
      A slider on its own is hunting: you drag until the number turns green. The
      thresholds are drawn ON the track, so the passing stretch is visible before
      you touch it, and each mark is a target you can click.
    */
    ({ win, doc, host, errors } = boot());
    await wait(900);
    const marks = doc.querySelectorAll('#bg-marks .mark');
    ok(marks.length > 0, 'the brightness track carries threshold marks', String(marks.length));
    ok([...marks].every(m => /^\d+(\.\d+)?%$/.test(m.style.left)),
        'each positioned along the track', [...marks].map(m => m.style.left).join(' '));
    ok(doc.querySelectorAll('#bg-marks .zone').length > 0,
        'and the passing stretch is painted');
    ok(/Snap to/.test(marks[0].title), 'each mark says what it does', marks[0].title);

    section('clicking a mark moves the least distance that passes');
    const beforeSnap = host.applied().length;
    // The AA mark: the one this panel is currently targeting.
    const aaMark = [...marks].find(m => /4\.5/.test(m.title)) || marks[0];
    aaMark.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await wait(250);
    ok(host.applied().length === beforeSnap + 1,
        'snapping writes once', String(host.applied().length - beforeSnap));
    await wait(900);
    ok(parseFloat(txt(doc, 'ratio')) >= 4.5,
        'and lands on a colour that actually clears the target', txt(doc, 'ratio'));

    section('a slider with no object behind it is disabled, not broken');
    ({ win, doc, host, errors } = boot());
    host.setScenario('gradient');
    await wait(900);
    ok(doc.getElementById('bg-b').disabled === true,
        'a gradient cannot be recoloured with one flat fill, so its slider is off');
    ok(/gradient/.test(txt(doc, 'bg-slider-note')),
        'and it says why', txt(doc, 'bg-slider-note'));
    ok(doc.getElementById('fg-b').disabled === false,
        'while the text slider stays usable — that is the side you can fix');

    section('a held frame does not survive a change of selection');
    /*
      The pane kept showing a frame of the PREVIOUS selection, still inviting
      "click a pixel to set the background", and the click committed that old
      pixel as the new selection's background, silently. The pinned-colour
      warning could never fire, because it compares against the signature at pick
      time and the mismatch happened before the pick.

      A forced reload (the panel re-reading after its own pick) must NOT drop the
      frame, or refining inside it breaks. Only a genuine change does. Locking a
      pixel releases the eyedropper's selection hold, which queues exactly that
      forced reload, so the wait below lets it land before the selection changes.

      This used to be tested through the Render button. The rule belongs to the
      held frame, not to how the frame was captured, so it moved to the
      eyedropper when Render was removed.
    */
    ({ win, doc, host, errors } = boot());
    await wait(900);
    click(doc, 'btn-camera');
    await wait(300);
    press(doc, 'Enter');
    await wait(900);
    ok(/Click a pixel/.test(txt(doc, 'pick-hint')),
        'a locked frame is held and invites a refining click', txt(doc, 'pick-hint'));

    host.setScenario('blueHeading');
    await wait(1200);
    ok(!/Click a pixel/.test(txt(doc, 'pick-hint')),
        'selecting something else drops it rather than offering a stale pixel',
        txt(doc, 'pick-hint'));
    ok(doc.getElementById('snapshot-frame').classList.contains('idle'),
        'and the pane collapses again');

    section('options popover');
    ({ win, doc, host, errors } = boot());
    await wait(80);
    ok(doc.getElementById('options').hidden, 'closed to begin with');
    ok(doc.getElementById('options-scrim').hidden, 'scrim hidden too');
    click(doc, 'btn-options');
    ok(!doc.getElementById('options').hidden, 'options open');
    ok(!doc.getElementById('options-scrim').hidden, 'scrim appears behind it');
    ok(doc.getElementById('btn-options').getAttribute('aria-expanded') === 'true',
        'gear reports its expanded state');
    ok(doc.getElementById('options').classList.contains('popover'), 'renders as a popover');
    ok(!!doc.getElementById('btn-options-close'), 'has an explicit close button');
    const aaaBtn = doc.querySelector('#seg-level button[data-value="AAA"]');
    aaaBtn.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await wait(30);
    ok(aaaBtn.className.includes('on'), 'AAA selected');
    ok(/needs 7/.test(txt(doc, 'ratio-note')), 'target rises to 7:1', txt(doc, 'ratio-note'));

    const largeBtn = doc.querySelector('#seg-size button[data-value="large"]');
    largeBtn.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await wait(30);
    ok(/large text/.test(txt(doc, 'ratio-note')), 'size override applies', txt(doc, 'ratio-note'));

    section('popover dismissal');
    click(doc, 'options-scrim');
    ok(doc.getElementById('options').hidden, 'clicking away closes it');
    click(doc, 'btn-options');
    ok(!doc.getElementById('options').hidden, 'reopens');
    doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    ok(doc.getElementById('options').hidden, 'Escape closes it');
    click(doc, 'btn-options');
    click(doc, 'btn-options-close');
    ok(doc.getElementById('options').hidden, 'close button closes it');
    ok(doc.getElementById('btn-options').getAttribute('aria-expanded') === 'false',
        'gear state resets');
    click(doc, 'btn-options');

    section('apply failure surfaces to the user');
    ({ win, doc, host, errors } = boot());
    await wait(80);
    host.setApplyFailure(true);
    // Through the slider, which is the route most edits take.
    const failSlider = doc.getElementById('bg-b');
    failSlider.value = '25';
    failSlider.dispatchEvent(new win.Event('input', { bubbles: true }));
    failSlider.dispatchEvent(new win.Event('change', { bubbles: true }));
    await wait(200);
    ok(/no longer available/.test(txt(doc, 'fix-note')), 'host error is shown', txt(doc, 'fix-note'));

    section('no host at all');
    {
        const html = fs.readFileSync(path.join(CLIENT, 'index.html'), 'utf8');
        const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'file://x' });
        const w = dom.window;
        stubCanvas(w, [0, 0, 0]);
        for (const f of ['js/color.js', 'js/cep.js', 'js/panel.js']) {
            w.eval(fs.readFileSync(path.join(CLIENT, f), 'utf8'));
        }
        w.document.dispatchEvent(new w.Event('DOMContentLoaded'));
        await wait(30);
        ok(txt(w.document, 'status-dot') === 'no host', 'degrades gracefully outside CEP',
            txt(w.document, 'status-dot'));
        ok(/must run inside Illustrator/.test(txt(w.document, 'ratio-note')), 'explains why');
    }

    closeAll();

    console.log('\n' + pass + ' passed, ' + fail + ' failed');
    if (fail) {
        console.log('\nFailures:');
        failures.forEach(f => console.log('  - ' + f));
    }

    // jsdom timers can outlive close(); exit explicitly.
    process.exit(fail ? 1 : 0);
}());
