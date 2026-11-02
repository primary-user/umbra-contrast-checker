/*
  Umbra Contrast Checker — colour engine
  Copyright (c) 2026 Artchemy Labs LLC. All rights reserved.
  Use of this file is governed by the licence in LICENSE at the root of this
  project. Not for redistribution.

  Pure functions. No DOM, no Illustrator, no dependencies. Runs identically in
  the panel and in Node, which is what makes it testable outside Illustrator.

  Every algorithm here is an implementation of a published specification:
    - Relative luminance and contrast ratio ....... W3C WCAG 2.1/2.2
    - sRGB transfer function and XYZ matrices .... IEC 61966-2-1 / sRGB
    - CIELAB conversion .......................... CIE 15
    - Delta E CIEDE2000 .......................... CIE 142-2001
    - Separable + non-separable blend modes ...... W3C Compositing and Blending
    - Source-over alpha compositing .............. Porter & Duff, 1984
*/

(function (root, factory) {
    var api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.WCAGColor = api;
}(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    var THRESHOLDS = {
        aaNormal: 4.5,
        aaLarge: 3.0,
        aaaNormal: 7.0,
        aaaLarge: 4.5,
        nonText: 3.0
    };

    var PAPER = [255, 255, 255];

    // -----------------------------------------------------------------------
    // Basics
    // -----------------------------------------------------------------------

    function clamp(v, lo, hi) {
        return v < lo ? lo : (v > hi ? hi : v);
    }

    function clamp255(v) {
        return clamp(Math.round(v), 0, 255);
    }

    function toHex(rgb) {
        var out = '#';
        for (var i = 0; i < 3; i++) {
            var h = clamp255(rgb[i]).toString(16).toUpperCase();
            out += h.length < 2 ? '0' + h : h;
        }
        return out;
    }

    function fromHex(hex) {
        var h = String(hex).replace(/^#/, '').trim();
        if (h.length === 3) {
            h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
        }
        if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
        return [
            parseInt(h.substring(0, 2), 16),
            parseInt(h.substring(2, 4), 16),
            parseInt(h.substring(4, 6), 16)
        ];
    }

    // -----------------------------------------------------------------------
    // HSB / HSV — standard cylindrical transform of RGB
    // -----------------------------------------------------------------------

    function rgbToHsb(rgb) {
        var r = rgb[0] / 255, g = rgb[1] / 255, b = rgb[2] / 255;
        var max = Math.max(r, g, b);
        var min = Math.min(r, g, b);
        var span = max - min;
        var hue;

        if (span === 0) hue = 0;
        else if (max === r) hue = 60 * (((g - b) / span) % 6);
        else if (max === g) hue = 60 * ((b - r) / span + 2);
        else hue = 60 * ((r - g) / span + 4);

        if (hue < 0) hue += 360;

        return [hue, max === 0 ? 0 : (span / max) * 100, max * 100];
    }

    function hsbToRgb(hsb) {
        var h = hsb[0] / 60, s = hsb[1] / 100, v = hsb[2] / 100;
        var sector = Math.floor(h) % 6;
        var frac = h - Math.floor(h);

        var p = v * (1 - s);
        var q = v * (1 - s * frac);
        var t = v * (1 - s * (1 - frac));
        var triple;

        switch (sector) {
            case 0: triple = [v, t, p]; break;
            case 1: triple = [q, v, p]; break;
            case 2: triple = [p, v, t]; break;
            case 3: triple = [p, q, v]; break;
            case 4: triple = [t, p, v]; break;
            default: triple = [v, p, q]; break;
        }

        return [clamp255(triple[0] * 255), clamp255(triple[1] * 255), clamp255(triple[2] * 255)];
    }

    // -----------------------------------------------------------------------
    // WCAG contrast
    // -----------------------------------------------------------------------

    function channelLuminance(value255) {
        var c = value255 / 255;
        return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    }

    function relativeLuminance(rgb) {
        return 0.2126 * channelLuminance(rgb[0]) +
               0.7152 * channelLuminance(rgb[1]) +
               0.0722 * channelLuminance(rgb[2]);
    }

    function contrastRatio(a, b) {
        var la = relativeLuminance(a);
        var lb = relativeLuminance(b);
        var hi = Math.max(la, lb);
        var lo = Math.min(la, lb);
        return (hi + 0.05) / (lo + 0.05);
    }

    /*
      The WORST contrast against a set of colours.

      A gradient is not one colour, and averaging it is the wrong question:
      text over a light-to-dark ramp averages to mid-grey, so black text would
      "pass" against that average while being invisible at the dark end. WCAG
      asks the ratio to hold EVERYWHERE the text sits, so the number that
      matters is the worst one.

      Accepts a bare rgb triple too, so every caller that measures against a
      single solid keeps working unchanged.
    */
    function asList(other) {
        if (!other) return [];
        return (typeof other[0] === 'number') ? [other] : other;
    }

    /*
      A gradient is a PATH through colour, not a set of stops.

      Grading only the stops is right when the text is lighter than every stop,
      or darker than every stop. It is wrong when the text's luminance falls
      between two of them, because the gradient then passes through the text's
      own luminance somewhere in between and the text vanishes there. #767676
      text on a white to black ramp measured 4.54:1 against its stops, an AA
      pass, while sitting at exactly 1.00:1 a little past halfway along.

      It is also wrong without a crossing. Illustrator mixes gradient colours in
      gamma-encoded RGB, and luminance is convex in those values, so a red to
      green ramp is darker in the middle than at either end. Black text on it is
      worse in the middle than the stops admit.

      So a gradient is sampled along each segment between neighbouring stops,
      and the list that comes back is marked `isPath`. contrastAgainstAll and
      contrastRange read that mark and treat neighbours as connected: if two
      neighbours sit on opposite sides of the candidate's luminance, the path
      crosses it exactly between them and the worst ratio there is exactly 1.00.
      That makes the crossing case exact rather than merely close, and the
      sampling handles the convex case.

      Stop midpoints move WHERE along a segment each colour falls, never which
      colours the segment passes through, so they do not change the answer and
      are not read. Stops are put in ramp order first, by `rampPoint` when the
      host sends it, so a gradient whose stops were dragged past each other is
      still walked in the order it is painted.
    */
    /*
      What counts as LARGE text depends on the medium.

      WCAG's 18pt and 14pt bold are CSS points, which its Understanding page for
      1.4.3 converts at 1pt = 1.333px: about 24px and 18.66px. Illustrator web
      documents treat one pixel as one point, so 18 units of type in an RGB
      layout is 18 CSS px, which is 13.5pt, which is body text. Grading it as
      large let 3:1 through where 4.5:1 is required.

      In print a point is a point, and 18 and 14 bold are the literal reading.
    */
    var LARGE_TEXT = {
        screen: { regular: 24, bold: 18.66 },
        print:  { regular: 18, bold: 14 }
    };

    function sizeClassFor(size, bold, medium) {
        var t = LARGE_TEXT[medium] || LARGE_TEXT.screen;
        if (!(size > 0)) return 'normal';
        if (size >= t.regular) return 'large';
        if (bold && size >= t.bold) return 'large';
        return 'normal';
    }

    var GRADIENT_STEPS = 32;     // per segment, for an ordinary two or three stop ramp
    var GRADIENT_BUDGET = 256;   // samples across the whole gradient, at most

    function orderedStops(stops) {
        var list = [];
        if (!stops) return list;
        for (var i = 0; i < stops.length; i++) {
            var s = stops[i];
            if (!s || !s.rgb) continue;
            list.push({
                rgb: s.rgb,
                alpha: (typeof s.alpha === 'number') ? s.alpha : 1,
                at: (typeof s.rampPoint === 'number') ? s.rampPoint : i,
                order: i
            });
        }
        list.sort(function (a, b) { return (a.at - b.at) || (a.order - b.order); });
        return list;
    }

    function gradientSamples(stops, steps) {
        var list = orderedStops(stops);
        var out = [];
        if (!list.length) return out;
        if (list.length === 1) {
            out.push({ rgb: list[0].rgb.slice(), alpha: list[0].alpha });
            return out;
        }
        /*
          A budget, not a fixed density. The sliders re-grade every candidate
          colour against this list on every drag event, so a 24 stop gradient at
          32 samples a segment would be several hundred thousand luminance
          calculations a frame. Crossings are caught exactly at any density, so
          spending the budget evenly costs nothing that matters: a gradient with
          many stops has short segments, and short segments need few samples.
        */
        if (!(steps > 0)) {
            steps = Math.floor(GRADIENT_BUDGET / (list.length - 1));
            if (steps > GRADIENT_STEPS) steps = GRADIENT_STEPS;
            if (steps < 4) steps = 4;
        }
        steps = Math.floor(steps);
        for (var k = 0; k < list.length - 1; k++) {
            var a = list[k], b = list[k + 1];
            for (var s = 0; s < steps; s++) {
                var t = s / steps;
                out.push({
                    rgb: [a.rgb[0] + (b.rgb[0] - a.rgb[0]) * t,
                          a.rgb[1] + (b.rgb[1] - a.rgb[1]) * t,
                          a.rgb[2] + (b.rgb[2] - a.rgb[2]) * t],
                    alpha: a.alpha + (b.alpha - a.alpha) * t
                });
            }
        }
        var last = list[list.length - 1];
        out.push({ rgb: last.rgb.slice(), alpha: last.alpha });
        return out;
    }

    // Mark a list of colours as consecutive points along one gradient.
    function asPath(colours) {
        colours.isPath = true;
        colours.lum = null;   // filled on first use, then reused for every candidate
        return colours;
    }

    // Each sample's luminance, computed once per path rather than once per candidate.
    function pathLuminance(list) {
        if (!list.lum || list.lum.length !== list.length) {
            var lum = [];
            for (var i = 0; i < list.length; i++) lum.push(list[i] ? relativeLuminance(list[i]) : null);
            list.lum = lum;
        }
        return list.lum;
    }

    // Does the path pass through the candidate's luminance between two neighbours?
    function pathCrosses(candidate, list) {
        if (!list.isPath || list.length < 2) return false;
        var lum = pathLuminance(list);
        var l = relativeLuminance(candidate);
        var prev = lum[0] === null ? null : lum[0] - l;
        for (var i = 1; i < list.length; i++) {
            if (lum[i] === null) { prev = null; continue; }
            var here = lum[i] - l;
            if (prev !== null && prev * here <= 0) return true;
            prev = here;
        }
        return false;
    }

    function contrastAgainstAll(candidate, other) {
        var list = asList(other);
        if (!list.length) return 0;
        // Equal luminance is the definition of 1:1, and the path reaches it.
        if (pathCrosses(candidate, list)) return 1;

        var worst = Infinity;
        for (var i = 0; i < list.length; i++) {
            if (!list[i]) continue;
            var ratio = contrastRatio(candidate, list[i]);
            if (ratio < worst) worst = ratio;
        }
        return worst === Infinity ? 0 : worst;
    }

    // The full picture: worst and best across the set, for reporting a range.
    function contrastRange(candidate, other) {
        var list = asList(other);
        var worst = Infinity, best = 0;
        for (var i = 0; i < list.length; i++) {
            if (!list[i]) continue;
            var ratio = contrastRatio(candidate, list[i]);
            if (ratio < worst) worst = ratio;
            if (ratio > best) best = ratio;
        }
        if (worst === Infinity) return null;
        if (pathCrosses(candidate, list)) worst = 1;
        return { worst: worst, best: best, spread: best - worst };
    }

    /*
      Black or white, whichever actually reads on this background.

      A luminance cut-off is the usual shortcut, but it picks the wrong ink in a
      band around mid-grey — and a contrast tool printing an unreadable label on
      its own swatch is not a good look. Ask the same question we ask of the
      user's artwork.
    */
    function readableInk(rgb) {
        return contrastRatio([0, 0, 0], rgb) >= contrastRatio([255, 255, 255], rgb)
            ? [0, 0, 0]
            : [255, 255, 255];
    }

    // -----------------------------------------------------------------------
    // CIELAB and Delta E CIEDE2000
    // -----------------------------------------------------------------------

    function srgbToLinear(value255) {
        var c = value255 / 255;
        return c > 0.04045 ? Math.pow((c + 0.055) / 1.055, 2.4) : c / 12.92;
    }

    function labPivot(t) {
        return t > 0.008856 ? Math.pow(t, 1 / 3) : (7.787 * t) + (16 / 116);
    }

    function rgbToLab(rgb) {
        var r = srgbToLinear(rgb[0]);
        var g = srgbToLinear(rgb[1]);
        var b = srgbToLinear(rgb[2]);

        var x = (r * 0.4124564 + g * 0.3575761 + b * 0.1804375) / 0.95047;
        var y = (r * 0.2126729 + g * 0.7151522 + b * 0.0721750) / 1.00000;
        var z = (r * 0.0193339 + g * 0.1191920 + b * 0.9503041) / 1.08883;

        var fx = labPivot(x), fy = labPivot(y), fz = labPivot(z);

        return { L: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) };
    }

    function toRad(deg) { return deg * Math.PI / 180; }
    function toDeg(rad) { return rad * 180 / Math.PI; }

    function deltaE2000(rgbA, rgbB) {
        var one = rgbToLab(rgbA);
        var two = rgbToLab(rgbB);

        var c1 = Math.sqrt(one.a * one.a + one.b * one.b);
        var c2 = Math.sqrt(two.a * two.a + two.b * two.b);
        var cMean = (c1 + c2) / 2;

        var cMean7 = Math.pow(cMean, 7);
        var g = 0.5 * (1 - Math.sqrt(cMean7 / (cMean7 + Math.pow(25, 7))));

        var a1p = (1 + g) * one.a;
        var a2p = (1 + g) * two.a;

        var c1p = Math.sqrt(a1p * a1p + one.b * one.b);
        var c2p = Math.sqrt(a2p * a2p + two.b * two.b);

        var h1p = (one.b === 0 && a1p === 0) ? 0 : toDeg(Math.atan2(one.b, a1p));
        if (h1p < 0) h1p += 360;
        var h2p = (two.b === 0 && a2p === 0) ? 0 : toDeg(Math.atan2(two.b, a2p));
        if (h2p < 0) h2p += 360;

        var dLp = two.L - one.L;
        var dCp = c2p - c1p;

        var dhp;
        if (c1p * c2p === 0) dhp = 0;
        else if (Math.abs(h2p - h1p) <= 180) dhp = h2p - h1p;
        else if (h2p - h1p > 180) dhp = h2p - h1p - 360;
        else dhp = h2p - h1p + 360;

        var dHp = 2 * Math.sqrt(c1p * c2p) * Math.sin(toRad(dhp) / 2);

        var lMean = (one.L + two.L) / 2;
        var cpMean = (c1p + c2p) / 2;

        var hpMean;
        if (c1p * c2p === 0) hpMean = h1p + h2p;
        else if (Math.abs(h1p - h2p) <= 180) hpMean = (h1p + h2p) / 2;
        else if (h1p + h2p < 360) hpMean = (h1p + h2p + 360) / 2;
        else hpMean = (h1p + h2p - 360) / 2;

        var tTerm = 1
            - 0.17 * Math.cos(toRad(hpMean - 30))
            + 0.24 * Math.cos(toRad(2 * hpMean))
            + 0.32 * Math.cos(toRad(3 * hpMean + 6))
            - 0.20 * Math.cos(toRad(4 * hpMean - 63));

        var deltaTheta = 30 * Math.exp(-Math.pow((hpMean - 275) / 25, 2));
        var cpMean7 = Math.pow(cpMean, 7);
        var rc = 2 * Math.sqrt(cpMean7 / (cpMean7 + Math.pow(25, 7)));
        var lOffset = Math.pow(lMean - 50, 2);

        var sl = 1 + (0.015 * lOffset) / Math.sqrt(20 + lOffset);
        var sc = 1 + 0.045 * cpMean;
        var sh = 1 + 0.015 * cpMean * tTerm;
        var rt = -Math.sin(toRad(2 * deltaTheta)) * rc;

        var termL = dLp / sl;
        var termC = dCp / sc;
        var termH = dHp / sh;

        return Math.sqrt(termL * termL + termC * termC + termH * termH + rt * termC * termH);
    }

    // -----------------------------------------------------------------------
    // Blend modes — W3C Compositing and Blending Level 1
    // -----------------------------------------------------------------------

    function blendChannel(mode, cb, cs) {
        switch (mode) {
            case 'multiply':
                return cb * cs;
            case 'screen':
                return cb + cs - cb * cs;
            case 'overlay':
                return blendChannel('hardlight', cs, cb);
            case 'darken':
                return Math.min(cb, cs);
            case 'lighten':
                return Math.max(cb, cs);
            case 'colordodge':
                if (cb === 0) return 0;
                if (cs === 1) return 1;
                return Math.min(1, cb / (1 - cs));
            case 'colorburn':
                if (cb === 1) return 1;
                if (cs === 0) return 0;
                return 1 - Math.min(1, (1 - cb) / cs);
            case 'hardlight':
                return cs <= 0.5
                    ? blendChannel('multiply', cb, 2 * cs)
                    : blendChannel('screen', cb, 2 * cs - 1);
            case 'softlight':
                var d = cb <= 0.25 ? ((16 * cb - 12) * cb + 4) * cb : Math.sqrt(cb);
                return cs <= 0.5
                    ? cb - (1 - 2 * cs) * cb * (1 - cb)
                    : cb + (2 * cs - 1) * (d - cb);
            case 'difference':
                return Math.abs(cb - cs);
            case 'exclusion':
                return cb + cs - 2 * cb * cs;
            default:
                return cs;
        }
    }

    function luma(c) {
        return 0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2];
    }

    function clipColour(c) {
        var l = luma(c);
        var lo = Math.min(c[0], c[1], c[2]);
        var hi = Math.max(c[0], c[1], c[2]);
        var i;

        if (lo < 0) {
            for (i = 0; i < 3; i++) {
                c[i] = (l - lo === 0) ? l : l + ((c[i] - l) * l) / (l - lo);
            }
        }
        if (hi > 1) {
            for (i = 0; i < 3; i++) {
                c[i] = (hi - l === 0) ? l : l + ((c[i] - l) * (1 - l)) / (hi - l);
            }
        }
        return c;
    }

    function setLuma(c, target) {
        var d = target - luma(c);
        return clipColour([c[0] + d, c[1] + d, c[2] + d]);
    }

    function saturation(c) {
        return Math.max(c[0], c[1], c[2]) - Math.min(c[0], c[1], c[2]);
    }

    function setSaturation(c, target) {
        var order = [0, 1, 2].sort(function (x, y) { return c[x] - c[y]; });
        var lo = order[0], mid = order[1], hi = order[2];
        var out = [0, 0, 0];

        if (c[hi] > c[lo]) {
            out[mid] = ((c[mid] - c[lo]) * target) / (c[hi] - c[lo]);
            out[hi] = target;
        }
        out[lo] = 0;
        return out;
    }

    function blend(mode, backdrop255, source255) {
        var cb = [backdrop255[0] / 255, backdrop255[1] / 255, backdrop255[2] / 255];
        var cs = [source255[0] / 255, source255[1] / 255, source255[2] / 255];
        var out;

        switch (mode) {
            case 'hue':
                out = setLuma(setSaturation(cs, saturation(cb)), luma(cb));
                break;
            case 'saturation':
                out = setLuma(setSaturation(cb, saturation(cs)), luma(cb));
                break;
            case 'colorblend':
                out = setLuma(cs, luma(cb));
                break;
            case 'luminosity':
                out = setLuma(cb, luma(cs));
                break;
            default:
                out = [
                    blendChannel(mode, cb[0], cs[0]),
                    blendChannel(mode, cb[1], cs[1]),
                    blendChannel(mode, cb[2], cs[2])
                ];
        }

        return [clamp255(out[0] * 255), clamp255(out[1] * 255), clamp255(out[2] * 255)];
    }

    // -----------------------------------------------------------------------
    // Compositing
    // -----------------------------------------------------------------------

    // Source-over against an opaque backdrop:
    //   Co = as * B(Cb, Cs) + (1 - as) * Cb
    function composite(source255, alpha, mode, backdrop255) {
        if (!mode) mode = 'normal';
        if (alpha === undefined || alpha === null) alpha = 1;

        if (alpha >= 0.999 && mode === 'normal') return source255.slice();
        if (alpha <= 0.001) return backdrop255.slice();

        var mixed = blend(mode, backdrop255, source255);
        return [
            clamp255(alpha * mixed[0] + (1 - alpha) * backdrop255[0]),
            clamp255(alpha * mixed[1] + (1 - alpha) * backdrop255[1]),
            clamp255(alpha * mixed[2] + (1 - alpha) * backdrop255[2])
        ];
    }

    /*
      Resolve what a layer actually renders as.

      `stack` is the list of shapes sitting behind it, innermost first, as the
      host reports it. We composite from the outermost inward, starting on paper.
    */
    function renderedColour(layer, stack, paper) {
        var base = (paper || PAPER).slice();
        if (!layer || !layer.rgb) return base;

        if (stack && stack.length) {
            for (var i = stack.length - 1; i >= 0; i--) {
                var s = stack[i];
                if (!s || !s.rgb) continue;
                base = composite(s.rgb, s.alpha, s.blend, base);
            }
        }

        return composite(layer.rgb, layer.alpha, layer.blend, base);
    }

    /*
      Text and its background, resolved together.

      A container both of them sit inside is composited ONCE — Illustrator draws
      the group into its own buffer and puts that buffer down at the group's
      opacity. Treating the group as if it faded each item separately gets the
      foreground wrong in whichever direction happens to flatter the artwork:

        black text on #808080, both inside a group at 65% over white paper
          Illustrator      #595959 on #ACACAC   3.08:1   fail
          65% charged twice #3C3C3C on #ACACAC   4.86:1   "pass"
          65% dropped       #000000 on #ACACAC   9.25:1   "pass"

      So resolve both colours inside the shared container, then put the pair
      through that container once, over whatever sits behind it.

      `shared` may be absent — an older host, or artwork with nothing in common —
      in which case this reduces exactly to renderedColour().
    */
    /*
      Everything behind the shared container: paper with the backdrop stack
      composited onto it. The container is drawn ONTO this, so the stack must not
      also be dragged through it.
    */
    function baseUnder(stack, paper) {
        var base = (paper || PAPER).slice();
        if (stack && stack.length) {
            for (var i = stack.length - 1; i >= 0; i--) {
                var s = stack[i];
                if (!s || !s.rgb) continue;
                base = composite(s.rgb, s.alpha, s.blend, base);
            }
        }
        return base;
    }

    function renderedPair(fg, bg, stack, shared, paper) {
        var base = baseUnder(stack, paper);

        var sharedAlpha = (shared && typeof shared.alpha === 'number') ? shared.alpha : 1;
        var sharedBlend = (shared && shared.blend) || 'normal';

        var innerBg = (bg && bg.rgb)
            ? composite(bg.rgb, unsharedAlphaOf(bg), unsharedBlendOf(bg), base)
            : base;
        var innerFg = (fg && fg.rgb)
            ? composite(fg.rgb, unsharedAlphaOf(fg), unsharedBlendOf(fg), innerBg)
            : innerBg;

        return {
            fg: composite(innerFg, sharedAlpha, sharedBlend, base),
            bg: composite(innerBg, sharedAlpha, sharedBlend, base)
        };
    }

    // The part of a layer's opacity that is not already accounted for by the
    // shared container. Hosts older than 1.3 send only the total.
    function unsharedAlphaOf(layer) {
        if (!layer) return 1;
        if (typeof layer.alphaOverBackground === 'number') return layer.alphaOverBackground;
        return (typeof layer.alpha === 'number') ? layer.alpha : 1;
    }

    /*
      Same question for the blend mode, and it matters just as much.

      A blend set on the shared container belongs to the shared layer. Sending
      the whole-chain blend for the foreground as well made it apply twice:
      #555555 on #A0A0A0 inside a Multiply group renders exactly as authored,
      2.85:1 and a failure, and the panel reported 4.69 with a green tick.
    */
    function unsharedBlendOf(layer) {
        if (!layer) return 'normal';
        if (typeof layer.blendOverBackground === 'string') return layer.blendOverBackground;
        return layer.blend || 'normal';
    }

    /*
      The inverse problem. Swatches are RENDERED colours, but Illustrator stores
      the AUTHORED fill. On a semi-transparent object those differ, so solve:

          rendered = a * raw + (1 - a) * backdrop
          raw      = (rendered - (1 - a) * backdrop) / a

      Some targets are unreachable: 50% of anything over white can never render
      darker than mid grey.
    */
    function solveAuthoredFill(target255, alpha, mode, backdrop255) {
        if (!mode) mode = 'normal';
        if (alpha === undefined || alpha === null) alpha = 1;

        if (alpha >= 0.999 && mode === 'normal') {
            return { ok: true, rgb: target255.slice(), reason: '' };
        }
        if (mode !== 'normal') {
            return { ok: false, rgb: target255.slice(), reason: 'blend' };
        }
        if (alpha <= 0.02) {
            return { ok: false, rgb: target255.slice(), reason: 'invisible' };
        }

        var out = [];
        for (var i = 0; i < 3; i++) {
            var v = (target255[i] - (1 - alpha) * backdrop255[i]) / alpha;
            if (v < -0.5 || v > 255.5) {
                return { ok: false, rgb: target255.slice(), reason: 'unreachable' };
            }
            out.push(clamp255(v));
        }
        return { ok: true, rgb: out, reason: '' };
    }

    /*
      The inverse of renderedPair: what fill do I write so that ONE side of the
      pair renders as `target`?

      Two nested inversions, because there are two compositing steps. Solving
      only the item's own layer, against the already-rendered background, was
      wrong in both directions at once — it ignored the shared container and it
      used a backdrop the item is not actually drawn on. On the file's own worked
      example the panel offered "#404040 · 4.56:1", wrote #060606 to the artwork,
      and produced #5D5D5D — 2.90:1, WORSE than the 3.08 it started from. The
      honest answer there is `unreachable`.

      `which` is 'fg' or 'bg'.
    */
    function solveForPair(target255, which, fg, bg, stack, shared, paper) {
        var base = baseUnder(stack, paper);
        var sharedAlpha = (shared && typeof shared.alpha === 'number') ? shared.alpha : 1;
        var sharedBlend = (shared && shared.blend) || 'normal';

        // Undo the shared container: what must the group's own buffer hold?
        var inner = solveAuthoredFill(target255, sharedAlpha, sharedBlend, base);
        if (!inner.ok) return inner;

        // The foreground is drawn over the background as it exists INSIDE the
        // container; the background is drawn straight onto the base.
        var over = base;
        if (which === 'fg' && bg && bg.rgb) {
            over = composite(bg.rgb, unsharedAlphaOf(bg), unsharedBlendOf(bg), base);
        }

        var layer = (which === 'fg') ? fg : bg;
        return solveAuthoredFill(inner.rgb, unsharedAlphaOf(layer), unsharedBlendOf(layer), over);
    }

    // -----------------------------------------------------------------------
    // Grading
    // -----------------------------------------------------------------------

    /*
      Display rounding must never flatter the artwork.

      toFixed() rounds to nearest, so a ratio of 4.4996 printed "4.50" — a number
      the reader checks against the 4.5 threshold and reads as a pass, while the
      matrix beside it correctly said Fail. Truncate instead: the printed figure
      is then always a value the artwork genuinely reaches.
    */
    function displayRatio(ratio, places) {
        if (typeof places !== 'number') places = 2;
        if (!isFinite(ratio)) return '·';
        var factor = Math.pow(10, places);
        return (Math.floor(ratio * factor) / factor).toFixed(places);
    }

    // sizeClass: 'normal' | 'large' | 'graphic'
    //
    // Non-text contrast is WCAG 1.4.11, which exists only at AA — there is no
    // AAA tier for icons. Returning 'AA' rather than 'Pass' keeps every grade in
    // one vocabulary, so callers can print "passes AA" without special cases.
    function gradeFor(ratio, sizeClass) {
        if (sizeClass === 'graphic') return ratio >= THRESHOLDS.nonText ? 'AA' : 'Fail';
        if (sizeClass === 'large') {
            if (ratio >= THRESHOLDS.aaaLarge) return 'AAA';
            if (ratio >= THRESHOLDS.aaLarge) return 'AA';
            return 'Fail';
        }
        if (ratio >= THRESHOLDS.aaaNormal) return 'AAA';
        if (ratio >= THRESHOLDS.aaNormal) return 'AA';
        return 'Fail';
    }

    /*
      Does this clear the level the user actually asked for?

      gradeFor() answers "what does it reach", which is not the same question.
      The scan graded with gradeFor and treated anything but 'Fail' as a pass, so
      with the target set to AAA it reported "all pass" for 4.54:1 body text —
      while the main view, for the same artwork, offered fixes to get it to 7.
    */
    function meetsLevel(ratio, level, sizeClass) {
        return ratio >= requiredRatio(level, sizeClass);
    }

    function requiredRatio(level, sizeClass) {
        if (sizeClass === 'graphic') return THRESHOLDS.nonText;
        if (level === 'AAA') {
            return sizeClass === 'large' ? THRESHOLDS.aaaLarge : THRESHOLDS.aaaNormal;
        }
        return sizeClass === 'large' ? THRESHOLDS.aaLarge : THRESHOLDS.aaNormal;
    }

    // The full six-cell matrix the panel renders.
    function matrix(ratio) {
        return {
            normal: { aa: ratio >= THRESHOLDS.aaNormal, aaa: ratio >= THRESHOLDS.aaaNormal },
            large: { aa: ratio >= THRESHOLDS.aaLarge, aaa: ratio >= THRESHOLDS.aaaLarge },
            graphic: { aa: ratio >= THRESHOLDS.nonText, aaa: null }
        };
    }

    // -----------------------------------------------------------------------
    // Suggestions
    //
    // Sweep brightness across the full range at a few saturation offsets, keep
    // everything that clears the target, and rank by perceptual distance so the
    // smallest visual move comes first — the brand colour stays recognisable.
    // -----------------------------------------------------------------------

    /*
      THE RUNGS OF THE LADDER.

      Every threshold WCAG 2.2 defines for contrast, in order. A designer does
      not think "I need 4.5"; they think "this has to pass AA as body text", and
      the two are the same question asked from opposite ends.

      The old strip offered five shades clustered at whichever single threshold
      the current level and size implied — so text at 1.3:1 with a 3:1 target got
      five near-identical suggestions around 3, and no way to ask for 4.5 or 7
      without going into Settings and changing the level first.
    */
    var RUNGS = [
        { ratio: THRESHOLDS.nonText,    label: '3:1',   who: 'Large text · icons',
          sc: 'SC 1.4.11 AA, and 1.4.3 AA for large text' },
        { ratio: THRESHOLDS.aaNormal,   label: '4.5:1', who: 'AA body text',
          sc: 'SC 1.4.3 AA, and 1.4.6 AAA for large text' },
        { ratio: THRESHOLDS.aaaNormal,  label: '7:1',   who: 'AAA body text',
          sc: 'SC 1.4.6 AAA' }
    ];

    /*
      One colour per rung: the nearest shade of `base` that reaches it.

      Each is solved independently, so a rung the current colour cannot reach —
      no shade of this hue is dark enough against that background — is reported
      as unreachable rather than silently dropped. Dropping it is what made the
      strip look like the tool had nothing more to offer.
    */
    function suggestLadder(baseRgb, otherRgb, current) {
        var out = [];
        for (var i = 0; i < RUNGS.length; i++) {
            var rung = RUNGS[i];
            var found = suggest(baseRgb, otherRgb, rung.ratio, 1);

            out.push({
                target: rung.ratio,
                label: rung.label,
                who: rung.who,
                sc: rung.sc,
                // Already there: nothing to apply, and saying so is more useful
                // than offering a colour that changes nothing.
                met: (typeof current === 'number') && current >= rung.ratio,
                ok: found.length > 0,
                rgb: found.length ? found[0].rgb : null,
                hex: found.length ? found[0].hex : '',
                ratio: found.length ? found[0].ratio : 0,
                deltaE: found.length ? found[0].deltaE : 0,
                shift: found.length ? found[0].shift : ''
            });
        }
        return out;
    }

    /*
      WHERE COMPLIANCE STARTS, ON THE BRIGHTNESS AXIS.

      A slider on its own tells you nothing about whether you have arrived — you
      drag until the number turns green, which is hunting, not designing. A row
      of fixed swatches tells you where the thresholds are but not what else is
      possible. Drawing the thresholds ON the slider is the union of both: you
      can see the passing stretch of the track before you touch it.

      Holding hue and saturation, walk brightness 0..100 and record every point
      where the contrast crosses a threshold. There are usually two crossings per
      rung — one going dark, one going light — and both are real answers.
    */
    function brightnessMarks(hsb, other, targets, reachable) {
        if (!targets || !targets.length) targets = [THRESHOLDS.nonText, THRESHOLDS.aaNormal, THRESHOLDS.aaaNormal];

        var marks = [];
        var previous = null;

        for (var b = 0; b <= 100; b++) {
            /*
              A brightness the object cannot actually render is not an option.

              These walk RENDERED colour, but the caller has to write an AUTHORED
              fill — and through a 50% object nothing renders darker than mid
              grey. Without this predicate the panel drew a green passing zone
              and three "snap to" marks on artwork where every one of them was a
              silent no-op.
            */
            if (reachable && !reachable(b)) { previous = null; continue; }

            var ratio = contrastAgainstAll(hsbToRgb([hsb[0], hsb[1], b]), other);
            if (previous !== null) {
                for (var t = 0; t < targets.length; t++) {
                    var target = targets[t];
                    var was = previous >= target;
                    var now = ratio >= target;
                    // A crossing in either direction is a place the designer can
                    // aim at, so record both rather than only the upward one.
                    if (was !== now) marks.push({ at: b, target: target });
                }
            }
            previous = ratio;
        }
        return marks;
    }

    /*
      The stretches of the brightness axis that clear `target`, as [from, to]
      percentages. Painted onto the track so the passing region is visible at a
      glance rather than discovered by dragging.
    */
    function passZones(hsb, other, target, reachable) {
        var zones = [];
        var open = null;

        for (var b = 0; b <= 100; b++) {
            // Same reachability rule as brightnessMarks: a zone the fill cannot
            // render is not a passing zone, it is a lie painted green.
            var passes = (!reachable || reachable(b)) &&
                contrastAgainstAll(hsbToRgb([hsb[0], hsb[1], b]), other) >= target;
            if (passes && open === null) open = b;
            if (!passes && open !== null) { zones.push([open, b - 1]); open = null; }
        }
        if (open !== null) zones.push([open, 100]);
        return zones;
    }

    /*
      The nearest brightness to `from` that clears `target`, holding hue and
      saturation. This is what a rung mark does when you click it: move the least
      distance that gets you over the line, rather than jumping to an arbitrary
      shade of the same hue.
    */
    function snapBrightness(hsb, other, target, reachable) {
        var zones = passZones(hsb, other, target, reachable);
        if (!zones.length) return null;

        var from = hsb[2];
        var best = null, bestGap = Infinity;

        for (var i = 0; i < zones.length; i++) {
            // Clamp the current brightness into this zone; the clamp IS the
            // nearest point of it.
            var candidate = clamp(from, zones[i][0], zones[i][1]);
            var gap = Math.abs(candidate - from);
            if (gap < bestGap) { bestGap = gap; best = candidate; }
        }
        return best;
    }

    function describeShift(deltaE) {
        if (deltaE < 6) return 'barely visible';
        if (deltaE < 14) return 'slight shift';
        if (deltaE < 26) return 'noticeable';
        return 'big change';
    }

    function suggest(baseRgb, otherRgb, target, howMany) {
        if (!howMany) howMany = 5;

        var hsb = rgbToHsb(baseRgb);

        /*
          Saturation offsets explore neighbouring shades so the list is not just
          one flat brightness ramp. But a grey or white base has no meaningful
          hue — rgbToHsb reports hue 0 for anything achromatic — so adding
          saturation to it invents a colour the designer never chose. White text
          was being offered pink alternatives. Keep achromatic bases achromatic.
        */
        var achromatic = hsb[1] < 2;
        var satOffsets = achromatic ? [0] : [0, -8, 8, -18, 18];
        var seen = {};
        var pool = [];
        var i, j;

        for (j = 0; j < satOffsets.length; j++) {
            var sat = clamp(hsb[1] + satOffsets[j], 0, 100);
            for (i = 0; i <= 100; i++) {
                var candidate = hsbToRgb([hsb[0], sat, i]);
                var hex = toHex(candidate);
                if (seen[hex]) continue;

                // The WORST ratio across everything it sits on. Over a
                // gradient a shade that clears the light end and fails the dark
                // one has not solved anything.
                var ratio = contrastAgainstAll(candidate, otherRgb);
                if (ratio < target) continue;

                seen[hex] = true;
                pool.push({
                    rgb: candidate,
                    hex: hex,
                    ratio: ratio,
                    deltaE: deltaE2000(baseRgb, candidate)
                });
            }
        }

        pool.sort(function (a, b) { return a.deltaE - b.deltaE; });

        var picked = [];
        for (i = 0; i < pool.length && picked.length < howMany; i++) {
            var tooSimilar = false;
            for (j = 0; j < picked.length; j++) {
                if (deltaE2000(pool[i].rgb, picked[j].rgb) < 3) { tooSimilar = true; break; }
            }
            if (tooSimilar) continue;
            pool[i].shift = describeShift(pool[i].deltaE);
            picked.push(pool[i]);
        }

        /*
          CHOSEN by perceptual distance, SHOWN in order of contrast.

          The saturation offsets mean nearest-first is not monotonic in ratio: a
          real strip read 4.52 · 4.62 · 5.26 · 5.00 · 5.62, while the panel and
          the README both promise "leftmost smallest change, rightmost highest
          contrast". Selecting by deltaE is what keeps the brand colour
          recognisable and is worth keeping; the display order is free, so sort
          it and make the row the ramp it claims to be.
        */
        picked.sort(function (a, b) { return a.ratio - b.ratio; });

        return picked;
    }

    return {
        THRESHOLDS: THRESHOLDS,
        PAPER: PAPER,
        clamp: clamp,
        clamp255: clamp255,
        toHex: toHex,
        fromHex: fromHex,
        rgbToHsb: rgbToHsb,
        hsbToRgb: hsbToRgb,
        relativeLuminance: relativeLuminance,
        contrastRatio: contrastRatio,
        contrastAgainstAll: contrastAgainstAll,
        contrastRange: contrastRange,
        LARGE_TEXT: LARGE_TEXT,
        sizeClassFor: sizeClassFor,
        GRADIENT_STEPS: GRADIENT_STEPS,
        orderedStops: orderedStops,
        gradientSamples: gradientSamples,
        asPath: asPath,
        displayRatio: displayRatio,
        readableInk: readableInk,
        rgbToLab: rgbToLab,
        deltaE2000: deltaE2000,
        blend: blend,
        composite: composite,
        renderedColour: renderedColour,
        renderedPair: renderedPair,
        unsharedAlphaOf: unsharedAlphaOf,
        unsharedBlendOf: unsharedBlendOf,
        solveAuthoredFill: solveAuthoredFill,
        solveForPair: solveForPair,
        baseUnder: baseUnder,
        gradeFor: gradeFor,
        requiredRatio: requiredRatio,
        meetsLevel: meetsLevel,
        matrix: matrix,
        suggest: suggest,
        suggestLadder: suggestLadder,
        brightnessMarks: brightnessMarks,
        passZones: passZones,
        snapBrightness: snapBrightness,
        RUNGS: RUNGS,
        describeShift: describeShift
    };
}));
