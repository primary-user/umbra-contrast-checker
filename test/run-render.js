/*
  Render test — the real panel, in a real browser.

  WHY THIS EXISTS
  ---------------
  run-panel.js drives the panel under jsdom, which has no cascade engine and no
  canvas. That is fine for wiring and logic, and useless for anything that
  depends on how a browser actually paints. It let a shipping bug through:

    .snapshot-empty { display: flex }

  Author styles beat the browser's own `[hidden] { display: none }`, so the
  "Reading the screen…" overlay could not be hidden. The loupe was drawing
  correctly the entire time, underneath an opaque grey panel. Under jsdom the
  assertion `node.hidden === true` passed happily.

  So this suite asks the questions only a browser can answer: is it visible, what
  colour is that pixel, did the magnification interpolate.

  Run:  node test/run-render.js        (needs Playwright; skips cleanly without)
*/

const fs = require('fs');
const path = require('path');
const { loupeFixture, expectedHex, FIXTURE_PX, FIXTURE_POINTS } = require('./make-fixture-png');

const ROOT = path.join(__dirname, '..');
const CLIENT = path.join(ROOT, 'client');

let pass = 0, fail = 0;
const failures = [];

function ok(cond, label, extra) {
    if (cond) { pass++; console.log('PASS  ' + label); }
    else { fail++; failures.push(label); console.log('FAIL  ' + label + (extra ? '  -> ' + extra : '')); }
}
function section(t) { console.log('\n=== ' + t + ' ==='); }

// Local install first, then a global one, then whatever PLAYWRIGHT_PATH points at.
function loadPlaywright() {
    const specs = ['playwright', 'playwright-core'];
    if (process.env.PLAYWRIGHT_PATH) specs.push(process.env.PLAYWRIGHT_PATH);
    for (const spec of specs) {
        try { return require(spec); } catch (e) {}
    }
    return null;
}

(async function main() {
    const pw = loadPlaywright();
    if (!pw) {
        console.log('SKIP  Playwright is not installed — run `npm install` in test/ to enable');
        console.log('      the render suite. The other four suites cover everything else.');
        return;
    }

    const wait = (ms) => new Promise(r => setTimeout(r, ms));

    const browser = await pw.chromium.launch();
    const page = await browser.newPage({ viewport: { width: 240, height: 660 } });

    const consoleErrors = [];
    page.on('pageerror', e => consoleErrors.push(String(e.message)));

    /*
      One mock, two harnesses. mock-host.js is the same file run-panel.js uses;
      stripping its CommonJS tail lets it run verbatim inside the page.
    */
    const mockSrc = fs.readFileSync(path.join(__dirname, 'mock-host.js'), 'utf8')
        .replace(/if \(typeof module[\s\S]*$/, '');

    await page.addInitScript({
        content: mockSrc + `
            window.__host = makeHost();
            window.__host.install(window);
            window.__host.setFramePng(${JSON.stringify(loupeFixture())});
        `
    });

    await page.goto('file://' + path.join(CLIENT, 'index.html'));
    await wait(400);

    ok(consoleErrors.length === 0, 'no page errors on boot', consoleErrors.join(' | '));

    // ---------------------------------------------------------------------
    section('the hidden attribute actually hides');
    /*
      Every element the panel hides from JavaScript, checked as the browser
      resolves it rather than as the DOM property reports it.
    */
    const hideable = ['snapshot-empty', 'notice', 'capture-note', 'options',
                      'options-scrim', 'outline-note',
                      'marker-fg', 'marker-bg'];

    for (const id of hideable) {
        const state = await page.$eval('#' + id, (el) => {
            el.hidden = true;
            const box = el.getBoundingClientRect();
            return { display: getComputedStyle(el).display, area: box.width * box.height };
        });
        ok(state.display === 'none' && state.area === 0,
            '#' + id + ' is genuinely hidden, not just flagged',
            'display:' + state.display + ' area:' + state.area);
    }

    // ---------------------------------------------------------------------
    section('the loupe actually appears in the preview');
    await page.click('#btn-camera');
    await wait(900);

    const pane = await page.$eval('#snapshot-frame', (frame) => {
        const canvas = frame.querySelector('#snapshot');
        const empty = frame.querySelector('#snapshot-empty');
        return {
            emptyDisplay: getComputedStyle(empty).display,
            emptyText: empty.textContent,
            canvasW: canvas.width,
            canvasH: canvas.height,
            tracking: frame.className.indexOf('tracking') >= 0
        };
    });

    ok(pane.tracking, 'the loupe is tracking');
    ok(pane.emptyDisplay === 'none',
        'the "reading the screen" overlay is gone once a frame arrives',
        pane.emptyDisplay + ' / "' + pane.emptyText + '"');
    ok(pane.canvasW > 100 && pane.canvasH > 50,
        'the canvas has real dimensions', pane.canvasW + 'x' + pane.canvasH);

    // Something was genuinely painted: not still the empty-pane fill.
    const painted = await page.$eval('#snapshot', (canvas) => {
        const ctx = canvas.getContext('2d');
        const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        const seen = {};
        for (let i = 0; i < data.length; i += 4) {
            seen[data[i] + ',' + data[i + 1] + ',' + data[i + 2]] = true;
        }
        return Object.keys(seen).length;
    });
    ok(painted > 8, 'the canvas holds a real image, not a flat fill',
        painted + ' distinct colours');

    // ---------------------------------------------------------------------
    section('magnification shows pixels as pixels');
    /*
      The fixture is a gradient with a known value per pixel. If the loupe
      interpolated, the centre of a magnified block would not match its source
      colour exactly, and neighbouring blocks would blend into each other.
    */
    const blocks = await page.evaluate(() => {
        const canvas = document.getElementById('snapshot');
        const ctx = canvas.getContext('2d');
        const mid = (x, y) => {
            const d = ctx.getImageData(x, y, 1, 1).data;
            return [d[0], d[1], d[2]];
        };
        // Two points a few device pixels apart, inside the same magnified block.
        const a = mid(Math.round(canvas.width / 2) - 2, Math.round(canvas.height / 2) - 2);
        const b = mid(Math.round(canvas.width / 2) + 2, Math.round(canvas.height / 2) - 2);
        return { a, b };
    });
    ok(blocks.a.join(',') === blocks.b.join(','),
        'neighbouring device pixels inside one magnified block are identical',
        blocks.a.join(',') + ' vs ' + blocks.b.join(','));
    ok(blocks.a[2] === 200,
        'and carry the fixture\'s blue channel, so it is the capture being drawn',
        String(blocks.a[2]));

    // ---------------------------------------------------------------------
    section('the view pans with the pointer, without waiting for a capture');
    /*
      A 128-point region on a 2x display is 256px of capture for a pane showing
      about 24 of them. Small movements are therefore served entirely by panning
      inside the frame already held — no process, no screenshot. This is what
      makes it feel live between captures rather than lurching once per frame.
    */
    const beforePan = await page.$eval('#pick-hint', el => el.textContent);

    // Four points of movement: eight fixture pixels at 2px per point.
    await page.evaluate(() => window.__host.setPointerLine('104 104 0 0 1920 1080 2'));
    await page.waitForTimeout(200);

    const afterPan = await page.$eval('#pick-hint', el => el.textContent);
    ok(afterPan !== beforePan, 'the hex readout follows the pointer',
        beforePan + ' -> ' + afterPan);
    ok(afterPan.indexOf(expectedHex(136, 136)) === 0,
        'and names exactly the pixel now under it', afterPan);

    // Put it back so the lock assertions below have a known target.
    await page.evaluate(() => window.__host.setPointerLine('100 100 0 0 1920 1080 3'));
    await page.waitForTimeout(200);

    // ---------------------------------------------------------------------
    section('Enter locks the pixel under the pointer');
    /*
      The mock places the pointer 64 points into a 128-point region. The capture
      is 256px for those 128 points — exactly 2x, a real Retina display — so the
      pointer sits on image pixel (128, 128), which the fixture paints
      rgb(128, 128, 200).
    */
    await page.keyboard.press('Enter');
    await wait(300);

    const locked = await page.$eval('#hex-bg', el => el.textContent);
    ok(locked === expectedHex(128, 128),
        'locked the exact pixel under the pointer on a 2x display',
        locked + ' expected ' + expectedHex(128, 128));

    const chipState = await page.$eval('#mode-chip', el => ({
        label: el.textContent, cls: el.className, tip: el.getAttribute('title') || ''
    }));
    ok(chipState.label === 'Auto', 'the chip is a mode switch, always labelled Auto',
        chipState.label);
    ok(chipState.cls.indexOf('off') >= 0, 'dimmed now that a colour is overridden by hand',
        chipState.cls);
    ok(/wide-gamut/i.test(chipState.tip), 'and it explains where the colour came from',
        chipState.tip);
    const dotted = await page.$eval('#dot-bg', el => el.className.indexOf('set') >= 0);
    ok(dotted, 'with the Bg button carrying the colour it holds');

    // ---------------------------------------------------------------------
    section('the frozen frame can be clicked to refine');
    /*
      Click the centre of a specific magnified block rather than an arbitrary
      offset: the centre pixel's block straddles the middle of the canvas, so
      stepping a whole number of blocks left and up lands squarely on a known
      source pixel. Derived from the panel's own magnification so a zoom change
      cannot quietly turn this into a test of a different pixel.
    */
    const geom = await page.$eval('#snapshot', (el) => {
        const r = el.getBoundingClientRect();
        return { x: r.left, y: r.top, w: r.width, h: r.height,
                 mag: Math.max(2, Math.round(el.width / 40)) };
    });
    const stepsX = 3, stepsY = 2;
    await page.mouse.click(geom.x + geom.w / 2 - stepsX * geom.mag,
                           geom.y + geom.h / 2 - stepsY * geom.mag);
    await wait(150);

    const refined = await page.$eval('#hex-bg', el => el.textContent);
    ok(refined !== locked, 'clicking a different pixel changes the sample',
        refined + ' was ' + locked);
    ok(/^#[0-9A-F]{6}$/.test(refined), 'and it is a real colour', refined);

    /*
      The fixture encodes the coordinate in the colour, so the exact source
      pixel is checkable rather than merely plausible: stepping three blocks
      left and two up must land exactly three pixels left and two up in the
      capture. That only holds if the click maps back through the magnification
      onto the native image.
    */
    ok(refined === expectedHex(128 - stepsX, 128 - stepsY),
        'the click maps through the magnification to the exact source pixel',
        refined + ' expected ' + expectedHex(128 - stepsX, 128 - stepsY) +
        ' (mag ' + geom.mag + ')');

    // ---------------------------------------------------------------------
    section('the panel passes its own contrast check');
    /*
      A contrast checker whose own interface fails WCAG is not a credible tool,
      and the first palette did fail: eight pairs in the chrome sat below 4.5:1,
      including white on the accent blue, which is every primary button.

      This measures the RENDERED panel — every text node against the colour
      actually behind it, walking up through transparent ancestors the way a
      browser composites — so a future palette tweak cannot quietly undo it.
    */
    await page.keyboard.press('Escape');
    await page.evaluate(() => { window.__host.setScenario('teal'); });
    await wait(900);

    /*
      Everything the panel can show, shown at once.

      The earlier version of this check skipped any element with
      `offsetParent === null`, which is every collapsed surface in the panel —
      the whole options popover and both notices. It
      reported a clean sweep while never once looking at the target buttons or
      the checkbox caption. Open them first.
    */
    await page.click('#btn-options');
    await wait(300);
    await page.evaluate(() => {
        // The two transient messages, forced into view with representative text.
        const notice = document.getElementById('notice');
        notice.hidden = false;
        if (!notice.textContent.trim()) notice.textContent = 'Background assumed to be white paper';
        const cap = document.getElementById('capture-note');
        cap.hidden = false;
        if (!cap.textContent.trim()) cap.textContent = 'macOS blocked the screen grab';
        const app = document.getElementById('appearance-note');
        app.hidden = false;
        if (!app.textContent.trim()) app.textContent = 'Inside a group at 65% — colours shown as rendered';
        // The outlined type note, built the way the panel builds it, buttons and all.
        const outline = document.getElementById('outline-note');
        outline.hidden = false;
        if (!outline.textContent.trim()) {
            outline.innerHTML = '<span>Looks like outlined type, graded as a graphic at 3:1. ' +
                'WCAG grades type as text unless it is a logo. Grade it as</span>' +
                '<button class="link-btn">body text</button><button class="link-btn">large text</button>';
        }
    });
    await wait(200);

    const surfaces = await page.evaluate(() => ({
        options: !document.getElementById('options').hidden
    }));
    ok(surfaces.options,
        'every collapsed surface is open before anything is measured',
        JSON.stringify(surfaces));

    /*
      The measuring function itself. Defined once in the page so the static pass
      and each hover pass ask exactly the same question.

      Text is held to 4.5 (3.0 when large). Icons and the panel's own swatch
      outlines are held to 3.0, which is WCAG 1.4.11 for non-text contrast — the
      same rule the panel applies to the user's artwork in its "Icons" row.
    */
    const CHECKER = `(function () {
        const srgb = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
        const lum = (c) => 0.2126 * srgb(c[0]) + 0.7152 * srgb(c[1]) + 0.0722 * srgb(c[2]);
        const parse = (s) => (s.match(/[\\d.]+/g) || [0, 0, 0]).slice(0, 3).map(Number);
        const ratio = (a, b) => {
            const A = lum(a), B = lum(b);
            return (Math.max(A, B) + 0.05) / (Math.min(A, B) + 0.05);
        };

        // The colour actually behind an element, walking up through transparent
        // ancestors the way a browser composites. Null means nothing opaque was
        // found, which is reported rather than replaced with a guess.
        const behind = (el) => {
            let node = el;
            while (node) {
                const bg = getComputedStyle(node).backgroundColor;
                if (bg && !/rgba\\(\\s*0,\\s*0,\\s*0,\\s*0\\)/.test(bg) && bg !== 'transparent') {
                    const m = bg.match(/[\\d.]+\\)$/);
                    const alpha = m ? parseFloat(m[0]) : 1;
                    if (!(alpha < 0.95)) return parse(bg);
                }
                node = node.parentElement;
            }
            return null;
        };

        const visible = (el) => {
            const s = getComputedStyle(el);
            if (s.visibility === 'hidden' || s.display === 'none' || parseFloat(s.opacity) < 0.1) return false;
            const r = el.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
        };

        const out = [];
        const note = (what, need, r, detail) => {
            if (r === null) out.push({ what, need, ratio: null, detail: 'no opaque background found' });
            else if (r < need) out.push({ what, need, ratio: Math.round(r * 100) / 100, detail });
        };

        document.querySelectorAll('body *').forEach((el) => {
            if (!visible(el)) return;
            const s = getComputedStyle(el);
            /*
              Named by the nearest identified ancestor as well as itself. The
              seg-control buttons and the gear's <svg> carry no id or class of
              their own, so both reported as bare tag names — which told nobody
              which control had failed, and made it impossible to attribute a
              hover result to the element being hovered.
            */
            const own = el.id ? '#' + el.id
                : ((typeof el.className === 'string' && el.className.trim())
                    ? '.' + el.className.trim().split(/\\s+/)[0]
                    : el.tagName.toLowerCase());
            const holder = el.closest ? el.closest('[id]') : null;
            const key = (holder && holder !== el) ? '#' + holder.id + ' ' + own : own;
            const bg = behind(el);

            // Text this element renders itself, not text in its children.
            const rendersText = [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim());
            if (rendersText) {
                const size = parseFloat(s.fontSize);
                const bold = parseInt(s.fontWeight, 10) >= 700;
                // WCAG large text: 18pt (24px), or 14pt (18.66px) bold.
                const large = size >= 24 || (bold && size >= 18.66);
                note(key, large ? 3 : 4.5, bg === null ? null : ratio(parse(s.color), bg),
                     s.fontSize + ' "' + el.textContent.trim().slice(0, 24) + '"');
            }

            // Icons drawn with currentColor. WCAG 1.4.11: 3:1.
            if (el.tagName.toLowerCase() === 'svg') {
                note(key + ' (icon)', 3, bg === null ? null : ratio(parse(s.color), bg), 'svg');
            }
        });
        return out;
    }())`;

    const selfCheck = await page.evaluate(CHECKER);
    selfCheck.forEach(f => console.log('      ' + String(f.what).padEnd(22) +
        (f.ratio === null ? '  ?  ' : f.ratio + ':1') + '  needs ' + f.need + '  ' + f.detail));
    ok(selfCheck.length === 0,
        'every visible text and icon in the panel clears its own threshold',
        selfCheck.length + ' failing');

    /*
      Hover states, measured under a real pointer.

      A rule like `#btn-options:hover { color: #ff6b73; background: var(--btn) }`
      is invisible to any static sweep — nothing in the resting DOM carries those
      colours. It measured 2.97:1, under the 3:1 an icon needs, and no test in
      this repository could have seen it.

      The three .link-btn controls are here because the list, not the sweep, is
      what decides which hover states get measured — and every one of them was
      missing. `.link-btn:hover` sits on the popover surface, which is lighter
      than the chrome the accent tint was chosen against, so all three failed at
      4.46:1 while the resting state passed.
    */
    const HOVERABLE = ['#btn-options', '#btn-camera',
                       '#fix-target', '#mode-chip', '#btn-pick-fg', '#btn-pick-bg',
                       '#seg-level button:last-child',
                       '#btn-wcag-link', '#btn-site', '#btn-kofi'];
    const hoverFails = [];
    for (const sel of HOVERABLE) {
        const there = await page.$(sel);
        if (!there) { hoverFails.push({ what: sel, detail: 'selector matched nothing' }); continue; }
        try { await page.hover(sel, { timeout: 2000 }); } catch (e) { continue; }
        await wait(60);
        const found = await page.evaluate(CHECKER);
        // Only the element being hovered can have changed.
        const base = sel.replace(/^#/, '').split(' ')[0];
        found.filter(f => f.what.indexOf(base) >= 0)
             .forEach(f => hoverFails.push({ ...f, what: sel + ':hover' }));
    }
    hoverFails.forEach(f => console.log('      ' + String(f.what).padEnd(22) +
        (f.ratio == null ? '  ?  ' : f.ratio + ':1') + '  needs ' + (f.need || '-') + '  ' + (f.detail || '')));
    ok(hoverFails.length === 0,
        'and so does every one of them with the pointer over it',
        hoverFails.length + ' failing');

    // Put the panel back the way the later sections expect to find it.
    await page.mouse.move(2, 2);
    await page.click('#btn-options-close');
    await page.evaluate(() => {
        document.getElementById('notice').hidden = true;
        document.getElementById('capture-note').hidden = true;
        document.getElementById('appearance-note').hidden = true;
        document.getElementById('outline-note').hidden = true;
    });
    await wait(250);

    // ---------------------------------------------------------------------
    section('the verdict is near the top, and the colour tools are one block');
    /*
      The verdict used to begin 420px down a 660px panel — below the loupe, the
      swatches and the sliders — so anyone docking this narrower than full height
      never saw the number without scrolling. Worse, the three parts of one
      editing job (swatches, sliders, rungs) were split apart by the answer
      sitting in the middle of them.

      Measured, because "it looks higher now" is not a check.
    */
    const layout = await page.evaluate(() => {
        const at = (sel) => {
            const el = document.querySelector(sel);
            if (!el) return null;
            const r = el.getBoundingClientRect();
            return { top: Math.round(r.top + window.scrollY), height: Math.round(r.height) };
        };
        return {
            verdict: at('.verdict-row'),
            swatches: at('.swatch-row'),
            sliders: at('.sliders'),
            frame: at('#snapshot-frame'),
            idle: document.getElementById('snapshot-frame').classList.contains('idle'),
            total: Math.round(document.body.scrollHeight)
        };
    });

    ok(layout.verdict.top < 200,
        'the verdict starts in the top 200px, not 420 down',
        layout.verdict.top + 'px');
    ok(layout.verdict.top < layout.swatches.top,
        'and above the colour tools it describes',
        layout.verdict.top + ' vs ' + layout.swatches.top);
    /*
      Consolidated: swatches and sliders adjacent, with nothing wedged between.
      A gap larger than the swatch labels means something crept back in.
    */
    const gap = layout.sliders.top - (layout.swatches.top + layout.swatches.height);
    ok(gap >= 0 && gap < 30,
        'swatches and sliders are one block, nothing wedged between them',
        gap + 'px apart');

    ok(layout.idle === true, 'the preview pane is collapsed when nothing is being sampled');
    ok(layout.frame.height < 40,
        'to a thin strip rather than 124px of empty grey', layout.frame.height + 'px');
    ok(layout.total < 520,
        'and the whole panel fits a short dock without scrolling', layout.total + 'px');

    section('and the pane expands the moment the eyedropper is armed');
    /*
      It has to expand BEFORE the first frame lands: the canvas takes its backing
      store from the element, so drawing into a 26px strip and growing afterwards
      would render the first frame at a tenth of its height.
    */
    await page.click('#btn-camera');
    await wait(900);
    const armed = await page.evaluate(() => {
        const f = document.getElementById('snapshot-frame');
        const c = document.getElementById('snapshot');
        return { idle: f.classList.contains('idle'),
                 height: Math.round(f.getBoundingClientRect().height),
                 canvasH: c.height };
    });
    ok(armed.idle === false, 'the strip is gone once armed');
    ok(armed.height > 100, 'the pane is at full height', armed.height + 'px');
    ok(armed.canvasH > 100,
        'and the canvas was sized at full height, not at the strip',
        armed.canvasH + 'px');

    await page.keyboard.press('Escape');
    await wait(300);
    const disarmed = await page.evaluate(() =>
        document.getElementById('snapshot-frame').classList.contains('idle'));
    ok(disarmed === true, 'and it collapses again when the pick is cancelled');

    // ---------------------------------------------------------------------
    section('the panel can be driven from the keyboard');
    /*
      It is a WCAG tool. Its own keyboard story has to hold up, and until this
      section existed none of it did: the focus ring was drawn inside the colour
      swatch on top of the user's artwork (1.69:1 on a teal one, against a 3:1
      requirement), every other control had no focus style at all, the options
      popover let Tab walk out to the controls behind its own scrim, closing it
      dropped focus to BODY.
    */
    const reachable = await page.evaluate(() => {
        const wanted = ['#level-chip', '#btn-options', '#mode-chip', '#btn-pick-fg',
                        '#btn-pick-bg', '#btn-camera', '#swatch-fg',
                        '#swatch-bg'];
        const missing = [];
        for (const sel of wanted) {
            const node = document.querySelector(sel);
            if (!node) { missing.push(sel + ' (absent)'); continue; }
            // A native control is focusable without a tabindex; anything else
            // needs one, and a negative one keeps it out of the tab order.
            const native = /^(BUTTON|INPUT|SELECT|TEXTAREA|A)$/.test(node.tagName);
            if (!native && node.tabIndex < 0) missing.push(sel + ' (' + node.tagName + ')');
        }
        return { missing };
    });
    ok(reachable.missing.length === 0, 'every control is in the tab order',
        reachable.missing.join(', '));

    /*
      A focus ring that fails its own contrast check is the one thing this panel
      cannot ship. So measure the PIXELS, and reach the control the way a person
      does — `page.focus()` is programmatic focus and does not match
      `:focus-visible` at all, which is exactly how a missing indicator hides
      from a test that uses it.

      The ring is drawn OUTSIDE the element (outline-offset), so an element-sized
      screenshot would miss it entirely. Clip a padded box instead.
    */
    async function boxOf(sel) {
        const r = await page.$eval(sel, (node) => {
            const b = node.getBoundingClientRect();
            return { x: b.left, y: b.top, width: b.width, height: b.height };
        });
        const pad = 6;
        return {
            x: Math.max(0, r.x - pad), y: Math.max(0, r.y - pad),
            width: r.width + pad * 2, height: r.height + pad * 2
        };
    }

    async function tabTo(id, limit) {
        await page.evaluate(() => document.body.focus());
        for (let i = 0; i < (limit || 40); i++) {
            await page.keyboard.press('Tab');
            const at = await page.evaluate(() => document.activeElement && document.activeElement.id);
            if (at === id) return true;
        }
        return false;
    }

    const noRing = [];
    const notReached = [];
    for (const id of ['btn-camera', 'swatch-bg', 'btn-pick-fg', 'level-chip']) {
        const clip = await boxOf('#' + id);
        const before = (await page.screenshot({ clip })).toString('base64');
        if (!(await tabTo(id))) { notReached.push(id); continue; }
        await wait(60);
        const after = (await page.screenshot({ clip })).toString('base64');
        if (before === after) noRing.push(id);
    }
    ok(notReached.length === 0, 'every sampled control can be reached by pressing Tab',
        notReached.join(', '));
    ok(noRing.length === 0,
        'and reaching it visibly changes the pixels — there is a focus indicator',
        noRing.join(', '));

    /*
      Where the indicator is declared matters as much as that it exists. One
      universal rule means a control added next year gets it for free; the old
      per-element rule meant only the swatches had one, and theirs was drawn
      inside the swatch on top of the user's colour — 1.69:1 on a teal one.
    */
    const cssSrc = fs.readFileSync(path.join(CLIENT, 'css', 'panel.css'), 'utf8');
    const universal = cssSrc.match(/(^|\n)\s*:focus-visible\s*\{[^}]*\}/);
    ok(!!universal, 'the indicator is declared once for every control, not per element');
    ok(universal && /#ffffff|white/i.test(universal[0]),
        'drawn in white — 11.6:1 on the panel chrome, and independent of the artwork',
        universal && universal[0].replace(/\s+/g, ' '));
    ok(universal && /rgba\(\s*0,\s*0,\s*0/.test(universal[0]),
        'over a dark halo, so it survives landing on a light surface too');
    ok(!/\.swatch:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--accent-text\)/.test(cssSrc),
        'and the old accent ring drawn inside the swatch is gone');

    // The popover is modal in behaviour; Tab has to agree.
    await page.click('#btn-options');
    await wait(200);
    const trapped = await page.evaluate(async () => {
        const seen = [];
        for (let i = 0; i < 14; i++) {
            seen.push(document.activeElement ? document.activeElement.id ||
                      document.activeElement.tagName : 'none');
            document.dispatchEvent(new KeyboardEvent('keydown',
                { key: 'Tab', bubbles: true, cancelable: true }));
            await new Promise(r => setTimeout(r, 5));
        }
        return seen;
    });
    const escaped = trapped.filter(id =>
        ['btn-camera', 'mode-chip', 'btn-pick-fg', 'btn-pick-bg',
         'level-chip'].indexOf(id) >= 0);
    ok(escaped.length === 0,
        'Tab cannot walk out of the open popover to the controls behind its scrim',
        escaped.join(', '));

    const restored = await page.evaluate(async () => {
        document.getElementById('btn-options-close').click();
        await new Promise(r => setTimeout(r, 60));
        return document.activeElement ? document.activeElement.id ||
               document.activeElement.tagName : 'none';
    });
    ok(restored !== 'BODY' && restored !== 'none',
        'and closing it puts focus back on something, not on BODY', restored);

    // ---------------------------------------------------------------------
    section('the armed ring is actually painted');
    /*
      As an inset box-shadow on the frame it was drawn UNDERNEATH the canvas,
      which fills the frame exactly — so the one signal that the eyedropper is
      live rendered as nothing at all, and the DOM class said it was fine.
    */
    await page.click('#btn-camera');
    await wait(700);
    const ring = await page.evaluate(() => {
        const f = document.getElementById('snapshot-frame');
        const before = getComputedStyle(f, '::after');
        const r = f.getBoundingClientRect();
        return {
            tracking: f.className.indexOf('tracking') >= 0,
            content: before.content,
            shadow: before.boxShadow,
            width: before.width,
            frameW: Math.round(r.width)
        };
    });
    ok(ring.tracking, 'the loupe is armed');
    ok(ring.content && ring.content !== 'none',
        'the ring exists as its own layer above the canvas', ring.content);
    ok(/inset/.test(ring.shadow) && /rgb/.test(ring.shadow),
        'and carries the accent inset shadow', ring.shadow);

    /*
      And now the part the computed style cannot answer: was it PAINTED.

      The bug this replaced was an inset box-shadow on the frame itself, drawn
      beneath the canvas that fills the frame exactly. Every assertion above
      passed while the ring rendered as literally nothing. So take a real
      screenshot and read the pixels: accent blue two pixels in from the edge,
      the loupe image in the middle, and the two must differ.
    */
    const shot = (await page.locator('#snapshot-frame').screenshot()).toString('base64');
    const pixels = await page.evaluate(async (b64) => {
        const img = new Image();
        await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = 'data:image/png;base64,' + b64; });
        const c = document.createElement('canvas');
        c.width = img.width; c.height = img.height;
        const ctx = c.getContext('2d');
        ctx.drawImage(img, 0, 0);
        const at = (x, y) => { const d = ctx.getImageData(x, y, 1, 1).data; return [d[0], d[1], d[2]]; };
        const ratio = img.width / document.getElementById('snapshot-frame').getBoundingClientRect().width;
        // The ring is 2 CSS px. One device pixel in from the edge is inside it
        // at any scale, and clear of the anti-aliased outer boundary.
        const inset = Math.max(1, Math.round(ratio));
        return {
            edgeTop: at(Math.round(img.width / 2), inset),
            edgeLeft: at(inset, Math.round(img.height / 2)),
            middle: at(Math.round(img.width / 2), Math.round(img.height / 2)),
            size: [img.width, img.height]
        };
    }, shot);

    // --accent is #1473e6. Anti-aliasing and the rounded corner move it a little,
    // so test the shape of the colour rather than an exact triple.
    const isAccent = (p) => p[2] > 150 && p[2] > p[0] + 60 && p[1] > p[0];
    ok(isAccent(pixels.edgeTop),
        'the top edge really is painted accent blue', pixels.edgeTop.join(','));
    ok(isAccent(pixels.edgeLeft),
        'and so is the left edge', pixels.edgeLeft.join(','));
    ok(!isAccent(pixels.middle),
        'while the middle of the frame is still the loupe image, not the ring',
        pixels.middle.join(','));

    await page.keyboard.press('Escape');
    await wait(250);

    // Disarmed, the ring must be gone from the pixels too — not merely from the
    // class list. A ring that never clears reads as "still sampling" forever.
    const off = (await page.locator('#snapshot-frame').screenshot()).toString('base64');
    const offEdge = await page.evaluate(async (b64) => {
        const img = new Image();
        await new Promise((res) => { img.onload = res; img.src = 'data:image/png;base64,' + b64; });
        const c = document.createElement('canvas');
        c.width = img.width; c.height = img.height;
        c.getContext('2d').drawImage(img, 0, 0);
        const d = c.getContext('2d').getImageData(Math.round(img.width / 2), 1, 1, 1).data;
        return [d[0], d[1], d[2]];
    }, off);
    ok(!isAccent(offEdge), 'and it is gone from the pixels once disarmed', offEdge.join(','));

    // ---------------------------------------------------------------------
    section('nothing wraps to an extra line at panel width');
    /*
      Measured, not eyeballed. "12pt body text · needs 4.5" spilled onto a second
      line and collided with the matrix; the loupe readout wrapped mid-tracking,
      which made the whole panel jitter twenty-five times a second.
    */
    /*
      Every one of these has to be carrying text when it is measured.

      The previous version skipped anything empty, and two of the three were
      empty at that point in the run, so it reported passes for elements it had
      not looked at. #pick-hint in particular is only populated while the
      loupe is tracking, which is exactly the state in which its wrapping made
      the whole panel jitter twenty-five times a second.
    */
    await page.click('#btn-camera');
    await wait(900);

    const lines = await page.evaluate(() => {
        const out = [];
        for (const id of ['ratio-note', 'pick-hint']) {
            const el = document.getElementById(id);
            const text = el ? el.textContent.trim() : '';
            if (!text) { out.push({ id, lines: -1, text: '' }); continue; }

            /*
              Distinct line TOPS, not rect count.

              getClientRects() on an element returns one rect per inline box, so
              #pick-hint — which holds a hex swatch span next to its text — always
              reported two or three rects while sitting happily on one line. Group
              the rects by their top edge and count the groups.
            */
            const range = document.createRange();
            range.selectNodeContents(el);
            const tops = new Set();
            for (const r of range.getClientRects()) {
                if (r.width === 0 && r.height === 0) continue;
                tops.add(Math.round(r.top));
            }
            out.push({ id, lines: tops.size, text });
        }
        return out;
    });
    lines.forEach(l => {
        ok(l.lines >= 0, '#' + l.id + ' actually has text to measure', 'it was empty');
        if (l.lines >= 0) {
            ok(l.lines <= 1, '#' + l.id + ' fits on one line at 240px',
                l.lines + ' lines: "' + l.text + '"');
        }
    });
    await page.keyboard.press('Escape');
    await wait(150);

    // ---------------------------------------------------------------------
    section('layout holds at the panel\'s minimum size');
    await page.setViewportSize({ width: 220, height: 420 });
    await wait(200);
    const overflow = await page.evaluate(() => ({
        scrollW: document.documentElement.scrollWidth,
        clientW: document.documentElement.clientWidth
    }));
    ok(overflow.scrollW <= overflow.clientW + 1,
        'nothing overflows horizontally at 220px',
        overflow.scrollW + ' > ' + overflow.clientW);

    await browser.close();

    console.log('\n' + pass + ' passed, ' + fail + ' failed');
    if (fail) {
        console.log('\nFailures:');
        failures.forEach(f => console.log('  - ' + f));
        process.exitCode = 1;
    }
}());
