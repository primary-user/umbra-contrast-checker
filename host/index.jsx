/*
  Umbra Contrast Checker — Illustrator host layer
  Copyright (c) 2026 Artchemy Labs LLC. All rights reserved.
  Use of this file is governed by the licence in LICENSE at the root of this
  project. Not for redistribution.
  Runs inside Illustrator's scripting engine, called from the panel via evalScript.

  DESIGN RULE: this file reports FACTS about the document and performs writes.
  It does no colour science. Every ratio, blend, and suggestion is computed in
  the panel (client/js/color.js). Keeping that line clean is what makes a future
  UXP port a bridge swap rather than a rewrite.

  Every exported function returns a JSON string. ExtendScript has no JSON object,
  so there is a small serialiser at the top.

  Written against Adobe's Illustrator Scripting Reference, with the places that
  reference turned out to be wrong marked where they bite.
*/

//@target illustrator

// ---------------------------------------------------------------------------
// JSON output (ExtendScript has no JSON global)
// ---------------------------------------------------------------------------

function jsonEscape(s) {
    var out = '';
    s = String(s);
    for (var i = 0; i < s.length; i++) {
        var ch = s.charAt(i);
        var code = s.charCodeAt(i);
        if (ch === '"') { out += '\\"'; }
        else if (ch === '\\') { out += '\\\\'; }
        else if (ch === '\n') { out += '\\n'; }
        else if (ch === '\r') { out += '\\r'; }
        else if (ch === '\t') { out += '\\t'; }
        else if (code < 32 || code > 126) {
            var hex = code.toString(16);
            while (hex.length < 4) { hex = '0' + hex; }
            out += '\\u' + hex;
        }
        else { out += ch; }
    }
    return out;
}

function toJson(v) {
    if (v === null || v === undefined) return 'null';

    var t = typeof v;
    if (t === 'number') return isFinite(v) ? String(v) : 'null';
    if (t === 'boolean') return v ? 'true' : 'false';
    if (t === 'string') return '"' + jsonEscape(v) + '"';

    if (v instanceof Array) {
        var parts = [];
        for (var i = 0; i < v.length; i++) parts.push(toJson(v[i]));
        return '[' + parts.join(',') + ']';
    }

    var pairs = [];
    for (var k in v) {
        if (!v.hasOwnProperty(k)) continue;
        var val = v[k];
        if (typeof val === 'function') continue;
        pairs.push('"' + jsonEscape(k) + '":' + toJson(val));
    }
    return '{' + pairs.join(',') + '}';
}

// ---------------------------------------------------------------------------
// Document handle
// ---------------------------------------------------------------------------

function activeDoc() {
    try {
        if (app.documents.length === 0) return null;
        return app.activeDocument;
    } catch (e) {
        try { return app.documents[0]; } catch (e2) { return null; }
    }
}

// ---------------------------------------------------------------------------
// Item registry — gives the panel stable handles across evalScript calls.
// The scripting engine persists between calls, so $.global survives.
// ---------------------------------------------------------------------------

/*
  One registry.

  There used to be two, so that the tokens behind the scan list would survive
  the selection being re-read underneath them on every poll. The scan is gone,
  and with it the only reason to keep a second set of handles alive between
  calls. Fewer stored handles is strictly better here: every one of them is a
  thing that can outlive the art it points at.
*/
var REG_KEY = 'WCAG_REG_SEL';
var REG_DOC_KEY = 'WCAG_REG_SEL_DOC';

function registry() {
    if (!$.global[REG_KEY]) $.global[REG_KEY] = {};
    return $.global[REG_KEY];
}

/*
  THE ONE RULE IN THIS FILE THAT IS NOT NEGOTIABLE.

  A token is an address into a document's art database. Illustrator tears that
  database down when the document closes, and rolls deleted art out of it when
  the undo history moves on, and in neither case does it tell the wrappers still
  pointing at it. Reading a property off one afterwards is a native access
  violation. It crashed Illustrator 30.7 in appendWatched, reading `.opacity`
  inside a try block, which is the point: ExtendScript try/catch is a JavaScript
  construct and cannot catch a segmentation fault. There is no probe that makes
  a dead handle safe, because the probe is the thing that crashes.

  So the handle is never asked. The document it belongs to is recorded beside
  it as a plain string when it is registered, and every lookup compares strings
  first. String comparison cannot fault. If the answer is no, the whole registry
  is replaced with a fresh object, which drops every reference without reading
  one, and the caller is told the token is gone.

  Dropping a reference is always safe. Reading one is only safe inside the call
  that obtained it. Everything below follows from those two sentences.
*/
function dropRegistry() {
    $.global[REG_KEY] = {};
    $.global[REG_DOC_KEY] = '';
}

function stampRegistry(doc) {
    $.global[REG_DOC_KEY] = doc ? docKey(doc) : '';
}

// True when the registry's tokens still address the document in front.
function registryLive(doc) {
    if (!doc) return false;
    return $.global[REG_DOC_KEY] === docKey(doc);
}

function registerItem(item) {
    $.global.WCAG_SEQ = ($.global.WCAG_SEQ || 0) + 1;
    var token = 's' + $.global.WCAG_SEQ;
    registry()[token] = item;
    return token;
}

/*
  `doc` is optional and is an optimisation, not a shortcut. Callers that look up
  hundreds of tokens in one pass resolve the active document once and hand it
  in; callers that look up one can leave it out. The check happens either way.
*/
function lookupItem(token, doc) {
    token = String(token);

    if (doc === undefined) doc = activeDoc();
    if (!registryLive(doc)) { dropRegistry(); return null; }

    var item = registry()[token];
    if (!item) return null;

    /*
      Kept as a second line of defence, not a first. It catches the ordinary
      JavaScript case where the object was replaced by something inert. It does
      NOT make a freed handle safe, and nothing above may rely on it doing so.
    */
    try { var probe = item.typename; } catch (e) { return null; }
    return item;
}

function clearRegistry(doc) {
    $.global[REG_KEY] = {};
    stampRegistry(doc);
}

// ---------------------------------------------------------------------------
// Colour reading
//
// Illustrator hands back one of several colour classes. Only solid colours have
// a single RGB value; gradients and patterns deliberately return kind !== 'solid'
// so the panel can tell the user to sample instead of guessing.
//
// Conversions go through app.convertSampleColor, which applies the document's
// own colour profile — more faithful than hand-rolled CMYK arithmetic.
// ---------------------------------------------------------------------------

/*
  ImageColorSpace member names are case-sensitive, undocumented in practice, and
  not the same in every build.

  The scripting reference lists CMYK, DeviceN, Grayscale, Indexed, LAB, RGB and
  Separation. Illustrator 30.7 accepts the first two and the last three and
  rejects every spelling of grayscale — and rejects them by THROWING "Invalid
  enumeration value", not by returning undefined, so a bare `ImageColorSpace[x]`
  takes the whole call down with it.

  Hence: a list of candidates per space, each tried in its own guard, cached.
*/
var IMAGE_SPACES = {
    RGB: ['RGB'],
    CMYK: ['CMYK'],
    LAB: ['LAB'],
    /*
      Every spelling anyone has ever used. The reference says `Grayscale`, older
      material says `GrayScale`, and Illustrator 30.7 turns out to accept
      neither — indexing the enum with a name it does not know THROWS
      "Invalid enumeration value" rather than returning undefined, so a bare
      lookup takes the whole call down with it.
    */
    GRAYSCALE: ['Grayscale', 'GrayScale', 'GRAYSCALE', 'Gray', 'GrayScaleColor']
};

// Cached because the misses throw, and throwing repeatedly in a loop is slow.
function imageSpace(name) {
    var key = String(name).toUpperCase();

    if (!$.global.WCAG_SPACES) $.global.WCAG_SPACES = {};
    if ($.global.WCAG_SPACES.hasOwnProperty(key)) return $.global.WCAG_SPACES[key];

    var names = IMAGE_SPACES[key] || [];
    var found = null;
    var matched = '';

    for (var i = 0; i < names.length; i++) {
        try {
            var value = ImageColorSpace[names[i]];
            if (value !== undefined && value !== null) {
                found = value;
                matched = names[i];
                break;
            }
        } catch (e) {
            // Not a member of this build's enum. Try the next spelling.
        }
    }

    $.global.WCAG_SPACES[key] = found;
    $.global.WCAG_SPACES[key + '_NAME'] = matched;
    return found;
}

function convertSample(fromSpace, values) {
    try {
        var source = imageSpace(fromSpace);
        if (source === null) return null;

        var out = app.convertSampleColor(
            source,
            values,
            ImageColorSpace.RGB,
            ColorConvertPurpose.defaultpurpose
        );
        if (!out || out.length < 3) return null;
        if (!isNum(out[0]) || !isNum(out[1]) || !isNum(out[2])) return null;

        return [clamp255(out[0]), clamp255(out[1]), clamp255(out[2])];
    } catch (e) {
        return null;
    }
}

/*
  GRAYSCALE, THE AWKWARD ONE
  ==========================

  Illustrator's GrayColor.gray runs 0-100 with 100 meaning black. The Grayscale
  IMAGE space is a different convention — image samples conventionally run 0-255
  with 0 meaning black — and Adobe documents neither the range nor the polarity
  convertSampleColor expects. Guessing wrong does not throw; it silently returns
  an inverted colour, which is the worst possible failure for a contrast tool:
  black text confidently measured as white.

  So do not guess. Ask the host once, cache the answer, and derive both the
  range and the polarity from what actually comes back.
*/
function grayProfile() {
    if ($.global.WCAG_GRAY_PROFILE) return $.global.WCAG_GRAY_PROFILE;

    var profile = { usable: false, max: 255, zeroIsBlack: true };

    try {
        var atZero = convertSample('GRAYSCALE', [0]);
        var at100 = convertSample('GRAYSCALE', [100]);
        var at255 = convertSample('GRAYSCALE', [255]);

        if (atZero && at100 && at255) {
            // If 255 lands on the same colour as 100, the input saturated at
            // 100 and the range is 0-100. Otherwise it is 0-255.
            profile.max = sameColour(at100, at255, 6) ? 100 : 255;

            var top = (profile.max === 100) ? at100 : at255;
            // Polarity: is the low end of the input the dark end?
            profile.zeroIsBlack = (atZero[0] + atZero[1] + atZero[2]) <
                                  (top[0] + top[1] + top[2]);
            profile.usable = !sameColour(atZero, top, 6);
        }
    } catch (e) {}

    $.global.WCAG_GRAY_PROFILE = profile;
    return profile;
}

// gray is Illustrator's 0-100, where 100 is black.
function grayToRgb(gray) {
    if (!isNum(gray)) gray = 0;
    if (gray < 0) gray = 0;
    if (gray > 100) gray = 100;

    var profile = grayProfile();

    if (profile.usable) {
        // Ink coverage 0..1, where 1 is full black.
        var ink = gray / 100;
        var sample = profile.zeroIsBlack
            ? profile.max * (1 - ink)     // 0 = black, so invert
            : profile.max * ink;          // 0 = white, so pass straight through
        var converted = convertSample('GRAYSCALE', [sample]);
        if (converted) return converted;
    }

    /*
      No grayscale image space on this build — Illustrator 30.7 rejects every
      spelling of it — so fall back to plain neutral ink coverage.

      NOT to K-only CMYK, which was the first thing tried and is wrong here. That
      route simulates printed black ink, so 100% gray came back as (35, 31, 32)
      instead of black: a 15.8:1 reading for text that actually renders at 21:1.
      Under-reporting contrast is the safer direction to be wrong in, but it is
      still wrong, and it would fail artwork that passes.

      A neutral ramp cannot be inverted and lands on true black and true white at
      the ends, which is what a reader sees. Mid-greys are approximate: a Gray
      working space with dot gain renders 50% a little darker than 128.
    */
    var flat = clamp255(255 * (1 - gray / 100));
    return [flat, flat, flat];
}

// NaN fails every comparison silently: (NaN <= 0) is false, so a bad number
// slips past range checks and reaches native calls. Check explicitly.
function isNum(n) {
    return typeof n === 'number' && isFinite(n);
}

function isFiniteBounds(b) {
    if (!b || b.length < 4) return false;
    for (var i = 0; i < 4; i++) {
        if (!isNum(b[i])) return false;
    }
    return true;
}

function clamp255(n) {
    if (!isNum(n)) return 0;
    n = Math.round(n);
    if (n < 0) return 0;
    if (n > 255) return 255;
    return n;
}

function mixToward(rgb, target, amount) {
    return [
        clamp255(rgb[0] + (target[0] - rgb[0]) * amount),
        clamp255(rgb[1] + (target[1] - rgb[1]) * amount),
        clamp255(rgb[2] + (target[2] - rgb[2]) * amount)
    ];
}

// Returns { kind: 'solid'|'gradient'|'pattern'|'none'|'unknown', rgb: [r,g,b]|null }
// depth guard: a spot swatch whose base ink is itself a spot colour would
// recurse forever and blow the ExtendScript stack.
function readColour(colour, depth) {
    var none = { kind: 'none', rgb: null };
    if (!colour) return none;
    if (!depth) depth = 0;
    if (depth > 6) return none;

    var kind;
    try { kind = String(colour.typename); } catch (e) { return none; }

    if (kind === 'RGBColor') {
        return { kind: 'solid', rgb: [clamp255(colour.red), clamp255(colour.green), clamp255(colour.blue)] };
    }

    if (kind === 'CMYKColor') {
        var c = convertSample('CMYK', [colour.cyan, colour.magenta, colour.yellow, colour.black]);
        return c ? { kind: 'solid', rgb: c } : none;
    }

    if (kind === 'GrayColor') {
        var g = grayToRgb(colour.gray);
        return g ? { kind: 'solid', rgb: g } : none;
    }

    if (kind === 'LabColor') {
        var l = convertSample('LAB', [colour.l, colour.a, colour.b]);
        return l ? { kind: 'solid', rgb: l } : none;
    }

    if (kind === 'SpotColor') {
        // A spot swatch carries a base ink; tint is the percentage of that ink
        // actually laid down, so the remainder shows paper through it.
        var base;
        try { base = readColour(colour.spot.color, depth + 1); } catch (e) { return none; }
        if (!base || base.kind !== 'solid') return none;

        var tint = 100;
        try { tint = colour.tint; } catch (e2) { tint = 100; }

        if (tint >= 100) return { kind: 'solid', rgb: base.rgb };
        return { kind: 'solid', rgb: mixToward(base.rgb, [255, 255, 255], 1 - (tint / 100)) };
    }

    /*
      A gradient has no single colour — but it does have STOPS, and those are
      readable. The panel used to refuse outright, which left "text on a hero
      gradient" permanently unmeasurable: the single most common real case, and
      the one people most need checked.

      Reporting the stops lets the panel grade the WORST of them. Averaging them
      would be a false pass waiting to happen — text over a light-to-dark ramp
      averages to mid-grey, so black text would clear the average while being
      invisible at the dark end.
    */
    if (kind === 'GradientColor') {
        return { kind: 'gradient', rgb: null, stops: gradientStops(colour, depth) };
    }
    if (kind === 'PatternColor') return { kind: 'pattern', rgb: null };
    if (kind === 'NoColor') return none;

    return { kind: 'unknown', rgb: null };
}

/*
  Every stop in a gradient, as a colour and an opacity.

  Capped: a gradient with hundreds of stops is pathological, and the extremes
  plus a sample of the middle already bound the worst case. A stop whose own
  colour is unreadable (a pattern inside a gradient is not a thing, but a spot
  colour that fails to resolve is) is skipped rather than guessed at.
*/
function gradientStops(colour, depth) {
    var out = [];
    var missed = 0;
    try {
        var stops = colour.gradient.gradientStops;
        // Past the cap, or unreadable: either way the panel is grading a SUBSET,
        // and a verdict computed from a subset must say so.
        if (stops.length > 24) missed += stops.length - 24;

        for (var i = 0; i < stops.length && i < 24; i++) {
            var read = readColour(stops[i].color, (depth || 0) + 1);
            if (read.kind !== 'solid' || !read.rgb) { missed++; continue; }

            var alpha = 1;
            try {
                if (typeof stops[i].opacity === 'number') alpha = stops[i].opacity / 100;
            } catch (eO) {}

            // Where along the ramp, so the panel walks stops in painted order
            // rather than in whatever order the collection hands them back.
            var at = i;
            try {
                if (typeof stops[i].rampPoint === 'number') at = stops[i].rampPoint;
            } catch (eR) {}

            out.push({ rgb: read.rgb, alpha: alpha, rampPoint: at });
        }
    } catch (e) {}

    out.missed = missed;
    return out;
}

/*
  Outlined text is a group of compound paths, one per letter, and a compound
  path is itself several subpaths. Writing to a single subpath recolours one
  letter — the bug seen in the field. Always write to every subpath.
*/
function applyFillToItem(item, colour, fromRgb) {
    var written = 0;

    if (isTextItem(item)) return applyFillToText(item, colour, fromRgb);

    /*
      A shape painted some other colour is not part of this fix. A frame with
      red and grey text, selected with a red bar under it, sends the bar along
      with the text; fixing the grey must not repaint the bar.
    */
    if (fromRgb) {
        var current = fillOf(item);
        if (current.kind !== 'solid' || !sameColour(current.rgb, fromRgb, 2)) return 0;
    }

    // A subpath inside a compound path: colour all of its siblings too.
    try {
        var parent = item.parent;
        if (parent && String(parent.typename) === 'CompoundPathItem') {
            var subs = parent.pathItems;
            for (var i = 0; i < subs.length; i++) {
                try { subs[i].filled = true; subs[i].fillColor = colour; written++; } catch (e) {}
            }
            if (written) return written;
        }
    } catch (e2) {}

    // A compound path handed over whole.
    try {
        if (String(item.typename) === 'CompoundPathItem') {
            var own = item.pathItems;
            for (var j = 0; j < own.length; j++) {
                try { own[j].filled = true; own[j].fillColor = colour; written++; } catch (e3) {}
            }
            if (written) return written;
        }
    } catch (e4) {}

    item.filled = true;
    item.fillColor = colour;
    return 1;
}

// Two fills count as the same swatch if they are visually indistinguishable.
function sameColour(a, b, tolerance) {
    if (!a || !b) return false;
    if (!tolerance) tolerance = 2;
    return Math.abs(a[0] - b[0]) <= tolerance &&
           Math.abs(a[1] - b[1]) <= tolerance &&
           Math.abs(a[2] - b[2]) <= tolerance;
}

// Some things must never be recoloured: overwriting a gradient or a pattern
// destroys it, and placed art and symbols are not ours to touch.
function refuseReason(item) {
    var kind;
    try { kind = String(item.typename); } catch (e) { return 'unreadable object'; }

    if (kind === 'PlacedItem') return 'a placed or linked image';
    if (kind === 'RasterItem') return 'a raster image';
    if (kind === 'SymbolItem') return 'a symbol instance';
    if (kind === 'MeshItem') return 'a gradient mesh';
    if (kind === 'GraphItem') return 'a graph object';

    /*
      A clipping path with no fill is pure geometry, and writing one would
      give the mask a fill nobody asked for. One that carries a fill is
      different: Draw Inside keeps the shape's fill, and Illustrator paints
      it behind everything the mask holds. That fill is the background the
      designer sees, so it is fair game.
    */
    try {
        if (item.clipping === true) {
            var paints = false;
            try { paints = item.filled === true; } catch (eF) {}
            if (!paints) return 'a clipping path';
        }
    } catch (e2) {}

    var fill = fillOf(item);
    if (fill.kind === 'gradient') return 'a gradient fill';
    if (fill.kind === 'pattern') return 'a pattern fill';

    return null;
}

function isTextItem(item) {
    try { return String(item.typename) === 'TextFrame'; } catch (e) { return false; }
}

function isGroupItem(item) {
    try { return String(item.typename) === 'GroupItem'; } catch (e) { return false; }
}

// The fill of a page item, whatever kind of item it is.
function fillOf(item) {
    try {
        if (isTextItem(item)) {
            var attrs;
            try {
                attrs = item.textRange.characters[0].characterAttributes;
            } catch (inner) {
                attrs = item.textRange.characterAttributes;
            }
            return readColour(attrs.fillColor);
        }
        /*
          A placed image or a raster is opaque paint with no single colour.

          It has no fillColor, so reading one threw and the catch below reported
          "no fill" — indistinguishable from a transparent object. The backdrop
          search then stepped straight THROUGH the photo onto the white card
          underneath it, and white text over that photo was measured against the
          card: 12.63:1, a confident AAA pass, for artwork that renders at 1.42.

          Naming it 'image' makes it an opaque stop the panel refuses to grade
          and offers to sample instead, which is what the README has always
          claimed happens.
        */
        var kind = String(item.typename);
        if (kind === 'RasterItem' || kind === 'PlacedItem') {
            return { kind: 'image', rgb: null };
        }

        /*
          A compound path has no fill of its own to read. Its subpaths carry
          the one fill they share, so asking the container answered "no fill",
          and every background built with Pathfinder, every shape with a hole
          in it, was invisible to the backdrop search.
        */
        if (kind === 'CompoundPathItem') {
            var lead = null;
            try { if (item.pathItems.length) lead = item.pathItems[0]; } catch (eLead) {}
            return lead ? fillOf(lead) : { kind: 'none', rgb: null };
        }

        if (item.filled === false) return { kind: 'none', rgb: null };
        return readColour(item.fillColor);
    } catch (e) {
        return { kind: 'none', rgb: null };
    }
}

// ---------------------------------------------------------------------------
// Text runs
// ---------------------------------------------------------------------------

/*
  ONE TEXT FRAME, SEVERAL COLOURS

  A headline with one word in the brand colour, a price in red, a label whose
  first line is bold and larger. The frame was read from its first character,
  so the panel graded whatever colour happened to come first and said nothing
  about the rest. A grey caption with one dark word up front passed on the
  strength of that word.

  Illustrator hands a frame's text back as ranges, one per stretch of identical
  attributes. Read each, keep the distinct colour, size and weight combinations,
  and let the panel grade every one of them against its own threshold.

  The ranges are capped, and when a frame gives back more than the cap (or one
  range that is visibly not uniform) the words stand in for them: colour
  changes in real artwork land on word boundaries.
*/
var RUN_SCAN_LIMIT = 400;
var RUN_KEEP_LIMIT = 24;
var BOLD_STYLE = /bold|black|heavy|semibold|demibold/i;

// Cheap check for a single range that is not actually uniform: compare the
// first and last characters.
function looksMixed(frame) {
    try {
        var chars = frame.textRange.characters;
        var len = chars.length;
        if (len < 2) return false;
        var a = chars[0].characterAttributes;
        var b = chars[len - 1].characterAttributes;
        if (colourValueStamp(a.fillColor) !== colourValueStamp(b.fillColor)) return true;
        return a.size !== b.size;
    } catch (e) {
        return false;
    }
}

/*
  The ranges to read. `forWrite` drops the cap and the sampling: a recolour
  that skipped a word would leave it behind in the old colour.
*/
function textRunList(frame, forWrite) {
    var list = [];
    var ranges = null;
    var n = 0;
    try { ranges = frame.textRanges; n = ranges.length; } catch (e) { ranges = null; n = 0; }

    var cap = forWrite ? 20000 : RUN_SCAN_LIMIT;
    if (ranges && (n > 1 || (n === 1 && !looksMixed(frame))) && n <= cap) {
        for (var i = 0; i < n; i++) {
            try { list.push(ranges[i]); } catch (e2) {}
        }
        if (list.length) return list;
    }

    if (forWrite) {
        var chars = null;
        var c = 0;
        try { chars = frame.textRange.characters; c = chars.length; } catch (e3) { c = 0; }
        for (var k = 0; k < c && k < 20000; k++) {
            try { list.push(chars[k]); } catch (e4) {}
        }
        return list;
    }

    var words = null;
    var w = 0;
    try { words = frame.words; w = words.length; } catch (e5) { w = 0; }
    if (w > 0) {
        var step = Math.max(1, Math.ceil(w / RUN_SCAN_LIMIT));
        for (var j = 0; j < w; j += step) {
            try { list.push(words[j]); } catch (e6) {}
        }
        // Every word read, or only a sample: the panel has to know which.
        if (step > 1) list.sampled = true;
        if (list.length) return list;
    }

    try { list.push(frame.textRange); } catch (e7) {}
    return list;
}

// Spaces and returns are drawn in no colour at all. A return carrying a stray
// colour from an old edit is the most common "second colour" in real files.
function isBlankRange(range) {
    try { return !/\S/.test(String(range.contents)); } catch (e) { return false; }
}

/*
  Every distinct colour, rendered size and weight in a frame.

  Returns { list: [{ rgb, pointSize, bold, chars }], unreadable: n }, where
  `unreadable` counts runs painted with a gradient or a pattern, which the panel
  must admit it did not grade.
*/
function textRuns(frame) {
    var out = { list: [], unreadable: 0, partial: false };

    var scale = scaleFactorOf(frame);
    if (Math.abs(scale - 1) < 0.005) scale = 1;

    var ranges = textRunList(frame, false);
    if (ranges.sampled) out.partial = true;
    var read = {};
    var index = {};

    for (var i = 0; i < ranges.length; i++) {
        var range = ranges[i];
        if (isBlankRange(range)) continue;

        var attrs;
        try { attrs = range.characterAttributes; } catch (e) { continue; }

        var colour = null;
        try { colour = attrs.fillColor; } catch (e1) {}
        // Converting a CMYK colour is a round trip through the colour engine,
        // so each distinct colour is converted once.
        var stamp = colourValueStamp(colour);
        if (!read.hasOwnProperty(stamp)) read[stamp] = readColour(colour);
        var fill = read[stamp];

        if (fill.kind === 'none') continue;
        if (fill.kind !== 'solid' || !fill.rgb) { out.unreadable++; continue; }

        var size = 0;
        try { size = attrs.size; } catch (e2) {}
        if (!isNum(size) || size < 0) size = 0;
        size = Math.round(size * scale * 100) / 100;

        var bold = false;
        try { bold = BOLD_STYLE.test(String(attrs.textFont.style)); } catch (e3) {}

        var chars = 0;
        try { chars = range.length; } catch (e4) {}
        if (!isNum(chars)) chars = 0;

        var key = stamp + '|' + size + '|' + (bold ? 1 : 0);
        if (index.hasOwnProperty(key)) { out.list[index[key]].chars += chars; continue; }
        if (out.list.length >= RUN_KEEP_LIMIT) { out.partial = true; continue; }

        index[key] = out.list.length;
        out.list.push({ rgb: fill.rgb, pointSize: size, bold: bold, chars: chars });
    }

    return out;
}

/*
  Recolour the runs painted `fromRgb`, and only those.

  The whole frame used to take the new fill, so fixing the grey caption in a
  frame that also held a red price turned the price grey. With no `fromRgb`
  (an older panel) every run is written, which is the old behaviour.
*/
function applyFillToText(frame, colour, fromRgb) {
    if (!fromRgb) {
        frame.textRange.characterAttributes.fillColor = colour;
        return 1;
    }

    var ranges = textRunList(frame, true);
    var written = 0;
    // When the ranges fall back to single characters, a CMYK frame would
    // otherwise pay a colour engine round trip per letter.
    var read = {};
    for (var i = 0; i < ranges.length; i++) {
        var range = ranges[i];
        var fillColour;
        try { fillColour = range.characterAttributes.fillColor; } catch (e) { continue; }
        var stamp = colourValueStamp(fillColour);
        if (!read.hasOwnProperty(stamp)) read[stamp] = readColour(fillColour);
        var fill = read[stamp];
        if (fill.kind !== 'solid' || !sameColour(fill.rgb, fromRgb, 2)) continue;
        try { range.characterAttributes.fillColor = colour; written++; } catch (e2) {}
    }
    return written;
}

// ---------------------------------------------------------------------------
// Transparency
// ---------------------------------------------------------------------------

/*
  WHAT IS ACTUALLY CHANGING THIS COLOUR

  Opacity and blend modes compound through every container an item sits inside,
  so black text in a group at 50% renders as mid-grey — and the panel was right
  to say so, but said only "3.87:1" and left the designer staring at artwork
  they know is black.

  So instead of quietly returning a number, collect the chain: every container
  between the item and the document that changes how it renders, named. The
  panel turns that into "black, but inside 'Header' at 50% opacity", which is
  something you can act on — and which makes it obvious when the reading is
  wrong rather than merely surprising.

  Neutral containers are omitted, so an empty chain means the rendered colour is
  the authored colour.
*/
function appearanceChain(item) {
    var chain = [];
    var node = item;
    var hops = 0;

    while (node && hops < 40) {
        hops++;

        var kind;
        try { kind = String(node.typename); } catch (e) { break; }
        // Checked before reading anything off it: the document is not a
        // container with an appearance, and asking it for one is meaningless.
        if (kind === 'Document') break;

        var opacity = 100;
        try {
            if (typeof node.opacity === 'number') {
                opacity = node.opacity;
                if (opacity < 0) opacity = 0;
                if (opacity > 100) opacity = 100;
            }
        } catch (e2) {}

        var blend = 'normal';
        try { blend = blendOf(node); } catch (e3) {}

        if (opacity < 99.5 || blend !== 'normal') {
            chain.push({
                kind: kind === 'Layer' ? 'layer'
                    : (kind === 'GroupItem' ? 'group'
                    : (hops === 1 ? 'object' : 'container')),
                name: describe(node),
                opacity: Math.round(opacity),   // for the panel to show
                exact: opacity,                 // for the maths
                blend: blend,
                own: hops === 1,
                uid: nodeUid(node, kind),
                hop: hops
            });
        }

        try { node = node.parent; } catch (e4) { break; }
    }

    /*
      Distance from the root, not from the item. Two chains are compared to find
      the containers they share, and those are the OUTER ones — so each link
      needs a depth both chains measure the same way. Counting from the item
      would put a shared layer at position 3 in one chain and 2 in the other.
    */
    for (var d = 0; d < chain.length; d++) {
        chain[d].up = hops - chain[d].hop;
    }

    return chain;
}

/*
  A stable identity for a container, so two chains can be told apart.

  Name and opacity alone are not enough: two sibling groups both called
  "<Group>" at 65% would compare equal, and the shared-ancestor maths would then
  cancel an opacity that is not actually shared. Illustrator hands out a uuid for
  page items; layers have none, so fall back to name plus z-order, which is
  unique among a parent's children.
*/
function nodeUid(node, kind) {
    var uid = '';
    try { if (node.uuid) uid = String(node.uuid); } catch (e) {}
    if (uid) return uid;

    var name = '';
    try { name = String(node.name); } catch (e2) {}

    var z = '';
    try { z = String(node.absoluteZOrderPosition); } catch (e3) {
        try { z = String(node.zOrderPosition); } catch (e4) {}
    }

    return kind + '|' + name + '|' + z;
}

/*
  Opacity from a chain. Kept as a separate function so callers that already hold
  a chain do not walk the tree again: wcagSelection needs the chain, the alpha
  and the blend for both sides, and rebuilding the chain for each was a fresh
  parent walk every time.
*/
function alphaOfChain(chain) {
    var alpha = 1;
    for (var i = 0; i < chain.length; i++) {
        // The exact opacity, not the rounded one shown in the UI: rounding 33.33
        // to 33 can nudge a borderline ratio across a threshold.
        alpha = alpha * (chain[i].exact / 100);
    }
    return alpha;
}

function blendOfChain(chain) {
    for (var i = 0; i < chain.length; i++) {
        if (chain[i].blend !== 'normal') return chain[i].blend;
    }
    return 'normal';
}

/*
  A container shared by an item and the thing behind it must not be counted
  twice.

  Illustrator renders a group into its own buffer and composites that buffer
  once. Applying a group's 65% to the background AND again to the text drawn
  over it made black-on-grey inside one group measure 4.53:1 — a pass — where
  Illustrator renders 2.71:1. The shared containers are the common OUTER part of
  the two chains, so compare from the far end inwards.
*/
function sharedTail(chain, otherChain) {
    var tail = [];
    if (!chain || !chain.length || !otherChain || !otherChain.length) return tail;

    var a = chain.length - 1;
    var b = otherChain.length - 1;

    while (a >= 0 && b >= 0 && sameContainer(chain[a], otherChain[b])) {
        tail.unshift(chain[a]);
        a--;
        b--;
    }
    return tail;
}

function unsharedAlpha(chain, otherChain) {
    var shared = sharedTail(chain, otherChain).length;
    var alpha = 1;
    for (var i = 0; i < chain.length - shared; i++) {
        alpha = alpha * (chain[i].exact / 100);
    }
    return alpha;
}

/*
  The blend belongs to whichever half owns it, and to that half only.

  De-sharing the alpha but not the blend was worse than de-sharing neither. A
  group set to Multiply put "multiply" on the foreground AND on the shared
  layer, so the panel applied it at the inner step and again at the outer one.
  #555555 text on a #A0A0A0 card inside a Multiply group over white paper
  renders exactly as authored — 2.85:1, a failure — and the panel reported 4.69
  and a green tick. Multiplying twice made the text darker than any pixel
  Illustrator ever draws.
*/
function unsharedBlend(chain, otherChain) {
    var shared = sharedTail(chain, otherChain).length;
    for (var i = 0; i < chain.length - shared; i++) {
        if (chain[i].blend !== 'normal') return chain[i].blend;
    }
    return 'normal';
}

/*
  The containers BOTH colours sit in, as a single layer the panel applies once.

  Cancelling the shared opacity from the foreground is only half the fix. The
  group still fades the text — just at the same time as it fades everything else
  in the group, over whatever is behind the group rather than over the
  background. Black text on #808080 inside a group at 65% renders as #595959 on
  #ACACAC, a 3.08:1 failure. Charging the 65% to the text a second time gave a
  darker #3C3C3C and reported 4.86 — a pass. Dropping it entirely leaves pure
  black and reports 9.25, which is no better a lie.
*/
function sharedAppearance(chain, otherChain) {
    var tail = sharedTail(chain, otherChain);
    return {
        alpha: alphaOfChain(tail),
        blend: blendOfChain(tail),
        name: tail.length ? tail[0].name : '',
        kind: tail.length ? tail[0].kind : ''
    };
}

function sameContainer(one, two) {
    if (!one || !two) return false;
    // Same object, same place in the tree. Both halves matter: uid alone would
    // trust a fallback string built from a name, and depth alone would pair any
    // two containers that happen to sit at the same level.
    return one.uid === two.uid && one.up === two.up;
}

function effectiveAlpha(item) {
    return alphaOfChain(appearanceChain(item));
}

/*
  A blend mode set on a group applies to everything inside it, and reading only
  the item's own mode missed that entirely — a group set to Multiply rendered
  nothing like what the panel measured. Nested blend groups composite in a way
  this flat model cannot represent, so take the innermost non-normal mode and
  let the panel name the container it came from.
*/
function effectiveBlend(item) {
    return blendOfChain(appearanceChain(item));
}

/*
  Visibility is inherited.

  item.hidden only reports the item's own flag. A shape on a hidden layer, or
  inside a hidden group, still answers `hidden === false` — so the backdrop
  search happily locked onto artwork nobody can see and measured text against an
  invisible rectangle. Walk up and ask every container too.
*/
function isEffectivelyHidden(item) {
    var node = item;
    var hops = 0;

    while (node && hops < 40) {
        hops++;

        var kind;
        try { kind = String(node.typename); } catch (e) { return false; }
        if (kind === 'Document') return false;

        if (kind === 'Layer') return layerChainHidden(node);

        /*
          One property, one try block. Sharing a try with the layer checks meant
          that if Illustrator threw on `hidden` for some item type rather than
          answering undefined, the jump to catch skipped the layer checks
          entirely — silently restoring the very bug this function exists to fix.
        */
        try { if (node.hidden === true) return true; } catch (e2) {}

        try { node = node.parent; } catch (e3) { return false; }
    }

    return false;
}

// Layers use `visible` rather than `hidden`, and a template layer is a tracing
// guide that does not render as artwork. Sublayers inherit both.
function layerChainHidden(layer) {
    var node = layer;
    var hops = 0;

    while (node && hops < 40) {
        hops++;

        var kind;
        try { kind = String(node.typename); } catch (e) { return false; }
        if (kind !== 'Layer') return false;

        try { if (node.visible === false) return true; } catch (e2) {}
        try { if (node.template === true) return true; } catch (e3) {}

        try { node = node.parent; } catch (e4) { return false; }
    }

    return false;
}

/*
  Enum stringifies as e.g. "BlendModes.MULTIPLY"; reduce to a bare token.

  Two of Illustrator's members carry a "BLEND" suffix that the W3C names do not:
  the reference lists BlendModes.COLORBLEND and BlendModes.SATURATIONBLEND. The
  first was handled, the second was not — so anything set to Saturation stopped
  matching, fell through to 'normal', and was measured as if it had no blend mode
  at all. Map explicitly rather than pattern-matching, so a name Adobe adds later
  is reported as unknown instead of silently becoming Normal.
*/
var BLEND_TOKENS = {
    normal: 'normal',
    multiply: 'multiply',
    screen: 'screen',
    overlay: 'overlay',
    softlight: 'softlight',
    hardlight: 'hardlight',
    colordodge: 'colordodge',
    colorburn: 'colorburn',
    darken: 'darken',
    lighten: 'lighten',
    difference: 'difference',
    exclusion: 'exclusion',
    hue: 'hue',
    saturationblend: 'saturation',
    colorblend: 'colorblend',
    luminosity: 'luminosity',
    // Defensive aliases: some builds and older references use the bare names.
    saturation: 'saturation',
    color: 'colorblend'
};

function blendOf(item) {
    var raw;
    try { raw = String(item.blendingMode); } catch (e) { return 'normal'; }

    var token = raw.replace(/^.*\./, '').toLowerCase();
    var mapped = BLEND_TOKENS[token];

    return mapped ? mapped : 'normal';
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/*
  Geometric bounds, not visible bounds.

  Two reasons, and the second is the better one.

  Speed: visibleBounds makes Illustrator resolve the item's whole appearance,
  every live effect, stroke, brush, feather and raster effect, before it can
  answer. geometricBounds is the path geometry it already has. This function
  feeds every candidate sweep in the file, so on a document with effects the
  difference is the difference between a panel and a beachball.

  Correctness: the question here is always "does this shape sit behind that
  text". A card with a 20pt drop shadow does not become a larger card. Grading
  text against a shape only its shadow reaches is wrong, and visibleBounds was
  quietly doing that.

  visibleBounds stays as the fallback for any item type that has no geometric
  bounds to give.
*/
function boundsOf(item) {
    var b;
    try { b = item.geometricBounds; } catch (e) {
        try { b = item.visibleBounds; } catch (e2) { return null; }
    }
    return isFiniteBounds(b) ? b : null;
}

function areaOf(b) {
    if (!isFiniteBounds(b)) return 0;
    var a = Math.abs((b[2] - b[0]) * (b[1] - b[3]));
    return isNum(a) ? a : 0;
}

// Illustrator bounds run [left, top, right, bottom] with top > bottom.
function encloses(outer, inner, slack) {
    if (!outer || !inner) return false;
    if (!slack) slack = 0;
    return (outer[0] - slack) <= inner[0] &&
           (outer[1] + slack) >= inner[1] &&
           (outer[2] + slack) >= inner[2] &&
           (outer[3] - slack) <= inner[3];
}

function holdsCentre(outer, inner) {
    if (!outer || !inner) return false;
    var cx = (inner[0] + inner[2]) / 2;
    var cy = (inner[1] + inner[3]) / 2;
    return cx >= outer[0] && cx <= outer[2] && cy <= outer[1] && cy >= outer[3];
}

// ---------------------------------------------------------------------------
// Backdrop search
//
// The shape behind a piece of text is the SMALLEST filled thing that encloses
// it — the card or banner, not the page-wide rectangle. Geometry beats z-order
// here because Illustrator's flattened pageItems collection does not preserve
// stacking across group boundaries.
// ---------------------------------------------------------------------------

/*
  Collect geometry only. Colour is NOT read here.

  A real document can hold thousands of page items, and every fill read costs a
  convertSampleColor round trip. Resolving colour up front made the panel unusable
  on a 1,600-item file. Instead we gather cheap bounds now and read the fill of
  only the handful of shapes that actually enclose the target.
*/
/*
  The ceiling on one document sweep.

  There was no ceiling at all, which is how a file with outlined type could
  freeze the panel: `doc.pageItems` is recursive, so a page of outlined
  headlines is thousands of entries before any real artwork is counted. Past a
  few thousand candidates the backdrop search is guessing anyway, so stopping
  costs accuracy nobody had, and buys back a responsive application.
*/
var SWEEP_LIMIT = 4000;

function candidateShapes(doc) {
    var list = [];
    var items;
    try { items = doc.pageItems; } catch (e) { return list; }

    /*
      Hoisted deliberately. `items` is a LIVE collection, so `items.length` in
      the loop condition made Illustrator re-count the document on every single
      iteration. Reading it once turns one of the two quadratic factors in this
      loop into a constant.
    */
    var n = 0;
    try { n = items.length; } catch (eLen) { return list; }
    if (n > SWEEP_LIMIT) n = SWEEP_LIMIT;

    for (var i = 0; i < n; i++) {
        var it;
        try { it = items[i]; } catch (eGet) { continue; }

        // One read of the type, shared by every test below.
        var kind;
        try { kind = String(it.typename); } catch (eKind) { continue; }
        if (kind === 'GroupItem') continue;

        /*
          A text frame is never a backdrop, but an area type frame can carry a
          fill on its box, and that fill sits right behind the type. Skipping
          every frame made a filled text box invisible to the search.
        */
        if (kind === 'TextFrame') {
            var box = textBoxCandidate(it);
            if (box) list.push(box);
            continue;
        }

        /*
          One property, one guard, and none of them may discard the candidate.

          These tests used to share a try whose catch did `continue`. A
          RasterItem and a PlacedItem carry neither `guides` nor `filled`, so on
          any build where a missing property throws rather than answering
          undefined, every photo in the document fell out of the candidate list
          on the first test. Isolating each test makes the outcome the same on
          every build.

          A compound path keeps its fill and clipping flag on its subpaths, so
          those questions go to the first subpath.
        */
        var paint = it;
        if (kind === 'CompoundPathItem') {
            try { if (it.pathItems.length) paint = it.pathItems[0]; } catch (eLead) {}
        }

        var skip = false;
        try { if (paint.guides) skip = true; } catch (eG) {}
        if (skip) continue;
        try { if (paint.filled === false) skip = true; } catch (eF) {}
        if (skip) continue;

        /*
          A subpath of a compound path is not a shape of its own. The compound
          is the candidate, and a subpath standing in for it would turn the hole
          in a ring into a filled disc.
        */
        if (kind === 'PathItem') {
            try { if (String(it.parent.typename) === 'CompoundPathItem') skip = true; } catch (eP) {}
            if (skip) continue;
        }

        /*
          A clipping path paints only when it carries a fill of its own, and a
          mask made with Make Clipping Mask has none (the `filled` test above
          already dropped it). Draw Inside keeps the shape's fill, and
          Illustrator paints that fill behind everything the mask holds. It is
          a backdrop, but the lowest one in its group: see shapeBehind.
        */
        var clipFill = false;
        try { if (paint.clipping === true) clipFill = true; } catch (eC) {}

        // Walks the container chain, so it stays last. Running it before the
        // single-property filters paid for a walk on every guide in the file.
        try { if (isEffectivelyHidden(it)) continue; } catch (eH) { continue; }

        var b = boundsOf(it);
        if (!b) continue;

        var candidate = { item: it, owner: it, bounds: b, area: areaOf(b),
                          rgb: null, kind: null, resolved: false };
        if (clipFill) {
            candidate.clipFill = true;
            try { candidate.group = it.parent; } catch (eGp) {}
        }
        list.push(candidate);
    }

    return list;
}

/*
  The fill on an area type frame's box, as a candidate.

  The box is a TextPath, which has a fill but no bounds of its own; it shares
  the frame's. Writes go to the path, and opacity comes from the frame, which
  is the object the Appearance panel shows it on.
*/
function textBoxCandidate(frame) {
    var kind = '';
    try { kind = String(frame.kind); } catch (e) { return null; }
    if (!/AREA/i.test(kind)) return null;

    var path = null;
    try { path = frame.textPath; } catch (e2) { return null; }
    if (!path) return null;

    try { if (path.filled !== true) return null; } catch (e3) { return null; }
    try { if (isEffectivelyHidden(frame)) return null; } catch (e4) { return null; }

    var b = boundsOf(frame);
    if (!b) return null;

    return { item: path, owner: frame, bounds: b, area: areaOf(b),
             rgb: null, kind: null, resolved: false, boxFill: true };
}

/*
  Read one candidate's fill, once, and cache it.

  Returns true for ANY real fill, including gradients and patterns. Skipping
  those made the search see straight through a gradient banner and lock onto a
  white shape behind it, reporting a confident 1.00:1 white-on-white. A gradient
  IS the answer — an answer the panel then refuses to grade.
*/
function resolveCandidate(candidate) {
    if (!candidate.resolved) {
        candidate.resolved = true;
        var fill = fillOf(candidate.item);
        candidate.kind = fill.kind;
        candidate.rgb = (fill.kind === 'solid') ? fill.rgb : null;
    }
    return candidate.kind !== 'none';
}

function excluded(candidate, skipList) {
    for (var i = 0; i < skipList.length; i++) {
        if (skipList[i] === candidate.item || skipList[i] === candidate.owner) return true;
    }
    return false;
}

// Illustrator bounds run [left, top, right, bottom] with top > bottom.
function rectIntersect(a, b) {
    if (!a || !b) return null;
    var left = Math.max(a[0], b[0]);
    var right = Math.min(a[2], b[2]);
    var top = Math.min(a[1], b[1]);
    var bottom = Math.max(a[3], b[3]);
    if (!(right > left) || !(top > bottom)) return null;
    return [left, top, right, bottom];
}

// The share of `target` that `rect` covers, 0 to 1.
function coverageOf(rect, target) {
    var whole = areaOf(target);
    if (!whole) return 0;
    var overlap = rectIntersect(rect, target);
    return overlap ? areaOf(overlap) / whole : 0;
}

// The clipping path of a clip group: the member flagged as one, which is
// usually the first.
function clipPathOf(group) {
    var kids;
    var n = 0;
    try { kids = group.pageItems; n = kids.length; } catch (e) { return null; }

    for (var i = 0; i < n && i < 60; i++) {
        var kid;
        try { kid = kids[i]; } catch (e2) { continue; }
        try { if (kid.clipping === true) return kid; } catch (e3) {}
        try {
            if (String(kid.typename) === 'CompoundPathItem' &&
                kid.pathItems.length && kid.pathItems[0].clipping === true) return kid;
        } catch (e4) {}
    }
    return null;
}

/*
  The part of a candidate that can actually be seen.

  A shape inside a clip group reports its full geometry, but only the part
  inside the mask is painted. A banner photo cropped to a small circle still
  claimed the whole banner, and text beside the circle was measured against a
  photo that is not there. Intersect with every clipping ancestor. Computed
  only for candidates that are already near the target, and cached.
*/
function visibleRectOf(candidate) {
    if (candidate.hasOwnProperty('visible')) return candidate.visible;

    var rect = candidate.bounds;
    var node = null;
    try { node = candidate.owner.parent; } catch (e) { node = null; }

    var hops = 0;
    while (node && rect && hops < 40) {
        hops++;
        var kind;
        try { kind = String(node.typename); } catch (e2) { break; }
        if (kind === 'Document' || kind === 'Layer') break;

        if (kind === 'GroupItem') {
            var clipped = false;
            try { clipped = node.clipped === true; } catch (e3) {}
            // A clipping path's own group is the one it defines: no further cut.
            var ownGroup = candidate.clipFill && hops === 1;
            if (clipped && !ownGroup) {
                var maskBounds = maskBoundsOf(node);
                if (maskBounds) rect = rectIntersect(rect, maskBounds);
            }
        }
        try { node = node.parent; } catch (e4) { break; }
    }

    candidate.visible = rect;
    return rect;
}

/*
  A clip group's mask bounds, once per read of the selection. Every member of
  a group asks for the same mask, and a group can hold hundreds of members.
  Reset by wcagSelection, so nothing read here outlives the call.
*/
var MASK_BOUNDS = null;

function maskBoundsOf(group) {
    var key = nodeUid(group, 'GroupItem');
    if (MASK_BOUNDS && MASK_BOUNDS.hasOwnProperty(key)) return MASK_BOUNDS[key];
    var mask = clipPathOf(group);
    var b = mask ? boundsOf(mask) : null;
    if (MASK_BOUNDS) MASK_BOUNDS[key] = b;
    return b;
}

// True when `candidate` sits somewhere inside `group`.
function insideGroup(candidate, group) {
    if (!group) return false;
    var groupId = nodeUid(group, 'GroupItem');
    var node = null;
    try { node = candidate.owner.parent; } catch (e) { return false; }

    var hops = 0;
    while (node && hops < 40) {
        hops++;
        if (node === group) return true;
        var kind;
        try { kind = String(node.typename); } catch (e2) { return false; }
        if (kind === 'Document' || kind === 'Layer') return false;
        if (kind === 'GroupItem' && nodeUid(node, kind) === groupId) return true;
        try { node = node.parent; } catch (e3) { return false; }
    }
    return false;
}

/*
  The shape behind an item.

  It used to have to ENCLOSE the item, which ruled out the most common layout
  there is: an area type frame drawn a little larger than the card under it.
  Nothing enclosed that frame except the page, so the card was skipped and the
  text was measured against the page colour.

  Now a shape qualifies when it sits behind most of the item, half its area or
  more, or when it holds the item's centre and is at least as large (the old
  rule, kept so nothing that matched before stops matching). Among those, the
  smallest is the nearest: a card sits on a page, not the other way round.

  Coverage is measured against the part of each shape that is visible, so a
  photo cropped by a mask only counts where the mask lets it show.

  `targetBounds` overrides the item's own bounds, for backdrops whose item has
  none (a text box) or is clipped.
*/
var COVER_MIN = 0.5;

function shapeBehind(item, shapes, skipList, targetBounds) {
    var target = targetBounds || boundsOf(item);
    if (!target) return null;

    var targetArea = areaOf(target);
    var behind = [];     // covers most of the target
    var centred = [];    // only holds its centre: the old rule, as a fallback
    var i, s;

    for (i = 0; i < shapes.length; i++) {
        s = shapes[i];
        if (s.item === item || s.owner === item || excluded(s, skipList)) continue;

        /*
          The raw bounds first. What can be seen is always inside them, so a
          shape that fails here would fail on its visible part too, and the
          parent walk below is only paid for the few that might qualify. On a
          page-sized target that is the difference between a handful of walks
          and one per shape in the file.
        */
        var rawCover = targetArea > 0 ? coverageOf(s.bounds, target) : 0;
        var rawCentre = holdsCentre(s.bounds, target) && s.area >= targetArea;
        if (rawCover < COVER_MIN && !rawCentre) continue;

        var seen = visibleRectOf(s);
        if (!seen) continue;

        var cover = targetArea > 0 ? coverageOf(seen, target) : (holdsCentre(seen, target) ? 1 : 0);
        if (cover >= COVER_MIN) behind.push({ c: s, area: areaOf(seen) });
        else if (holdsCentre(seen, target) && areaOf(seen) >= targetArea) centred.push({ c: s, area: areaOf(seen) });
    }

    function bySize(a, b) { return a.area - b.area; }
    behind.sort(bySize);
    centred.sort(bySize);

    /*
      Shapes behind most of the target win over shapes that merely cross its
      centre. A thin rule through a heading holds the heading's centre and is
      smaller than the box behind it; it is not the heading's background.
    */
    var near = behind;
    var pick = null;
    for (i = 0; i < behind.length; i++) {
        if (resolveCandidate(behind[i].c)) { pick = behind[i].c; break; }
    }
    if (!pick) {
        near = centred;
        for (i = 0; i < centred.length; i++) {
            if (resolveCandidate(centred[i].c)) { pick = centred[i].c; break; }
        }
    }

    /*
      A clipping path's fill is painted underneath everything its group holds,
      even though the path itself is the top member. When a member of the same
      group also sits behind the item, that member is the nearer backdrop: the
      photo inside a Draw Inside frame, not the frame's fill below it.
    */
    if (pick && pick.clipFill) {
        for (i = 0; i < near.length; i++) {
            var other = near[i].c;
            if (other === pick || other.clipFill) continue;
            if (insideGroup(other, pick.group) && resolveCandidate(other)) return other;
        }
    }

    return pick;
}

/*
  A selected object counts as the background, as a candidate the rest of the
  file can treat like any found one.
*/
function selectedCandidate(item) {
    /*
      Selection flattening hands over a compound path as its first subpath,
      which is right for reading and writing the fill and wrong for geometry:
      the first subpath of a ring may be its hole. Measure the compound.
    */
    var owner = item;
    try {
        if (String(item.parent.typename) === 'CompoundPathItem') owner = item.parent;
    } catch (e) {}
    var b = boundsOf(owner);
    return { item: item, owner: owner, bounds: b, area: areaOf(b),
             rgb: null, kind: null, resolved: false };
}

// What to call a backdrop in the panel.
function candidateLabel(candidate) {
    if (candidate.boxFill) return 'text box';
    return describe(candidate.item);
}

// The stack of shapes behind a backdrop, innermost first. The panel composites
// these to work out what colour is actually being rendered.
function backdropStack(start, shapes, maxDepth) {
    var stack = [];
    var skip = [start.item, start.owner];
    var current = start;

    for (var d = 0; d < maxDepth; d++) {
        var found = shapeBehind(current.owner, shapes, skip,
                                visibleRectOf(current) || current.bounds);
        if (!found) break;

        if (!found.rgb) break;   // unreadable backdrop: stop rather than guess
        stack.push({
            rgb: found.rgb,
            alpha: effectiveAlpha(found.owner),
            blend: effectiveBlend(found.owner),
            token: registerItem(found.item),
            label: candidateLabel(found)
        });

        skip.push(found.item);
        skip.push(found.owner);
        current = found;
    }

    return stack;
}

// ---------------------------------------------------------------------------
// Text classification
// ---------------------------------------------------------------------------

/*
  WCAG's 18pt / 14pt-bold thresholds are about the size the reader sees, not the
  number stored on the character. A text frame carrying a scale transform renders
  larger or smaller than its authored size, and grading a scaled-up 12pt caption
  as body text is a false failure (or, worse the other way, a false pass).

  The scale factor is the square root of the matrix determinant. If Illustrator
  has already baked the scale into the character size the matrix is identity and
  this multiplies by 1, so the two paths cannot double-count.
*/
function scaleFactorOf(item) {
    try {
        var m = item.matrix;
        if (!m) return 1;

        var det = (m.mValueA * m.mValueD) - (m.mValueB * m.mValueC);
        if (!isNum(det)) return 1;

        var scale = Math.sqrt(Math.abs(det));
        if (!isNum(scale) || scale <= 0) return 1;
        if (scale > 100) return 1;          // nonsense guard

        return scale;
    } catch (e) {
        return 1;
    }
}

// The authored character size, untouched.
function authoredPointSize(item) {
    try {
        var size = item.textRange.characterAttributes.size;
        return isNum(size) ? Math.round(size * 100) / 100 : 0;
    } catch (e) { return 0; }
}

// The size as rendered, which is what WCAG grades against.
function pointSize(item) {
    var authored = authoredPointSize(item);
    if (!authored) return 0;

    var scale = scaleFactorOf(item);
    // Ignore rounding-level differences so ordinary text keeps its exact size.
    if (Math.abs(scale - 1) < 0.005) return authored;

    return Math.round(authored * scale * 100) / 100;
}

function isBoldFont(item) {
    try {
        var style = String(item.textRange.characterAttributes.textFont.style);
        return /bold|black|heavy|semibold|demibold/i.test(style);
    } catch (e) { return false; }
}

/*
  The print reading of WCAG's large text: 18pt, or 14pt bold.

  For TEXT the panel reclassifies by medium, because on screen WCAG's points are
  CSS points and large starts at 24px. What the panel needs from here is the
  class of things that are NOT text, which only the host can tell apart.
*/
function sizeClassOf(item) {
    if (!isTextItem(item)) return 'graphic';
    var pt = pointSize(item);
    if (pt >= 18) return 'large';
    if (pt >= 14 && isBoldFont(item)) return 'large';
    return 'normal';
}

function describe(item) {
    try {
        if (isTextItem(item)) {
            var s = String(item.contents).replace(/[\r\n\t]+/g, ' ');
            s = s.replace(/^\s+/, '').replace(/\s+$/, '');
            if (s.length > 30) s = s.substring(0, 30) + '…';
            return s.length ? s : '(empty text)';
        }
        var name = '';
        try { name = String(item.name); } catch (e) {}
        if (name.length) return name;
        return String(item.typename).replace(/Item$/, '');
    } catch (e2) {
        return 'object';
    }
}

// ---------------------------------------------------------------------------
// Selection resolution
// ---------------------------------------------------------------------------

// depth guard: deeply nested groups would otherwise recurse past the
// ExtendScript stack limit.
/*
  `shape` is optional. When given, it records what the flattening threw away:
  whether the selection held a group, and how many compound paths it held.
  Outlined type is exactly a group of compound paths, one per letter with a hole
  in it, and that shape is the only clue the host has that a "graphic" is a word.
*/
function flatten(collection, out, depth, shape) {
    if (!depth) depth = 0;
    if (depth > 24) return out;
    if (out.length > 2000) return out;

    for (var i = 0; i < collection.length; i++) {
        var it = collection[i];
        try {
            if (isGroupItem(it)) {
                if (shape) shape.grouped = true;
                if (it.pageItems && it.pageItems.length) flatten(it.pageItems, out, depth + 1, shape);
            } else if (String(it.typename) === 'CompoundPathItem') {
                if (shape) shape.compound++;
                if (it.pathItems.length) out.push(it.pathItems[0]);
            } else {
                out.push(it);
            }
        } catch (e) {}
    }
    return out;
}

function selectedItems(doc, shape) {
    var sel;
    try { sel = doc.selection; } catch (e) { return []; }
    if (!sel) return [];

    // Type tool active: the selection is a TextRange, not an array of items.
    if (String(sel.typename) === 'TextRange') {
        var frames = [];
        try {
            var stories = sel.story.textFrames;
            for (var i = 0; i < stories.length; i++) frames.push(stories[i]);
        } catch (e2) {}
        return frames;
    }

    if (!sel.length) return [];
    return flatten(sel, [], 0, shape);
}

// ---------------------------------------------------------------------------
// Writing colour back
// ---------------------------------------------------------------------------

function hexToRgb(hex) {
    var h = String(hex).replace(/^#/, '');
    if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
    return [
        parseInt(h.substring(0, 2), 16),
        parseInt(h.substring(2, 4), 16),
        parseInt(h.substring(4, 6), 16)
    ];
}

function buildColour(doc, rgb) {
    var isRgbDoc = true;
    try { isRgbDoc = /rgb/i.test(String(doc.documentColorSpace)); } catch (e) {}

    if (isRgbDoc) {
        var c = new RGBColor();
        c.red = clamp255(rgb[0]);
        c.green = clamp255(rgb[1]);
        c.blue = clamp255(rgb[2]);
        return c;
    }

    var conv;
    try {
        conv = app.convertSampleColor(
            ImageColorSpace.RGB, [rgb[0], rgb[1], rgb[2]],
            ImageColorSpace.CMYK, ColorConvertPurpose.defaultpurpose
        );
    } catch (e2) { conv = [0, 0, 0, 100]; }

    var k = new CMYKColor();
    k.cyan = conv[0];
    k.magenta = conv[1];
    k.yellow = conv[2];
    k.black = conv[3];
    return k;
}

// ===========================================================================
// Exported entry points. Each returns a JSON string.
// ===========================================================================


/*
  Every exported function goes through this. An uncaught ExtendScript error
  inside evalScript surfaces to the panel as the useless string "EvalScript
  error." with no clue what happened; this turns it into a readable JSON error.
*/
function guarded(name, fn) {
    try {
        return fn();
    } catch (e) {
        var where = '';
        try { if (e.line) where = ' (line ' + e.line + ')'; } catch (e2) {}
        return toJson({ ok: false, error: name + ': ' + e.message + where });
    }
}

function wcagPing() {
  return guarded('wcagPing', function () {
        var doc = activeDoc();
        return toJson({
            ok: true,
            version: '1.12.0',
            appVersion: (function () { try { return String(app.version); } catch (e) { return '?'; } })(),
            hasDocument: doc !== null,
            // The panel writes its captures here, so it needs a writable path.
            tempFolder: (function () { try { return Folder.temp.fsName; } catch (e) { return ''; } })(),
            os: (function () { try { return String($.os); } catch (e) { return ''; } })()
        });
  });

}

/*
  A deliberately cheap fingerprint of the current selection.

  The panel polls this several times a second. It reads no colours and walks no
  geometry — just enough to notice that something changed, at which point the
  panel asks for the full wcagSelection payload. Doing the expensive work on a
  timer instead would make the panel unusable on a large document.
*/
/*
  A raw colour fingerprint that costs nothing.

  Deliberately does NOT call convertSampleColor: this runs on every poll, and a
  colour-management round trip per selected item is exactly the cost the cheap
  signature exists to avoid. Reading the stored components is enough to notice
  that a fill changed.
*/
function colourStamp(item, depth) {
    if (!depth) depth = 0;
    if (depth > 4) return '~';

    var kind;
    try { kind = String(item.typename); } catch (eKind) { return '?'; }

    /*
      Containers hold no fill of their own.

      Reading `fillColor` off a GroupItem or a CompoundPathItem yields nothing,
      so the stamp was a constant for both — and those are exactly the shapes
      people recolour: every compound path is a shape with a hole, and outlined
      text is a group of them. Recolouring one left the panel showing the old
      ratio as though it were live. Descend to the first leaf instead.
    */
    if (kind === 'GroupItem') {
        try {
            var kids = item.pageItems;
            if (kids.length) return 'G' + colourStamp(kids[0], depth + 1);
        } catch (eG) {}
        return 'G-';
    }
    if (kind === 'CompoundPathItem') {
        try {
            var subs = item.pathItems;
            if (subs.length) return 'P' + colourStamp(subs[0], depth + 1);
        } catch (eP) {}
        return 'P-';
    }

    var colour;
    try {
        if (isTextItem(item)) {
            /*
              Every run, not the frame as a whole. Recolouring the third word
              of a headline left the first character, and so the stamp, as it
              was, and the panel kept showing the old reading until the slow
              heartbeat came round. Six runs is enough to notice an edit and
              cheap enough to do on every poll.
            */
            var ranges = null;
            var n = 0;
            try { ranges = item.textRanges; n = ranges.length; } catch (eR) { n = 0; }
            if (n > 0) {
                var parts = ['t' + n];
                for (var r = 0; r < n && r < 6; r++) {
                    try { parts.push(colourValueStamp(ranges[r].characterAttributes.fillColor, depth)); }
                    catch (eS) { parts.push('?'); }
                }
                return parts.join('/');
            }
            colour = item.textRange.characterAttributes.fillColor;
        } else {
            if (item.filled === false) return 'nofill';
            colour = item.fillColor;
        }
    } catch (e) { return '?'; }

    return colourValueStamp(colour, depth);
}

function colourValueStamp(colour, depth) {
    if (!colour) return 'none';
    if (!depth) depth = 0;
    if (depth > 4) return '~';

    var kind;
    try { kind = String(colour.typename); } catch (e2) { return '?'; }

    try {
        if (kind === 'RGBColor') {
            return 'r' + Math.round(colour.red) + ',' +
                   Math.round(colour.green) + ',' + Math.round(colour.blue);
        }
        if (kind === 'CMYKColor') {
            return 'c' + Math.round(colour.cyan) + ',' + Math.round(colour.magenta) +
                   ',' + Math.round(colour.yellow) + ',' + Math.round(colour.black);
        }
        if (kind === 'GrayColor') return 'g' + Math.round(colour.gray);
        if (kind === 'LabColor') {
            return 'l' + Math.round(colour.l) + ',' +
                   Math.round(colour.a) + ',' + Math.round(colour.b);
        }
        if (kind === 'SpotColor') {
            return 's' + String(colour.spot.name) + ':' + Math.round(colour.tint);
        }
        if (kind === 'GradientColor') {
            /*
              The panel refuses to grade a gradient, so a stale one cannot
              produce a wrong number — but it can leave the "sample this"
              notice pointing at the wrong artwork. The end stops are enough
              to notice an edit without walking every stop on every poll.
            */
            var stops = colour.gradient.gradientStops;
            var last = stops.length - 1;
            return 'x' + stops.length + ':' +
                   colourValueStamp(stops[0].color, depth + 1) + ':' +
                   colourValueStamp(stops[last].color, depth + 1);
        }
    } catch (e3) {}

    return kind;
}

/*
  `watch` is a comma-separated list of tokens the panel is currently measuring.

  The selection alone is not enough. The background is found by geometry, not
  selected, so recolouring the card behind the text moved nothing in this
  fingerprint and the panel went on showing the old ratio as a live reading —
  the one thing a poll exists to prevent. Re-running the backdrop search here
  would be far too expensive; the panel already knows which objects it is
  measuring, so it hands their tokens back and they get stamped by direct
  registry lookup, which is O(1).
*/
function wcagSelectionSignature() {
  return guarded('wcagSelectionSignature', function () {
        var doc = activeDoc();
        if (!doc) {
            /*
              No document means every token in the registry addresses art that
              no longer exists. Drop it now rather than leaving it for someone
              to trip over later. Dropping never reads a handle.
            */
            dropRegistry();
            return toJson({ ok: true, sig: 'nodoc' });
        }

        /*
          The document itself is part of the fingerprint. Two open files can hold
          selections with identical shapes and positions, and switching between
          them left the panel showing the other document's reading.
        */
        var stem = 'doc';
        try { stem = String(doc.name) + '#' + app.documents.length; } catch (eDoc) {}

        /*
          A different document is in front. The registry addresses the old one,
          so it goes now, eagerly, instead of waiting for a lookup to notice.
        */
        if (!registryLive(doc)) dropRegistry();

        var sel;
        try { sel = doc.selection; } catch (e) { return toJson({ ok: true, sig: stem + '|err' }); }
        if (!sel) return toJson({ ok: true, sig: stem + '|none' });

        if (String(sel.typename) === 'TextRange') {
            var tag = stem + '|range';
            try { tag += ':' + sel.start + '-' + sel.end + ':' + sel.length; } catch (e2) {}
            try { tag += ':' + colourStamp(sel.story.textFrames[0]); } catch (e2b) {}
            return toJson({ ok: true, sig: tag });
        }

        if (!sel.length) return toJson({ ok: true, sig: stem + '|none' });

        /*
          Everything read below came out of `doc.selection` inside THIS call, so
          every wrapper is freshly resolved and cannot outlive the call that
          made it. That is the entire difference between this loop and the
          watched-token loop that used to follow it, which read wrappers stored
          on a previous call and crashed Illustrator when one of them pointed at
          freed art.

          One geometricBounds read replaces left, top, width and height. Those
          four are derived from VISIBLE bounds, so asking for them made
          Illustrator resolve live effects, strokes and drop shadows on the
          user's selection on every poll, forever, to answer a question that
          only needed to know whether anything had moved.
        */
        var parts = [stem, 'n' + sel.length];
        for (var i = 0; i < sel.length && i < 4; i++) {
            try {
                var it = sel[i];
                var gb = it.geometricBounds;
                parts.push(it.typename + ':' +
                    Math.round(gb[0] * 10) + ',' + Math.round(gb[1] * 10) + ',' +
                    Math.round(gb[2] * 10) + ',' + Math.round(gb[3] * 10) + ':' +
                    Math.round(it.opacity) + ':' +
                    colourStamp(it));
            } catch (e3) {
                parts.push('?');
            }
        }

        return toJson({ ok: true, sig: parts.join('|') });
  });

}

/*
  wcagSelectionSignature used to take a `watch` argument here and stamp the
  colour of each object the panel was measuring, so a background recoloured
  without being selected would refresh the reading instantly.

  It did that by storing item wrappers on one call and reading them on the
  next, which is the one thing this file must never do. Illustrator 30.7
  crashed in it: EXC_BAD_ACCESS reading `.opacity` off a wrapper whose art had
  been freed, inside a try block that could not catch it, dispatched into the
  middle of a mouse click. The feature is worth a second of latency. It is not
  worth someone's unsaved work.

  The panel gets the same result now by re-reading the whole selection on a
  slow heartbeat, which resolves every wrapper fresh. See HEARTBEAT_MS.
*/

/*
  Throw away every stored handle, unconditionally.

  The document-key check closes the ordinary cases: a document closed, a
  different one brought to the front, no document at all. It cannot close one
  narrow case on its own. Close a file and reopen the same file from the same
  path and the key matches again, while every handle behind it points at art
  from the previous open.

  The panel calls this whenever it has not been watching, which is exactly when
  that could have happened without a poll noticing. Dropping costs nothing and
  reads nothing. A token that has gone simply resolves to null, and wcagApply
  then says "reselect and try again" rather than guessing.
*/
function wcagDropHandles() {
  return guarded('wcagDropHandles', function () {
        dropRegistry();
        return toJson({ ok: true });
  });
}

function wcagDocInfo() {
  return guarded('wcagDocInfo', function () {
        var doc = activeDoc();
        if (!doc) return toJson({ ok: false, error: 'No document open.' });

        var space = 'RGB';
        try { space = /rgb/i.test(String(doc.documentColorSpace)) ? 'RGB' : 'CMYK'; } catch (e2) {}

        return toJson({
            ok: true,
            name: String(doc.name),
            colorSpace: space
        });
  });

}

/*
  What is selected, and what sits behind it.
  Returns raw fills plus alpha and blend mode; the panel does the compositing.
*/
function wcagSelection() {
  return guarded('wcagSelection', function () {
        var doc = activeDoc();
        if (!doc) return toJson({ ok: false, error: 'No document open.' });

        // Fresh for this call: cached geometry never outlives the read.
        MASK_BOUNDS = {};

        var shape = { grouped: false, compound: 0 };
        var items = selectedItems(doc, shape);
        if (!items.length) {
            return toJson({ ok: false, empty: true, error: 'Nothing selected.' });
        }

        /*
          Every fill, once.

          Four passes below used to call fillOf on the same items, and
          refuseReason called it a fifth time inside the group loop. On a CMYK
          document each of those is an app.convertSampleColor round trip through
          the colour engine, so Cmd-A over a thousand objects paid for four or
          five thousand conversions on every selection change, on Illustrator's
          main thread, before the panel drew anything. The answer cannot change
          inside a single call, so read it once and hand it around.
        */
        var i;
        var fills = [];
        for (i = 0; i < items.length; i++) fills[i] = fillOf(items[i]);

        // Prefer text as the foreground when the selection mixes types.
        var fgItem = null;
        var fgIndex = -1;
        for (i = 0; i < items.length; i++) {
            if (isTextItem(items[i]) && fills[i].kind === 'solid') { fgItem = items[i]; fgIndex = i; break; }
        }
        if (!fgItem) {
            for (i = 0; i < items.length; i++) {
                if (fills[i].kind === 'solid') { fgItem = items[i]; fgIndex = i; break; }
            }
        }
        if (!fgItem) { fgItem = items[0]; fgIndex = 0; }

        var fgFill = fills[fgIndex];

        /*
          Every colour in the text, not just the first character's. The first
          readable run stands in as the frame's colour for everything that
          needs one; the panel grades the full list. See textRuns.
        */
        var fgRuns = null;
        if (isTextItem(fgItem)) {
            fgRuns = textRuns(fgItem);
            if (fgRuns.list.length) fgFill = { kind: 'solid', rgb: fgRuns.list[0].rgb };
        }

        /*
          What the foreground IS, for the search. Selection flattening hands
          over a compound path as its first subpath, and the compound itself is
          a candidate in the sweep: an icon or an outlined letter with a hole
          was found sitting behind itself, and read 1.00:1.
        */
        var fgOwner = fgItem;
        try {
            if (String(fgItem.parent.typename) === 'CompoundPathItem') fgOwner = fgItem.parent;
        } catch (eOwner) {}
        var fgSkip = [fgItem, fgOwner];

        /*
          Text is written run by run, so a gradient on its first word no longer
          makes the whole frame unwritable; only text with no solid run at all is.
        */
        var fgRefuse = (fgRuns && fgRuns.list.length) ? null : refuseReason(fgItem);

        /*
          A second selected object as the background.

          It used to have to be LARGER than the text, so selecting a text frame
          and the card under it did nothing whenever the frame had been drawn a
          little bigger than the card, which is most of the time. Now the
          selected shapes are weighed exactly the way the automatic search
          weighs the document: the nearest one sitting behind most of the text.
          Only when none overlaps it at all does the old rule apply, so picking
          a text frame and a swatch elsewhere on the page still compares the two.

          Text frames are not backgrounds: their colour is the colour of their
          letters.
        */
        var explicitBg = null;
        var picked = [];
        var largest = null;
        var largestArea = -1;
        for (i = 0; i < items.length; i++) {
            var other = items[i];
            if (other === fgItem || isTextItem(other)) continue;
            if (fills[i].kind === 'none') continue;

            var choice = selectedCandidate(other);
            if (!choice.bounds) continue;
            var masks = false;
            try { masks = other.clipping === true; } catch (eM) {}
            if (masks) {
                choice.clipFill = true;
                // The owner's parent: a compound mask arrives as its subpath.
                try { choice.group = choice.owner.parent; } catch (eGp) {}
            }
            picked.push(choice);

            if (fills[i].kind === 'solid' && choice.area > largestArea) {
                largestArea = choice.area;
                largest = choice;
            }
        }
        if (picked.length) explicitBg = shapeBehind(fgItem, picked, fgSkip);
        if (!explicitBg && largest && largestArea >= areaOf(boundsOf(fgItem))) explicitBg = largest;

        var shapes = candidateShapes(doc);
        var bgCand = explicitBg;
        var autoDetected = false;

        if (!bgCand) {
            /*
              A filled text box is the nearest backdrop there can be: it is part
              of the same object as the letters.
            */
            var own = isTextItem(fgItem) ? textBoxCandidate(fgItem) : null;
            if (own && resolveCandidate(own)) bgCand = own;
            if (!bgCand) bgCand = shapeBehind(fgItem, shapes, fgSkip);
            if (bgCand) autoDetected = true;
        }
        var bgItem = bgCand ? bgCand.item : null;

        clearRegistry(doc);

        // Register the foreground once and reuse the handle. Registering it a
        // second time inside the group loop left two tokens pointing at one
        // object, which inflated the "recoloured N objects" count.
        var fgToken = registerItem(fgItem);

        /*
          Every selected item painted the same colour, so the panel can recolour
          all of them at once instead of a single letter.
        */
        var fgGroup = (function () {
            var group = [];
            /*
              The foreground itself always belongs, whatever its first
              character says: a frame whose leading space carries a stray
              colour would otherwise be left out of its own fix.
            */
            if (!fgRefuse) group.push(fgToken);

            /*
              Any colour in the text, not only the first: the panel may grade
              and fix the second run, and a shape painted that colour belongs
              with it. The write itself skips whatever is not painted the
              colour being replaced.
            */
            var colours = [fgFill.rgb];
            if (fgRuns) {
                for (var r = 0; r < fgRuns.list.length; r++) colours.push(fgRuns.list[r].rgb);
            }
            function anyColour(rgb) {
                for (var k = 0; k < colours.length; k++) {
                    if (sameColour(rgb, colours[k], 2)) return true;
                }
                return false;
            }

            for (var t = 0; t < items.length; t++) {
                var candidate = items[t];
                if (candidate === fgItem) continue;

                var cf = fills[t];
                if (cf.kind !== 'solid') continue;
                if (!anyColour(cf.rgb)) continue;
                if (refuseReason(candidate)) continue;

                group.push(registerItem(candidate));
                if (group.length >= 800) break;
            }
            return group;
        }());

        /*
          Walked once each, then shared. The chain is the expensive part of a
          colour reading — every alpha, blend and note below is derived from
          these two arrays rather than from another walk up the tree.
        */
        var fgChain = appearanceChain(fgItem);
        // A text box takes its opacity from its frame, so the chain is the
        // frame's: shared with the letters, applied once.
        var bgChain = bgCand ? appearanceChain(bgCand.owner) : [];

        var payload = {
            ok: true,
            selectionCount: items.length,
            autoBackground: autoDetected,
            foreground: {
                token: fgToken,
                label: describe(fgItem),
                kind: fgFill.kind,
                rgb: fgFill.rgb,
                alpha: alphaOfChain(fgChain),
                /*
                  What to composite the text with when the background it is drawn
                  over has ALREADY been faded by the same containers. A group's
                  65% applies to the group's rendered result once, not once per
                  item inside it.
                */
                alphaOverBackground: unsharedAlpha(fgChain, bgChain),
                blend: blendOfChain(fgChain),
                // The blend NOT already carried by the shared layer. Sending the
                // whole-chain blend for both made a shared Multiply apply twice.
                blendOverBackground: unsharedBlend(fgChain, bgChain),
                appearance: fgChain,
                tokens: fgGroup,
                /*
                  Shaped like outlined type: not a text frame, inside a group,
                  holding compound paths, three or more shapes in one colour.
                  An icon set can match too, which is why the panel ASKS rather
                  than reclassifying anything on the strength of this.
                */
                outlineLike: !isTextItem(fgItem) && shape.grouped &&
                             shape.compound > 0 && fgGroup.length >= 3,
                refuse: fgRefuse,
                isText: isTextItem(fgItem),
                pointSize: isTextItem(fgItem) ? pointSize(fgItem) : 0,
                authoredPointSize: isTextItem(fgItem) ? authoredPointSize(fgItem) : 0,
                bold: isTextItem(fgItem) ? isBoldFont(fgItem) : false,
                sizeClass: sizeClassOf(fgItem),
                /*
                  Present only when the text holds more than one colour, size
                  or weight. The panel grades each against its own threshold
                  and reports the weakest.
                */
                runs: (fgRuns && fgRuns.list.length > 1) ? fgRuns.list : null,
                // Runs painted with a gradient or pattern, which nothing graded.
                unreadableRuns: fgRuns ? fgRuns.unreadable : 0,
                // Too many styles to read them all: the verdict covers a sample.
                runsPartial: fgRuns ? fgRuns.partial : false
            },
            background: null,
            backdrops: [],
            // The containers the two colours have in common. Applied once, to
            // both, after everything inside them has been resolved.
            shared: sharedAppearance(fgChain, bgChain)
        };

        if (bgCand) {
            var bgFill = fillOf(bgItem);
            payload.background = {
                token: registerItem(bgItem),
                label: candidateLabel(bgCand),
                kind: bgFill.kind,
                rgb: bgFill.rgb,
                // Present only for a gradient, and the reason the panel can
                // grade one at all: the worst stop is the honest verdict.
                stops: bgFill.stops || null,
                stopsMissed: (bgFill.stops && bgFill.stops.missed) || 0,
                alpha: alphaOfChain(bgChain),
                alphaOverBackground: unsharedAlpha(bgChain, fgChain),
                blend: blendOfChain(bgChain),
                blendOverBackground: unsharedBlend(bgChain, fgChain),
                appearance: bgChain
            };
            payload.backdrops = backdropStack(bgCand, shapes, 4);
        }

        return toJson(payload);
  });

}

/*
  `fromHex`, when given, is the colour being replaced. Text frames recolour only
  the runs painted that colour, so a frame holding two colours keeps the one
  the fix was not about. Shapes ignore it.
*/
function wcagApply(tokenList, hex, fromHex) {
  return guarded('wcagApply', function () {
    var doc = activeDoc();
    if (!doc) return toJson({ ok: false, error: 'No document open.' });

    var rgb = hexToRgb(hex);
    if (!rgb) return toJson({ ok: false, error: 'Bad colour value.' });
    var fromRgb = fromHex ? hexToRgb(fromHex) : null;

    var tokens = String(tokenList).split(',');
    var colour = buildColour(doc, rgb);

    var objects = 0;
    var subpaths = 0;
    var refused = null;
    var errors = 0;
    var seen = {};

    for (var i = 0; i < tokens.length; i++) {
        var token = trimToken(tokens[i]);
        if (!token) continue;

        // Writing the same object twice would double the reported count and
        // tell the user "recoloured 2 objects" for a single shape.
        if (seen[token]) continue;
        seen[token] = true;

        var item = lookupItem(token, doc);
        if (!item) continue;

        // A text frame written run by run never touches its gradient runs, so
        // a gradient on one word is no reason to refuse the rest.
        var why = (fromRgb && isTextItem(item)) ? null : refuseReason(item);
        if (why) { if (!refused) refused = why; continue; }

        try {
            var wrote = applyFillToItem(item, colour, fromRgb);
            // A text frame with no run in the old colour has nothing to change.
            if (wrote > 0) {
                subpaths += wrote;
                objects++;
            }
        } catch (e) {
            errors++;
        }
    }

    if (!objects) {
        return toJson({
            ok: false,
            error: refused
                ? ('Can\'t recolour ' + refused + '.')
                : 'Those objects are no longer available. Reselect and try again.'
        });
    }

    // Deliberately no app.redraw(); forcing a repaint from inside evalScript is
    // a known instability source and Illustrator repaints on its own.
    return toJson({
        ok: true,
        applied: String(hex),
        objects: objects,
        subpaths: subpaths,
        skipped: refused,
        errors: errors
    });
  });
}

function trimToken(t) {
    return String(t).replace(/^\s+/, '').replace(/\s+$/, '');
}

/*
  HOLDING THE SELECTION ACROSS A PICK

  The eyedropper detects a real click anywhere on screen — which is what makes
  it feel like a colour picker rather than a keyboard shortcut. But the panel
  cannot swallow that click: it reaches Illustrator too, and with the Selection
  tool active it selects whatever is underneath, throwing away what the designer
  had selected in order to measure it.

  A native app avoids this with a transparent overlay window that eats the
  click. A CEP panel has no such window. So instead of preventing the click,
  undo what it did: remember the selection when the eyedropper is armed, put it
  back after the pick. Selection changes are not undo steps, so this leaves no
  trace in the history.

  (A click still reaches a DRAWING tool, which will draw. Nothing here can stop
  that, and the panel says so rather than pretending otherwise.)
*/
function wcagHoldSelection() {
  return guarded('wcagHoldSelection', function () {
        var doc = activeDoc();
        if (!doc) return toJson({ ok: false, error: 'No document open.' });

        var held = [];
        var isRange = false;

        try {
            var sel = doc.selection;
            if (sel && String(sel.typename) === 'TextRange') {
                // A text cursor is not an item list and cannot be re-applied
                // the same way. Note it and leave it alone.
                isRange = true;
            } else if (sel && sel.length) {
                for (var i = 0; i < sel.length; i++) held.push(sel[i]);
            }
        } catch (e) {}

        $.global.WCAG_HELD = held;
        $.global.WCAG_HELD_RANGE = isRange;
        // Which document these items belong to. A screen-wide click can land in
        // a different Illustrator window, and putting document A's selection
        // into document B is worse than not restoring at all.
        $.global.WCAG_HELD_DOC = docKey(doc);

        return toJson({ ok: true, count: held.length, textRange: isRange });
  });
}

function docKey(doc) {
    var name = '';
    try { name = String(doc.name); } catch (e) {}
    var path = '';
    try { path = String(doc.fullName); } catch (e2) {}
    return name + '|' + path;
}

function wcagReleaseSelection() {
  return guarded('wcagReleaseSelection', function () {
        var held = $.global.WCAG_HELD || [];
        var isRange = $.global.WCAG_HELD_RANGE;
        var heldDoc = $.global.WCAG_HELD_DOC;

        /*
          Forget it first, whatever happens next.

          The hold/release pair is driven by a click the panel only infers, so
          the two can get out of step — a release arriving twice, or with no hold
          before it. Left in place, the stale list made the SECOND release
          re-select items the user had since deselected by hand, which reads as
          the panel fighting them for control of the selection.
        */
        $.global.WCAG_HELD = null;
        $.global.WCAG_HELD_RANGE = false;
        $.global.WCAG_HELD_DOC = '';

        var doc = activeDoc();
        if (!doc) return toJson({ ok: false, error: 'No document open.' });

        if (isRange) {
            // Nothing safe to restore; better to leave the document alone than
            // to guess at where the text cursor was.
            return toJson({ ok: true, restored: 0, skipped: 'text cursor' });
        }
        if (!held.length) return toJson({ ok: true, restored: 0, held: 0 });

        // The click moved to another document. Its selection is not ours to
        // clear, and these items are not its to hold.
        if (heldDoc && heldDoc !== docKey(doc)) {
            return toJson({ ok: true, restored: 0, held: held.length,
                            skipped: 'a different document is in front' });
        }

        var restored = 0;
        try {
            doc.selection = null;
            for (var i = 0; i < held.length; i++) {
                try {
                    var probe = held[i].typename;   // still in the document?
                    held[i].selected = true;
                    restored++;
                } catch (e) {}
            }
        } catch (e2) {
            return toJson({ ok: false, error: e2.message });
        }

        return toJson({ ok: true, restored: restored, held: held.length });
  });
}

