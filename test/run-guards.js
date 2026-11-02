/*
  Host-layer safety tests.

  Two things this locks down:

  1. Crash guards. Illustrator crashed on the first build because a non-finite
     number reached a native call — NaN loses every comparison silently, so
     `if (rectW <= 0)` did NOT catch it and a NaN resolution went into
     ImageCaptureOptions.

  2. Apply scope. Outlined text is a group of compound paths, one per letter,
     and each compound path is several subpaths. Writing to a single subpath
     recoloured one letter.

  Run:  node test/run-guards.js
*/

const fs = require('fs');
const path = require('path');

const HOST = fs.readFileSync(path.join(__dirname, '..', 'host', 'index.jsx'), 'utf8');

let pass = 0, fail = 0;
const failures = [];

function ok(cond, label, extra) {
    if (cond) { pass++; console.log('PASS  ' + label); }
    else { fail++; failures.push(label); console.log('FAIL  ' + label + (extra ? '  -> ' + extra : '')); }
}
function section(t) { console.log('\n=== ' + t + ' ==='); }

// Lift named functions out of the host file so they can run under Node.
function lift(names) {
    let src = '';
    for (const name of names) {
        const re = new RegExp('^function ' + name + '\\([\\s\\S]*?\\n\\}', 'm');
        const m = HOST.match(re);
        if (!m) throw new Error('could not lift ' + name);
        src += m[0] + '\n';
    }
    src += 'module.exports = {' + names.join(',') + '};';
    const mod = { exports: {} };
    new Function('module', 'exports', src)(mod, mod.exports);
    return mod.exports;
}

const H = lift(['isNum', 'isFiniteBounds', 'clamp255', 'areaOf', 'mixToward', 'sameColour', 'trimToken']);

// blendOf reads item.blendingMode, so it can be driven with a stub object.
const BLEND = (function () {
    const table = HOST.match(/var BLEND_TOKENS = \{[\s\S]*?\n\};/);
    const fn = HOST.match(/^function blendOf\(item\)[\s\S]*?\n\}/m);
    if (!table || !fn) throw new Error('could not lift blendOf');
    const mod = { exports: {} };
    new Function('module', 'exports',
        table[0] + '\n' + fn[0] + '\nmodule.exports = blendOf;')(mod, mod.exports);
    return mod.exports;
}());

section('the trap that took Illustrator down');
ok((NaN <= 0) === false, 'JS: (NaN <= 0) is false, so a bare range check misses NaN');
ok((NaN > 300) === false, 'JS: (NaN > 300) is false, so clamping misses it too');
ok(H.isNum(NaN) === false, 'isNum rejects NaN');
ok(H.isNum(Infinity) === false, 'isNum rejects Infinity');
ok(H.isNum(-Infinity) === false, 'isNum rejects -Infinity');
ok(H.isNum(undefined) === false, 'isNum rejects undefined');
ok(H.isNum(null) === false, 'isNum rejects null');
ok(H.isNum('12') === false, 'isNum rejects numeric strings');
ok(H.isNum(0) === true, 'isNum accepts zero');
ok(H.isNum(-2637.09) === true, 'isNum accepts real coordinates');

section('bounds validation');
ok(H.isFiniteBounds([0, -1845, 612, -2637]) === true, 'accepts a real artboard rect');
ok(H.isFiniteBounds([0, NaN, 612, -2637]) === false, 'rejects NaN in any slot');
ok(H.isFiniteBounds([0, -1845, Infinity, -2637]) === false, 'rejects Infinity');
ok(H.isFiniteBounds(null) === false, 'rejects null');
ok(H.isFiniteBounds([]) === false, 'rejects an empty array');
ok(H.isFiniteBounds([1, 2, 3]) === false, 'rejects a short array');

section('numbers never come out dirty');
ok(H.areaOf([0, 100, 100, 0]) === 10000, 'area of a 100x100 box');
ok(H.areaOf([0, NaN, 100, 0]) === 0, 'NaN bounds give zero area, not NaN');
ok(H.areaOf(null) === 0, 'null bounds give zero area');
ok(H.clamp255(NaN) === 0, 'clamp255(NaN) is 0');
ok(H.clamp255(Infinity) === 0, 'clamp255(Infinity) is 0');
ok(H.clamp255(-40) === 0, 'clamps below zero');
ok(H.clamp255(900) === 255, 'clamps above 255');
let mixClean = true;
for (const v of H.mixToward([NaN, 140, 130], [255, 255, 255], 0.5)) {
    if (!Number.isFinite(v)) mixClean = false;
}
ok(mixClean, 'mixToward never emits NaN even from NaN input');

section('colour matching for apply-all');
ok(H.sameColour([0, 0, 0], [0, 0, 0]) === true, 'identical black matches');
ok(H.sameColour([14, 140, 130], [15, 141, 131]) === true, '1/255 drift matches (CMYK conversion rounding)');
ok(H.sameColour([14, 140, 130], [20, 140, 130]) === false, '6/255 apart does not match');
ok(H.sameColour([0, 0, 0], [255, 255, 255]) === false, 'black and white do not match');
ok(H.sameColour(null, [0, 0, 0]) === false, 'null is safe');
ok(H.sameColour([0, 0, 0], null) === false, 'null is safe both ways');
ok(H.sameColour([0, 0, 0], [2, 2, 2], 2) === true, 'explicit tolerance honoured');
ok(H.sameColour([0, 0, 0], [3, 3, 3], 2) === false, 'explicit tolerance is a real bound');

section('apply scope: outlined text');
ok(/function applyFillToItem\(item, colour\)/.test(HOST), 'applyFillToItem exists');
ok(/subs\[i\]\.fillColor = colour/.test(HOST), 'every subpath of a compound path is coloured');
ok(/own\[j\]\.fillColor = colour/.test(HOST), 'a whole compound path is handled too');
ok(/function wcagApply\(tokenList, hex\)/.test(HOST), 'apply takes a list of tokens');
ok(/objects: objects/.test(HOST), 'apply reports how many objects changed');
ok(/subpaths: subpaths/.test(HOST), 'apply reports how many subpaths changed');
ok(/tokens: fgGroup/.test(HOST), 'selection payload carries a token group');
ok(/var fgToken = registerItem\(fgItem\);/.test(HOST),
    'and the foreground is registered exactly once');

section('refusal: things that must never be recoloured');
ok(/function refuseReason\(item\)/.test(HOST), 'refuseReason exists');
for (const [label, needle] of [
    ['gradients', "'a gradient fill'"],
    ['patterns', "'a pattern fill'"],
    ['placed images', "'a placed or linked image'"],
    ['raster images', "'a raster image'"],
    ['symbols', "'a symbol instance'"],
    ['gradient meshes', "'a gradient mesh'"],
    ['clipping paths', "'a clipping path'"]
]) {
    ok(HOST.indexOf(needle) >= 0, 'refuses ' + label);
}
ok(/if \(refuseReason\(candidate\)\) continue;/.test(HOST), 'refused items are excluded from the apply group');

section('blend modes: the names Illustrator actually emits');
/*
  Verified against the Illustrator Scripting Reference constants list. Two
  members carry a "BLEND" suffix the W3C names do not — COLORBLEND was handled,
  SATURATIONBLEND was not, so anything set to Saturation quietly fell through to
  Normal and was measured as if it had no blend mode at all.
*/
const ILLUSTRATOR_BLEND_MEMBERS = [
    'NORMAL', 'MULTIPLY', 'SCREEN', 'OVERLAY', 'SOFTLIGHT', 'HARDLIGHT',
    'COLORDODGE', 'COLORBURN', 'DARKEN', 'LIGHTEN', 'DIFFERENCE', 'EXCLUSION',
    'HUE', 'SATURATIONBLEND', 'COLORBLEND', 'LUMINOSITY'
];
const stub = (member) => ({ blendingMode: 'BlendModes.' + member });

ok(BLEND(stub('SATURATIONBLEND')) === 'saturation',
    'SATURATIONBLEND maps to saturation (was silently becoming normal)',
    BLEND(stub('SATURATIONBLEND')));
ok(BLEND(stub('COLORBLEND')) === 'colorblend', 'COLORBLEND maps to colorblend');
ok(BLEND(stub('MULTIPLY')) === 'multiply', 'MULTIPLY maps through');
ok(BLEND(stub('SOFTLIGHT')) === 'softlight', 'SOFTLIGHT maps through');
ok(BLEND(stub('NORMAL')) === 'normal', 'NORMAL maps through');

// Every member the reference lists must resolve to a mode color.js implements.
const COLOR = require('../client/js/color.js');
let unmapped = [];
for (const member of ILLUSTRATOR_BLEND_MEMBERS) {
    const token = BLEND(stub(member));
    if (member !== 'NORMAL' && token === 'normal') unmapped.push(member);
}
ok(unmapped.length === 0, 'no documented blend mode silently degrades to normal',
    unmapped.join(', '));

let blendRuns = true;
for (const member of ILLUSTRATOR_BLEND_MEMBERS) {
    const out = COLOR.blend(BLEND(stub(member)), [128, 64, 200], [30, 200, 90]);
    for (const v of out) if (!Number.isFinite(v) || v < 0 || v > 255) blendRuns = false;
}
ok(blendRuns, 'and color.js implements every one of them');

ok(BLEND({ blendingMode: 'BlendModes.SOMETHINGNEW' }) === 'normal',
    'an unknown name falls back to normal rather than throwing');
ok(BLEND({}) === 'normal', 'a missing property falls back to normal');
ok(BLEND({ get blendingMode() { throw new Error('boom'); } }) === 'normal',
    'a throwing property falls back to normal');

section('grayscale: the spelling and the polarity');
/*
  ImageColorSpace.Grayscale, lowercase s. Indexing with 'GrayScale' returned
  undefined, convertSampleColor threw on it, the catch swallowed the failure,
  and every Gray swatch in the document read as "no colour" — so ordinary black
  text became unmeasurable.
*/
ok(/GRAYSCALE: \['Grayscale', 'GrayScale'/.test(HOST),
    'every known spelling of the enum member is tried');
ok(!/convertSample\('GrayScale'/.test(HOST), 'nothing asks for a single hard-coded spelling');
/*
  Illustrator 30.7 accepts none of them, and indexing the enum with a name it
  does not know THROWS rather than returning undefined — so the lookup has to be
  guarded per spelling, not just null-checked at the end.
*/
const spaceFn = (HOST.match(/^function imageSpace\(name\)[\s\S]*?\n\}/m) || [''])[0];
ok(/for \(var i = 0[\s\S]*try \{/.test(spaceFn),
    'each spelling is tried inside its own try, because a miss throws');
ok(/WCAG_SPACES/.test(spaceFn), 'and the answer is cached, since misses are expensive');

ok(/function grayProfile\(\)/.test(HOST), 'the range and polarity are probed, not assumed');
ok(/zeroIsBlack/.test(HOST), 'including which end of the scale is black');
/*
  K-only CMYK was the original fallback and it is wrong: it simulates printed
  ink, so 100% grey came back (35, 31, 32) — a 15.8:1 reading for text that
  renders at 21:1. A neutral ramp cannot invert and hits true black and white.
*/
const grayFn = (HOST.match(/^function grayToRgb\(gray\)[\s\S]*?\n\}/m) || [''])[0];
ok(!/convertSample\('CMYK'/.test(grayFn),
    'grey does NOT fall back to K-only CMYK, which under-reports black');
ok(/255 \* \(1 - gray \/ 100\)/.test(grayFn), 'it falls back to a neutral ramp');
ok(/clamp255/.test(grayFn), 'clamped, so no channel can leave range');

section('inherited appearance: opacity and blend from containers');
/*
  Black text inside a group at 50% renders as mid-grey. Reading only the item's
  own opacity and blend mode missed every container above it — and a group set
  to Multiply rendered nothing like what the panel measured.
*/
ok(/function appearanceChain\(item\)/.test(HOST), 'the chain of containers is collected');
ok(/function effectiveBlend\(item\)/.test(HOST), 'blend modes are inherited too');
ok(/kind === 'Layer' \? 'layer'/.test(HOST), 'layers and groups are told apart, and named');
ok(/if \(kind === 'Document'\) break;/.test(HOST),
    'the document is excluded before anything is read off it');
ok(/opacity < 99\.5 \|\| blend !== 'normal'/.test(HOST),
    'neutral containers are omitted, so an empty chain means nothing is changing it');

const alphaFn = (HOST.match(/^function effectiveAlpha\(item\)[\s\S]*?\n\}/m) || [''])[0];
ok(/appearanceChain\(item\)/.test(alphaFn),
    'effectiveAlpha derives from the same chain, so the two cannot disagree');

/*
  The chain maths, actually executed.

  This section used to be regex assertions against call sites — it checked that
  the string "blend: effectiveBlend(fgItem)" appeared in the host, which says
  nothing about whether the arithmetic is right and breaks the moment a variable
  is renamed. These are pure functions over plain arrays, so run them.
*/
const A = lift(['alphaOfChain', 'blendOfChain', 'sharedTail', 'unsharedAlpha',
                'unsharedBlend', 'sameContainer', 'sharedAppearance']);

const link = (uid, up, exact, blend) => ({
    uid: uid, up: up, exact: exact, opacity: Math.round(exact),
    blend: blend || 'normal', kind: 'group', name: uid, own: false
});
const near = (a, b) => Math.abs(a - b) < 1e-9;

ok(A.alphaOfChain([]) === 1, 'an empty chain is fully opaque');
ok(near(A.alphaOfChain([link('g', 1, 50)]), 0.5), 'one container at 50% gives 0.5');
ok(near(A.alphaOfChain([link('g', 2, 50), link('L', 1, 50)]), 0.25),
    'nested containers multiply');
/*
  The rounded opacity is for display only. 33.33 shown as 33 moves a 4.51 ratio
  to 4.49 — across the AA line, in the wrong direction, silently.
*/
ok(!near(A.alphaOfChain([link('g', 1, 33.33)]), 0.33),
    'the exact opacity is used, not the rounded one shown in the UI');

ok(A.blendOfChain([]) === 'normal', 'no containers means no blend');
ok(A.blendOfChain([link('g', 2, 100), link('L', 1, 100, 'multiply')]) === 'multiply',
    'a blend set on an outer container is inherited');
ok(A.blendOfChain([link('g', 2, 100, 'screen'), link('L', 1, 100, 'multiply')]) === 'screen',
    'the innermost non-normal mode wins, since this flat model cannot nest them');

/*
  The double-count bug, as a number.

  Text and its background both inside one group at 65%: Illustrator composites
  the group's buffer once. Applying 65% to the background and again to the text
  drawn over it turned a 2.71:1 hard failure into a 4.53:1 pass.
*/
const shared = link('grp-1', 1, 65);
ok(near(A.unsharedAlpha([shared], [shared]), 1),
    'an opacity shared by both sides is not counted on the foreground');
ok(near(A.unsharedAlpha([link('txt', 2, 50), shared], [shared]), 0.5),
    'the item\'s own opacity still counts; only the shared part is cancelled');
ok(near(A.unsharedAlpha([shared], []), 0.65),
    'nothing is cancelled when the background has no containers');
ok(near(A.unsharedAlpha([link('a', 1, 65)], [link('b', 1, 65)]), 0.65),
    'two different groups that happen to share an opacity are NOT treated as one');
ok(near(A.unsharedAlpha([link('L', 1, 50)], [link('L', 1, 50), link('x', 0, 20)]), 0.5),
    'the shared part is matched from the outside in, not by position from the item');

ok(A.sameContainer(link('g', 1, 65), link('g', 1, 65)) === true,
    'same id at the same depth is the same container');
ok(A.sameContainer(link('g', 1, 65), link('g', 2, 65)) === false,
    'the same id at a different depth is not');
ok(A.sameContainer(null, link('g', 1, 65)) === false, 'a missing link matches nothing');

/*
  Cancelling the shared opacity from the foreground is only half of it. The group
  still fades the text — at the same time as everything else in the group, and
  over whatever is behind the group rather than over the background. So the
  shared part has to travel to the panel as a layer of its own.
*/
const shape = A.sharedAppearance([link('txt', 2, 50), shared], [shared]);
ok(near(shape.alpha, 0.65), 'the shared containers are reported as one alpha', String(shape.alpha));
ok(shape.name === 'grp-1', 'named, so the panel can say which group it is', shape.name);
ok(A.sharedAppearance([link('a', 1, 50)], [link('b', 1, 50)]).alpha === 1,
    'nothing shared means a transparent layer that changes nothing');
ok(A.sharedAppearance([], []).blend === 'normal', 'and no blend either');
/*
  The three answers this arithmetic has to choose between, for black text on
  #808080 inside a group at 65% over white paper. Only the first is what
  Illustrator draws; the other two are the bugs, and both of them PASS.
*/
const inner = A.unsharedAlpha([shared], [shared]);
ok(near(inner, 1) && near(shape.alpha * 1, 0.65),
    'the pair splits into "nothing of its own" plus "65% shared"');

/*
  The blend has to be de-shared too, and for the same reason.

  Cancelling only the alpha was worse than cancelling neither: a group set to
  Multiply put "multiply" on the foreground AND on the shared layer, so the panel
  applied it twice. #555555 on #A0A0A0 inside a Multiply group renders exactly as
  authored — 2.85:1, a failure — and the panel reported 4.69 with a green tick.
*/
const mulShared = link('grp-1', 1, 100, 'multiply');
ok(A.unsharedBlend([mulShared], [mulShared]) === 'normal',
    'a blend that lives in the shared container is not charged to the item too');
ok(A.unsharedBlend([link('own', 2, 100, 'screen'), mulShared], [mulShared]) === 'screen',
    'while the item\'s own blend still is');
ok(A.sharedAppearance([mulShared], [mulShared]).blend === 'multiply',
    'and the shared layer is the one that carries it');
ok(A.unsharedBlend([link('a', 1, 100, 'multiply')], []) === 'multiply',
    'nothing shared means nothing cancelled');

section('a placed image is paint, not a hole');
/*
  A raster has no fillColor, so reading one threw and the catch reported "no
  fill" — indistinguishable from a transparent object. The backdrop search then
  stepped through the photo onto the white card behind it, and white text over
  that photo measured 12.63:1 against the card. README has always claimed images
  are refused.
*/
const fillFn = (HOST.match(/^function fillOf\(item\)[\s\S]*?\n\}/m) || [''])[0];
ok(/RasterItem|PlacedItem/.test(fillFn),
    'rasters and placed images are recognised by typename');
ok(/kind: 'image'/.test(fillFn), 'and reported as \'image\', not \'none\'');
ok(fillFn.indexOf("kind === 'RasterItem'") < fillFn.indexOf('item.filled === false'),
    'before the fill test, which is what used to throw on them');
// 'none' is what makes the search step past a candidate; 'image' must not.
ok(/return candidate\.kind !== 'none';/.test(HOST),
    'and only \'none\' lets the backdrop search see through something');

section('inherited appearance reaches the payload');

// The chain, the derived alpha and the blend all have to reach the panel.
ok(/appearance: fgChain/.test(HOST), 'the foreground chain is reported to the panel');
ok(/appearance: bgChain/.test(HOST), 'and the background chain');
ok((HOST.match(/alphaOverBackground: unsharedAlpha\(/g) || []).length === 2,
    'both sides of the payload ship the un-shared alpha');
ok((HOST.match(/shared: sharedAppearance\(/g) || []).length === 1,
    'and the payload ships the shared layer');
ok((HOST.match(/blendOverBackground: unsharedBlend\(/g) || []).length === 2,
    'and both sides of the payload ship the un-shared blend');
ok(!/alpha: effectiveAlpha\(fgItem\)/.test(HOST),
    'no payload builds an alpha by walking the tree a second time');

section('holding the selection across a pick click');
/*
  The pick click reaches Illustrator and there is no way to stop it. Restoring
  the selection afterwards is what makes it harmless.
*/
ok(/function wcagHoldSelection\(\)/.test(HOST), 'the selection can be remembered');
ok(/function wcagReleaseSelection\(\)/.test(HOST), 'and put back');
ok(/WCAG_HELD_RANGE/.test(HOST),
    'a text cursor is noted rather than guessed at, since it cannot be re-applied');
ok(/var probe = held\[i\]\.typename;/.test(HOST),
    'items deleted in the meantime are skipped rather than throwing');
/*
  The pair is driven by a click the panel only infers, so it can get out of
  step. A stale hold left in $.global made the next release re-select items the
  user had deselected by hand — the panel fighting them for the selection.
*/
const releaseFn = (HOST.match(/^function wcagReleaseSelection\(\)[\s\S]*?\n\}/m) || [''])[0];
ok(/\$\.global\.WCAG_HELD = null;/.test(releaseFn),
    'the hold is forgotten on release, so it cannot be applied twice');
ok(releaseFn.indexOf('$.global.WCAG_HELD = null') < releaseFn.indexOf('doc.selection = null'),
    'and forgotten BEFORE anything that can fail, not after it');
ok(/WCAG_HELD_DOC/.test(HOST),
    'the document is recorded too: a screen-wide click can land in another window');
ok(/heldDoc !== docKey\(doc\)/.test(releaseFn),
    'and a different document in front means the selection is left alone');

section('inherited visibility');
ok(/function isEffectivelyHidden\(item\)/.test(HOST), 'visibility is resolved up the tree');
ok(/if \(isEffectivelyHidden\(it\)\) continue;/.test(HOST),
    'backdrop candidates skip artwork nobody can see');
ok(/it\.clipping === true/.test(HOST) && /skip\) continue;/.test(HOST),
    'clipping masks are not treated as painted backdrops');

section('apply writes each object once');
ok(/if \(seen\[token\]\) continue;/.test(HOST), 'duplicate tokens are ignored');
ok(H.trimToken('  s7 ') === 's7', 'tokens are trimmed before lookup');
ok(/lookupItem\(token, doc\)/.test(HOST) && /var token = trimToken\(tokens\[i\]\)/.test(HOST),
    'apply trims each token before looking it up');

section('rendered text size');
ok(/function scaleFactorOf\(item\)/.test(HOST), 'the transform matrix is read');
ok(/function authoredPointSize\(item\)/.test(HOST), 'the authored size stays available');
ok(/mValueA \* m\.mValueD/.test(HOST), 'scale comes from the matrix determinant');

section('the signature notices more than movement');
ok(/function colourStamp\(item, depth\)/.test(HOST), 'a cheap colour fingerprint exists');
ok(/kind === 'GroupItem'/.test(HOST) && /kind === 'CompoundPathItem'/.test(HOST),
    'and it descends into groups and compound paths, which hold no fill of their own');
ok(!/convertSample/.test((HOST.match(/function colourStamp[\s\S]*?\n\}/) || [''])[0]),
    'and it does no colour conversion, so the poll stays cheap');
ok(/colourStamp\((sel\[i\]|it)\)/.test(HOST), 'the signature includes it');
ok(/String\(doc\.name\)/.test(HOST), 'and the document identity');


section('standing guards');
ok(/function readColour\(colour, depth\)/.test(HOST), 'readColour is depth-limited');
ok(/if \(depth > 6\) return none;/.test(HOST), 'spot-colour recursion capped');
ok(/function flatten\(collection, out, depth(, shape)?\)/.test(HOST), 'flatten is depth-limited');
ok(/if \(depth > 24\) return out;/.test(HOST), 'group recursion capped');
// Strip comments first: the file explains why the call was removed, and that
// explanation must not count as a call.
const HOST_CODE = HOST.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
ok(HOST_CODE.indexOf('app.redraw(') === -1, 'app.redraw is not called anywhere (comments excluded)');
ok(/function guarded\(name, fn\)/.test(HOST), 'guard wrapper exists');

for (const name of ['wcagPing', 'wcagSelectionSignature', 'wcagDocInfo', 'wcagSelection',
    'wcagApply', 'wcagDropHandles',
    'wcagHoldSelection', 'wcagReleaseSelection']) {
    const re = new RegExp('function ' + name + '\\([^)]*\\) \\{\\s*\\n\\s*return guarded\\(');
    ok(re.test(HOST), name + ' is wrapped in guarded()');
}


/* ==========================================================================
   CRASH SAFETY

   Illustrator 30.7 died with EXC_BAD_ACCESS reading `.opacity` off a page item
   wrapper whose art had been freed, inside a try block, dispatched into the
   middle of a mouse click. Everything below exists so that particular shape of
   mistake cannot be reintroduced without a red test.
   ========================================================================== */
section('outlined type is flagged by its shape, not guessed at');
const selFn = (HOST.match(/function wcagSelection\(\)[\s\S]*?\n\}\n/m) || [''])[0];
ok(/outlineLike: !isTextItem\(fgItem\) && shape\.grouped &&\s*shape\.compound > 0 && fgGroup\.length >= 3/.test(selFn),
    'only a grouped set of three or more same-coloured shapes with compound paths qualifies');
ok(/if \(shape\) shape\.compound\+\+;/.test(HOST) && /if \(shape\) shape\.grouped = true;/.test(HOST),
    'and the flattening records the shape it would otherwise throw away');

section('stored handles are scoped to their document');

ok(/function dropRegistry\(\)/.test(HOST),
    'a registry can be dropped without reading anything in it');
ok(/function registryLive\(doc\)/.test(HOST),
    'and asked whether its tokens still address the document in front');
ok(/WCAG_REG_SEL_DOC/.test(HOST),
    'the registry records the document it belongs to, not just the items');
ok(!/WCAG_REG_SCAN/.test(HOST),
    'and there is only one: every extra set of stored handles is another way to outlive the art');

const lookupFn = (HOST.match(/function lookupItem\(token, doc\)[\s\S]*?\n\}/m) || [''])[0];
ok(lookupFn !== '', 'lookupItem takes the document it is being asked about');
ok(/registryLive\(doc\)/.test(lookupFn),
    'and refuses before it touches the item, not after');
/*
  Both positions must exist. A missing string has index -1, which is "less
  than" everything, so the old form of this check passed with the document
  check deleted entirely: exactly the regression it exists to catch.
*/
const checkAt = lookupFn.indexOf('registryLive(doc)');
const probeAt = lookupFn.indexOf('item.typename');
ok(checkAt >= 0 && probeAt >= 0 && checkAt < probeAt,
    'the document check comes BEFORE the probe, because the probe is the thing that crashes');

section('the poll never dereferences a stored handle');

ok(!/function appendWatched/.test(HOST),
    'appendWatched is gone: it read stored wrappers from a timer and crashed the host');
ok(!/appendWatched\(/.test(HOST_CODE),
    'and nothing calls it');
ok(/function wcagSelectionSignature\(\)/.test(HOST),
    'the signature takes no token list, so there is nothing stale to stamp');

const sigFn = (HOST.match(/function wcagSelectionSignature\(\)[\s\S]*?\n\}\n/m) || [''])[0];
ok(sigFn !== '', 'the signature function was found');
ok(!/lookupItem/.test(sigFn),
    'the poll performs no registry lookups at all');
ok(/if \(!registryLive\(doc\)\) dropRegistry\(\);/.test(sigFn),
    'and drops the registry when the document in front changes');

section('the document sweep is bounded and cheap');

ok(/var SWEEP_LIMIT = \d+;/.test(HOST),
    'the candidate sweep has a ceiling, which it did not before');
const boundsFn = (HOST.match(/function boundsOf\(item\)[\s\S]*?\n\}/m) || [''])[0];
ok(/geometricBounds/.test(boundsFn),
    'bounds come from geometry, not from resolving every live effect in the file');
ok(boundsFn.indexOf('geometricBounds') < boundsFn.indexOf('visibleBounds'),
    'with visibleBounds kept only as the fallback');

const sweepFn = (HOST.match(/function candidateShapes\(doc\)[\s\S]*?\n\}\n/m) || [''])[0];
ok(/if \(n > SWEEP_LIMIT\) n = SWEEP_LIMIT;/.test(sweepFn),
    'the sweep caps ITERATIONS, so the work is bounded and not just the output');
ok(/n = items\.length;/.test(sweepFn) && /i < n;/.test(sweepFn),
    'and reads the live collection length once instead of on every pass');

/*
  The summary goes LAST, after every section.

  It used to sit above the crash-safety section, which was appended after it.
  Those assertions ran and printed, but the total and the exit code had already
  been decided, so a broken crash fix could fail every one of them and the suite
  would still report success. The checks that matter most were the only ones
  that could not fail the build.
*/
console.log('\n' + pass + ' passed, ' + fail + ' failed');
if (fail) {
    console.log('\nFailures:');
    failures.forEach(f => console.log('  - ' + f));
    process.exitCode = 1;
}
