/*
  Umbra Contrast Checker — panel controller
  Copyright (c) 2026 Artchemy Labs LLC. All rights reserved.
  Use of this file is governed by the licence in LICENSE at the root of this
  project. Not for redistribution.

  Owns the UI and the polling loop. All colour maths lives in color.js; all
  document access goes through cep.js. This file should contain no formulas and
  no ExtendScript.
*/

(function () {
    'use strict';

    var C = window.WCAGColor;
    var BRIDGE = window.CEP;

    /*
      POLL CADENCE

      Illustrator sends CEP panels no selection-changed event, so the panel has
      to ask. Asking is not free: every poll is an evalScript dispatched onto
      Illustrator's main thread, which it runs at whatever moment it next pumps
      its event loop. That can be in the middle of a mouse click, and in 1.9.0
      it was: the crash that produced this version arrived while Illustrator was
      handling a click and the panel's poll landed inside it.

      So the rate is no longer fixed. It stays quick while the user is working
      and steps down when nothing has changed, because a panel nobody is
      interacting with has no business interrupting the application 86 times a
      minute. A resting panel costs a tenth of what 1.9.0 cost.
    */
    var POLL_MS = 700;              // something changed recently, stay responsive
    var POLL_IDLE_MS = 2000;        // a few seconds of nothing
    var POLL_RESTING_MS = 6000;     // a long stretch of nothing, barely tick over
    var POLL_IDLE_AFTER = 6;        // quiet polls before stepping down to idle
    var POLL_REST_AFTER = 30;       // quiet polls before stepping down to resting

    /*
      HEARTBEAT

      1.9.0 handed the host the tokens of the objects it was measuring, and the
      host stamped their colours into every poll, so recolouring a background
      that was not selected refreshed the reading instantly.

      That required the host to keep item wrappers between calls and read them
      from a timer. Illustrator frees art without telling the wrappers that point
      at it, so eventually one of those reads went through a freed handle and
      took the application down with it, inside a try block that could not catch
      it because a segmentation fault is not a JavaScript exception.

      Same feature, no wrappers: re-read the whole selection on a slow beat and
      let the host resolve everything fresh inside that one call. The cost is
      that the refresh takes a few seconds instead of being instant.
    */
    var HEARTBEAT_MS = 2500;

    /*
      LOUPE TUNING

      LOUPE_POINTS is the width of the square grabbed around the pointer, in
      screen points; on a Retina display the returned image is twice that in
      pixels. It is deliberately much larger than the window actually shows.

      That is the trick that makes this feel live. The pane displays about two
      dozen pixels, but each capture covers far more than that, so ordinary small
      movements are served by PANNING inside the frame we already hold — no
      process, no screenshot, no wait. A new capture is only needed to refresh
      the pixels or when the pointer travels a long way. Captures a few times a
      second under a crosshair that moves at 25fps reads as smooth; captures a
      few times a second under a crosshair that only moves with them reads as
      broken, which is what it was.

      LOUPE_PIXELS_ACROSS sets the magnification — how many captured pixels span
      the pane. Forty shows enough of the surroundings to aim by, with pixels
      still large enough to click individually.
    */
    var LOUPE_POINTS = 128;
    var LOUPE_PIXELS_ACROSS = 40;   // more pixels across = smaller, less blocky ones
    var LOUPE_TRACK_MS = 40;        // crosshair and panning: pure canvas work
    var LOUPE_MIN_GAP_MS = 60;      // floor between captures, so a fast machine doesn't spin
    var LOUPE_IDLE_GAP_MS = 600;    // pointer hasn't moved: no reason to re-grab at speed
    var LOUPE_SESSION_MS = 45000;   // hard stop, so a forgotten loupe can't capture forever
    var LOCK_PATIENCE_MS = 1800;    // how long Enter waits for the pixel it asked for
    var LOUPE_FAILURE_LIMIT = 3;


    var state = {
        payload: null,
        // Which run of a mixed text frame is being graded: { index }, or null.
        textRun: null,
        signature: '',
        pickFg: null,
        pickBg: null,
        pickSource: '',             // where the current samples came from
        picking: null,              // 'fg' | 'bg' | null — which slot the next sample fills
        lastSlot: '',               // the slot a refining click should go back to
        pinned: false,              // a colour was picked by hand and must not be dropped
        reload: false,              // re-read the selection on the next poll, even
                                    // if its signature has not changed
        // The signature the pinned colour was picked against. null means nothing
        // is pinned — '' is a real signature the panel can legitimately hold.
        pickedFor: null,
        // Live slider values, held while the pointer is down. Deliberately not
        // pickFg/pickBg: a drag is not a pinned sample and must not raise the
        // "measuring with a colour you picked by hand" notice on every frame.
        draftFg: null,
        draftBg: null,
        dragging: null,             // which side's slider is under the pointer
        level: 'AA',
        sizeMode: 'auto',
        medium: 'auto',             // auto, screen or print: decides what counts as large text
        sizeHinted: false,          // sizeMode was set from the outlined type note, for this artwork only
        useRendered: true,
        fixes: [],
        fixTarget: 'fg',
        fixTargetAuto: true,
        docStem: '',                // the document half of the signature, watched
                                    // so the colour space note cannot go stale
        docName: '',
        colorSpace: 'RGB',
        tempFolder: '',
        captureDetail: '',
        canvasMayBeTainted: false,
        noteSource: '',

        /*
          The preview pane has exactly three states, and conflating them was
          half the reason the old one showed nothing: it was driven by a
          background render that could fail silently with no state to say so.

            idle   — nothing to show
            loupe  — magnified screen pixels around the pointer
            render — a colour-managed Illustrator render, held for sampling
        */
        preview: {
            mode: 'idle',
            live: false,
            frozen: false,
            busy: false,          // a loupe frame is in flight
            failures: 0,
            frames: 0,
            lastMs: 0,
            startedAt: 0,
            region: null,           // where the held frame was captured
            pointer: null,          // where the pointer is right now
            pointerTick: -1,        // heartbeat from the server
            pointerAt: 0,           // when that heartbeat last advanced
            buttons: 0,             // pressed mouse buttons, for click-to-pick
            presses: -1,            // the helper's running count of presses, -1 unknown
            /*
              Is the pointer over the panel itself?

              The screen-wide click detector cannot tell "clicked the artwork"
              from "clicked the Auto chip". Pressing Esc's neighbour, or the gear,
              or the Bg button while the loupe was armed both ran that button AND
              locked whatever pixel happened to be under it — so opening the
              options popover mid-pick silently overwrote a colour. The panel does
              get real DOM events for its own chrome, so let those handle it and
              keep the screen detector for everything outside.
            */
            overPanel: false,
            heldSelection: false,   // the host is holding the selection for us
            pointerServer: false,   // the fast path is running
            lockWhenReady: false,   // Enter pressed while the pointer had outrun the frame
            lockTarget: null,       // the exact screen point Enter asked for
            lockAt: 0,
            lockFailed: false,      // and it never came back into view
            error: '',
            /*
              Bumped whenever the preview changes hands. An Illustrator render is
              slow enough that the user can arm the loupe while it is still in
              flight; without this the render's callback would land on top of a
              tracking loupe, leaving both modes half-active and sampling a
              moving frame as though it were held.
            */
            seq: 0
        }
    };

    // -----------------------------------------------------------------------
    // DOM helpers
    // -----------------------------------------------------------------------

    function el(id) { return document.getElementById(id); }

    function setText(id, text) {
        var node = el(id);
        if (node) node.textContent = text;
    }

    function show(node, visible) {
        if (node) node.hidden = !visible;
    }

    /*
      The header says something only when something needs saying.

      It used to read "live" in green the whole time the panel was connected,
      which told the user nothing the verdict updating did not already tell
      them, in the colour the panel uses for a pass. Now an empty status is
      hidden, and the only words that appear are a write in progress, a write
      that failed, or a lost connection.
    */
    function setStatus(text, cls) {
        var node = el('status-dot');
        if (!node) return;
        node.textContent = text || '';
        node.title = text || '';     // in full, if a narrow dock truncates it
        node.className = 'status' + (cls ? ' ' + cls : '');
        node.hidden = !text;
    }

    /*
      Speak the verdict, once, when it settles.

      The panel repaints off a 700ms poll, so the number changes with no user
      action to explain it — the exact case aria-live exists for, and the panel
      had no live region on the verdict at all. It had one on the loupe readout,
      which changed about twenty-six times a second and simply queued up forever
      in a screen reader.

      So: nothing live on the readout, one live region here, and repeats
      suppressed — a poll that re-renders an unchanged reading must not make the
      reader say it again.
    */
    var lastSpoken = '';

    function announce(message) {
        var node = el('live');
        if (!node || message === lastSpoken) return;
        lastSpoken = message;
        node.textContent = message;
    }

    /*
      Settings, remembered.

      Level, size override and the rendered-colour switch all reset on every
      panel reload — which in Illustrator means every restart. A studio working
      to AAA had to set it again every session, from inside a popover. localStorage
      is per-extension and survives a reload; a CEP build without it must still
      boot, so every access is guarded.
    */
    var PREFS_KEY = 'umbra.prefs.v1';

    function loadPrefs() {
        try {
            var raw = window.localStorage.getItem(PREFS_KEY);
            if (!raw) return;
            var saved = JSON.parse(raw);
            if (saved.level === 'AA' || saved.level === 'AAA') state.level = saved.level;
            if (['auto', 'normal', 'large', 'graphic'].indexOf(saved.sizeMode) >= 0) {
                state.sizeMode = saved.sizeMode;
            }
            if (typeof saved.useRendered === 'boolean') state.useRendered = saved.useRendered;
            if (['auto', 'screen', 'print'].indexOf(saved.medium) >= 0) state.medium = saved.medium;
        } catch (e) {}
    }

    function savePrefs() {
        try {
            window.localStorage.setItem(PREFS_KEY, JSON.stringify({
                level: state.level,
                // A size chosen from the outlined type note belongs to that artwork
                // and must not become every future selection's default.
                sizeMode: state.sizeHinted ? 'auto' : state.sizeMode,
                useRendered: state.useRendered,
                medium: state.medium
            }));
        } catch (e) {}
    }

    // -----------------------------------------------------------------------
    // Colour resolution
    //
    // The host reports raw fills plus alpha and blend. Compositing happens here
    // so the maths stays in one testable place.
    // -----------------------------------------------------------------------

    /*
      Both colours come out of one calculation, because a container the two share
      has to be applied to the pair rather than to each of them. See
      C.renderedPair — the arithmetic and the worked example live there.
    */
    function renderedPair() {
        var p = state.payload;
        return C.renderedPair(p.foreground, p.background, p.backdrops, p.shared, C.PAPER);
    }

    /*
      Every colour the background presents, not just one.

      A solid gives one. A gradient gives the colours it passes through, sampled
      along every segment between its stops, each composited through the same
      opacity, blend and shared-container maths a solid goes through, so the
      numbers are comparable. The verdict then grades the WORST of them, because
      WCAG asks the ratio to hold everywhere the text sits.

      Grading the stops alone missed the middle. Text whose luminance sits
      between two stops is invisible somewhere in between, and a red to green
      ramp is darker in the middle than at either end. See gradientSamples in
      color.js. The list comes back marked as a path, which lets the engine
      treat neighbouring samples as connected and catch a crossing exactly.

      `stopsOnly` returns just the stops, for painting the swatch: a swatch
      drawn from a few hundred samples looks the same and titles itself with a
      few hundred hex codes.
    */
    function backgroundColours(stopsOnly) {
        if (state.draftBg) return [state.draftBg.slice()];
        if (state.pickBg) return [state.pickBg];

        var p = state.payload;
        if (!p || !p.background) return [C.PAPER.slice()];

        var bg = p.background;
        if (bg.stops && bg.stops.length) {
            var points = stopsOnly ? C.orderedStops(bg.stops) : C.gradientSamples(bg.stops);
            var out = [];
            for (var i = 0; i < points.length; i++) {
                var stop = points[i];
                if (!stop || !stop.rgb) continue;
                if (!state.useRendered) { out.push(stop.rgb.slice()); continue; }
                /*
                  Each stop stands in for the whole fill, so it goes through the
                  identical path: its own opacity TIMES the layer's, then the
                  container both colours share.

                  Multiplying is the point. Assigning the stop's alpha to
                  alphaOverBackground REPLACED the object's own opacity, so a
                  black gradient card at 50% over white paper measured as fully
                  opaque black: 21.00 and a green pass, where the same artwork
                  described as a solid correctly read 3.95 and failed. A gradient
                  scrim over a photo is the canonical case for this.
                */
                out.push(C.renderedPair(
                    p.foreground,
                    { rgb: stop.rgb,
                      alphaOverBackground: stop.alpha * C.unsharedAlphaOf(bg),
                      blend: bg.blend,
                      blendOverBackground: bg.blendOverBackground },
                    p.backdrops, p.shared, C.PAPER).bg);
            }
            if (out.length > 1 && !stopsOnly) C.asPath(out);
            if (out.length) return out;
        }

        if (!bg.rgb) return [C.PAPER.slice()];
        return [backgroundColour()];
    }

    function backgroundColour() {
        // A slider drag in progress. Ahead of a pinned pick because it is the
        // thing the user's hand is on right now.
        if (state.draftBg) return state.draftBg.slice();
        if (state.pickBg) return state.pickBg;

        var p = state.payload;
        if (!p || !p.background || !p.background.rgb) return C.PAPER.slice();

        if (!state.useRendered) return p.background.rgb.slice();
        return renderedPair().bg;
    }

    function foregroundColour(bgRendered) {
        if (state.draftFg) return state.draftFg.slice();
        if (state.pickFg) return state.pickFg;

        var p = state.payload;
        if (!p || !p.foreground || !p.foreground.rgb) return [0, 0, 0];

        if (!state.useRendered) return p.foreground.rgb.slice();

        /*
          A hand-picked background is a pixel off the screen — already rendered,
          with no container chain to have in common. Nothing can be shared with
          it, so the foreground's whole opacity applies over it.
        */
        if (state.pickBg) {
            return C.composite(p.foreground.rgb, p.foreground.alpha, p.foreground.blend, bgRendered);
        }

        return renderedPair().fg;
    }

    /*
      Screen or print. Auto follows the document: an RGB document is headed for
      a screen and a CMYK one for a press, which is right for nearly every file
      and is one tap to override when it is not.
    */
    function effectiveMedium() {
        if (state.medium === 'screen' || state.medium === 'print') return state.medium;
        return state.colorSpace === 'CMYK' ? 'print' : 'screen';
    }

    function activeSizeClass() {
        if (state.sizeMode !== 'auto') return state.sizeMode;
        var p = state.payload;
        var f = p && p.foreground;
        /*
          Text is classified HERE, not by the host. The host only knows points;
          whether 18 of them is large depends on the medium, and the medium is a
          panel setting. The host's own class is kept for things that are not
          text, which it alone can tell apart.
        */
        if (f && f.isText && f.pointSize > 0) {
            return C.sizeClassFor(f.pointSize, !!f.bold, effectiveMedium());
        }
        if (f && f.sizeClass) return f.sizeClass;
        return 'normal';
    }

    // -----------------------------------------------------------------------
    // Rendering
    // -----------------------------------------------------------------------

    /*
      Can both colours actually be read?

      A gradient, pattern or placed image has no single colour. Falling back to
      white paper and printing a ratio produced the worst bug this tool has had:
      a confident "21.00:1 passes" on artwork it never measured. Anything
      unreadable and unsampled means no number at all.
    */
    function unreadableReason() {
        var p = state.payload;
        if (!p || !p.ok) return null;

        var fg = p.foreground;
        var bg = p.background;

        if (!state.pickFg && fg) {
            if (fg.kind && fg.kind !== 'solid') return { side: 'text', kind: fg.kind };
            // A solid fill with no rgb should not happen, and if it ever does,
            // silence is the one response that turns it into a false pass.
            if (!fg.rgb) return { side: 'text', kind: fg.kind || 'unreadable' };
        }
        if (!state.pickBg && !state.draftBg && bg) {
            /*
              A gradient whose stops we can read is no longer unreadable — it is
              a RANGE, graded on its worst stop. Only a gradient we could not
              read the stops of still refuses.
            */
            var gradeable = bg.kind === 'gradient' && bg.stops && bg.stops.length;
            if (!gradeable) {
                if (bg.kind && bg.kind !== 'solid') return { side: 'background', kind: bg.kind };
                if (!bg.rgb) return { side: 'background', kind: bg.kind || 'unreadable' };
            }
        }
        return null;
    }

    // Is the background a gradient the panel is currently grading as a range?
    function gradientBackdrop() {
        if (state.pickBg || state.draftBg) return null;
        var p = state.payload;
        var bg = p && p.background;
        if (!bg || bg.kind !== 'gradient' || !bg.stops || !bg.stops.length) return null;
        return bg;
    }

    function describeKind(kind) {
        if (kind === 'gradient') return 'a gradient';
        if (kind === 'pattern') return 'a pattern';
        if (kind === 'image') return 'a placed image';
        if (kind === 'mesh') return 'a gradient mesh';
        return 'something the panel can\'t read';
    }

    /*
      The ratio and its ":1" are one reading, so the suffix goes when the number
      does. Left in place over an empty slot it rendered ":1" beside a
      placeholder dot, which reads as a rendering fault rather than as "nothing
      measured yet".
    */
    function setRatio(text) {
        setText('ratio', text);
        el('ratio-suffix').hidden = (text === '·');
    }

    function showBlank(message, hint) {
        paintPreviewSize();
        paintSliders();
        setRatio('·');
        el('ratio').className = 'ratio';
        setText('ratio-note', hint || '');
        el('ratio-note').className = 'note verdict-note';
        paintMatrix(null);
        el('fixes').innerHTML = '';
        state.fixes = [];
        setText('fix-target', '');
        setText('fix-note', '');
        show(el('fix-block'), false);
        showNotice(message);
        show(el('appearance-note'), false);
        show(el('outline-note'), false);
        if (message) announce(message);
    }

    /*
      TEXT WITH MORE THAN ONE COLOUR, SIZE OR WEIGHT

      The host sends every distinct run in the frame. Each is graded against
      its OWN threshold, because a 24px headline and a 12px caption in the
      same frame need 3:1 and 4.5:1, and the verdict is the run that comes
      closest to failing, or fails by most: lowest ratio over required ratio.

      The chosen run is written into the foreground so everything downstream
      (swatch, sliders, fixes, the colour a fix replaces) works on it without
      knowing runs exist. Held steady while the text slider is being dragged,
      when every run would read as the draft colour.
    */
    function gradeTextRuns() {
        var p = state.payload;
        var f = (p && p.ok) ? p.foreground : null;
        if (!f || !f.runs || f.runs.length < 2 || state.pickFg) { state.textRun = null; return; }
        if (state.draftFg && state.textRun) return;

        // The frame's own size and weight, kept for runs that report none.
        if (!f.hasOwnProperty('framePointSize')) {
            f.framePointSize = f.pointSize;
            f.frameBold = !!f.bold;
        }

        var best = null;
        for (var i = 0; i < f.runs.length; i++) {
            var run = f.runs[i];
            if (!run || !run.rgb) continue;
            useRun(f, run);

            var bg = backgroundColour();
            var fg = foregroundColour(bg);
            var span = C.contrastRange(fg, backgroundColours());
            var ratio = span ? span.worst : C.contrastRatio(fg, bg);
            var margin = ratio / C.requiredRatio(state.level, activeSizeClass());
            if (!best || margin < best.margin) best = { index: i, margin: margin };
        }

        if (!best) { state.textRun = null; return; }
        useRun(f, f.runs[best.index]);
        state.textRun = { index: best.index };
    }

    function useRun(f, run) {
        f.rgb = run.rgb.slice();
        // A run with no size of its own takes the frame's, never the size of
        // whichever run happened to be graded before it.
        f.pointSize = run.pointSize > 0 ? run.pointSize : f.framePointSize;
        f.bold = run.pointSize > 0 ? !!run.bold : f.frameBold;
    }

    // What the notice says about mixed text, or '' when there is nothing to say.
    function mixedTextNote() {
        var p = state.payload;
        var f = p && p.foreground;
        if (!f || !f.runs || !state.textRun || state.pickFg) return '';

        // Count what actually differs. Two runs the host told apart can look
        // identical here (one colour written as RGB, one as a swatch).
        var seen = { c: {}, z: {}, w: {} };
        var count = { c: 0, z: 0, w: 0 };
        for (var i = 0; i < f.runs.length; i++) {
            var run0 = f.runs[i];
            var keys = { c: C.toHex(run0.rgb), z: String(run0.pointSize), w: run0.bold ? 'b' : 'r' };
            for (var k in keys) {
                if (!seen[k][keys[k]]) { seen[k][keys[k]] = true; count[k]++; }
            }
        }
        var parts = [];
        if (count.c > 1) parts.push(count.c + ' colours');
        if (count.z > 1) parts.push(count.z + ' sizes');
        if (count.w > 1) parts.push('bold and regular');
        if (!parts.length) return '';
        var what = parts.length > 1 ? parts.slice(0, -1).join(', ') + ' and ' + parts[parts.length - 1] : parts[0];

        var run = f.runs[state.textRun.index];
        var unit = effectiveMedium() === 'screen' ? 'px' : 'pt';
        return 'This text mixes ' + what + '. Graded the weakest part, ' + C.toHex(run.rgb) +
               (run.pointSize ? ' at ' + run.pointSize + unit : '') + '.';
    }

    // The colour a write replaces, so the host recolours only those runs of a
    // text frame that hold more than one colour.
    function fromHexOf(layer) {
        if (!layer || !layer.rgb) return '';
        // A side measured from a picked pixel was never matched to a run, so
        // there is no run colour to name. The host then writes the whole frame.
        var p = state.payload;
        var side = (p && layer === p.background) ? state.pickBg : state.pickFg;
        if (side) return '';
        return C.toHex(layer.rgb);
    }

    function renderAll() {
        var p = state.payload;
        var hasSelection = !!(p && p.ok);

        if (!hasSelection && !state.pickFg && !state.pickBg) {
            setRatio('·');
            el('ratio').className = 'ratio';
            setText('ratio-note', 'Select artwork on the artboard');
            paintMatrix(null);
            paintSwatch('swatch-fg', 'hex-fg', null);
            paintSwatch('swatch-bg', 'hex-bg', null);
            el('fixes').innerHTML = '';
            // Clearing the buttons is not clearing the state: leaving the old
            // list behind made Diagnose report five fixes for no selection.
            state.fixes = [];
            setText('fix-target', '');
            setText('fix-note', '');
            show(el('fix-block'), false);
            paintPreviewSize();
            paintSliders();
            showNotice(null);
            show(el('appearance-note'), false);
            show(el('outline-note'), false);
            return;
        }

        /*
          One picked colour and nothing selected is half a measurement.

          The branch above only catches having picked NOTHING. Pick a text colour
          off the screen, then deselect — and the panel measured it against
          `backgroundColour()`'s fallback, which is white paper. A hand-sampled
          #767676 came back as "4.54:1, passes AA" against a background that
          exists nowhere except in that default. Refuse, and say which half is
          missing.
        */
        if (!hasSelection && !(state.pickFg && state.pickBg)) {
            paintSwatch('swatch-fg', 'hex-fg', state.pickFg || null);
            paintSwatch('swatch-bg', 'hex-bg', state.pickBg || null);
            showBlank(
                'One colour picked and nothing selected to measure it against. ' +
                'Sample the ' + (state.pickFg ? 'background' : 'text') +
                ' too, or select artwork on the artboard.',
                'Not measured'
            );
            return;
        }

        gradeTextRuns();

        // Refuse to invent a verdict for artwork we cannot read.
        var blocked = unreadableReason();
        if (blocked) {
            paintSwatch('swatch-fg', 'hex-fg', state.pickFg || null);
            paintSwatch('swatch-bg', 'hex-bg', state.pickBg || null);
            showBlank(
                'The ' + blocked.side + ' is ' + describeKind(blocked.kind) +
                ', so there is no single colour to measure. Use the eyedropper to sample it.',
                'Not measured'
            );
            return;
        }

        var bg = backgroundColour();
        var fg = foregroundColour(bg);

        /*
          Over a gradient the reading is the WORST stop, not an average.

          Averaging is the trap: text over a light-to-dark ramp averages to
          mid-grey, so black text would clear the average while being invisible
          at the dark end — a false pass on artwork nobody measured, which is the
          exact failure this tool exists to prevent.
        */
        var against = backgroundColours();
        var span = C.contrastRange(fg, against);
        var ratio = span ? span.worst : C.contrastRatio(fg, bg);
        var sizeClass = activeSizeClass();
        /*
          Graded against the level the user CHOSE, not against whatever the ratio
          happens to reach.

          gradeFor() answers "what does this qualify for". Using it for the
          verdict meant that with AAA selected, 5.62:1 body text showed a green
          number, the words "passes AA", a ✕ in the Normal/AAA cell of the matrix
          directly beside it, and five suggested fixes underneath. The panel said
          "passes" and "here is how to fix it" in one screenful.
        */
        var meets = C.meetsLevel(ratio, state.level, sizeClass);
        var reached = C.gradeFor(ratio, sizeClass);
        var needed = C.requiredRatio(state.level, sizeClass);

        paintSwatch('swatch-fg', 'hex-fg', fg);
        if (against.length > 1) paintGradientSwatch(backgroundColours(true));
        else paintSwatch('swatch-bg', 'hex-bg', bg);

        setRatio(C.displayRatio(ratio));
        el('ratio').className = 'ratio ' + (meets ? 'pass' : 'fail');

        var sizeWord = sizeClass === 'large' ? 'large text'
            : (sizeClass === 'graphic' ? 'icon or graphic' : 'body text');
        var ptText = '';
        if (p && p.foreground && p.foreground.isText && p.foreground.pointSize) {
            // The unit says which rule was applied: 18px is body text on screen,
            // 18pt is large text in print. Same number, different answer.
            ptText = p.foreground.pointSize + (effectiveMedium() === 'screen' ? 'px ' : 'pt ');
        }
        // "Treat text as" can turn a failure green, so the size the verdict was
        // computed with has to be on screen, not only in the popover.
        if (state.sizeMode !== 'auto') ptText = 'as ';

        var spanText = '';
        /*
          A verdict computed from a SUBSET of the stops has to admit it. The host
          caps at 24 and skips any stop whose colour will not resolve; if the one
          it skipped was the dark end, the range understates the problem.
        */
        if (span && span.spread > 0.05) {
            // Say the whole range, so "it passes over there" is visible rather
            // than something the designer has to discover on press day.
            spanText = ' · ' + C.displayRatio(span.worst) + ' to ' + C.displayRatio(span.best) +
                       ' across the gradient';
        }

        setText('ratio-note', meets
            ? ptText + sizeWord + ' · passes ' + state.level + spanText
            : ptText + sizeWord + ' · needs ' + needed + ' for ' + state.level + spanText);
        el('ratio-note').className = 'note verdict-note' + (meets ? '' : ' verdict-short');

        /*
          Announced, not just repainted.

          The panel updates itself off a 700ms poll — the content changes with no
          user action at all, which is precisely the case aria-live exists for.
          Selecting artwork in Illustrator used to produce complete silence.
        */
        announce(C.displayRatio(ratio) + ' to 1, ' +
            (meets ? 'passes ' + state.level : 'fails ' + state.level) +
            ' for ' + sizeWord + '. ' +
            C.toHex(fg) + ' on ' + C.toHex(bg) +
            (reached !== 'Fail' && !meets ? '. Reaches ' + reached + '.' : ''));

        paintMatrix(ratio);
        paintPreviewSize();
        paintSliders();
        renderNotices();
        renderAppearanceNote();
        renderOutlineNote();
        renderFixes(fg, bg, sizeClass, against, ratio);
    }

    /*
      Show the ramp, not one end of it.

      A gradient background was painting the FIRST stop and printing its hex,
      which reads as a solid colour that simply is not there — and hides the
      very thing the verdict is about. Paint the stops as a gradient and say so.
    */
    function paintGradientSwatch(stops) {
        var node = el('swatch-bg');
        var parts = [];
        for (var i = 0; i < stops.length; i++) parts.push(C.toHex(stops[i]));
        node.style.background = 'linear-gradient(90deg, ' + parts.join(', ') + ')';

        setText('hex-bg', 'gradient');
        /*
          The ink has to read against the stop the label actually sits on — the
          leftmost one, since the ramp is painted left to right and the text is
          left-aligned. Using stops[0] was right by accident and wrong by
          intent: the old comment claimed "the worst end", which on a
          white-to-black ramp put black text over the black end.
        */
        el('hex-bg').style.color = C.toHex(C.readableInk(stops[0]));
        node.title = parts.join(' → ');
    }

    function paintSwatch(swatchId, hexId, rgb) {
        var node = el(swatchId);
        if (!rgb) {
            node.style.background = '#808080';
            node.title = '';
            setText(hexId, '·');
            return;
        }

        var hex = C.toHex(rgb);
        // Assigning `background` replaces a linear-gradient left by a previous
        // selection; assigning backgroundColor alone would not.
        node.style.background = hex;
        node.title = '';
        setText(hexId, hex);

        // A contrast tool printing an unreadable label on its own swatch would
        // be a poor advertisement. Pick the ink the same way we grade artwork.
        el(hexId).style.color = C.toHex(C.readableInk(rgb));
    }

    function paintMatrix(ratio) {
        var cells = [
            ['m-normal-aa', 'normal', 'aa'],
            ['m-normal-aaa', 'normal', 'aaa'],
            ['m-large-aa', 'large', 'aa'],
            ['m-large-aaa', 'large', 'aaa'],
            ['m-graphic-aa', 'graphic', 'aa']
        ];

        if (ratio === null) {
            for (var i = 0; i < cells.length; i++) {
                var blank = el(cells[i][0]);
                blank.textContent = '·';
                blank.className = '';
                blank.setAttribute('aria-label', 'not measured');
            }
            return;
        }

        var m = C.matrix(ratio);
        for (var j = 0; j < cells.length; j++) {
            var node = el(cells[j][0]);
            var passed = m[cells[j][1]][cells[j][2]];
            node.textContent = passed ? '✓' : '✕';
            node.className = passed ? 'yes' : 'no';
            node.setAttribute('aria-label', passed ? 'passes' : 'fails');
        }
    }

    function showNotice(message, soft) {
        var node = el('notice');
        if (!message) { show(node, false); return; }
        node.textContent = message;
        // A standing caveat gets a quieter treatment than "this reading is wrong".
        node.className = 'notice' + (soft ? ' soft' : '');
        show(node, true);
    }

    function renderNotices() {
        var p = state.payload;

        /*
          A hand-picked colour survives a change of selection — it has to, since
          the click that picks it often IS the change of selection. The cost is
          that it can quietly become a reading of one object's text against
          another object's background, so the moment the artwork underneath it
          changes, say so plainly.

          Checked BEFORE the payload, and against null rather than truthiness.
          Behind the old order, deselecting everything hid the warning at exactly
          the moment it mattered most; and `pickedFor` was compared for truth, so
          a colour picked while the signature happened to be empty could never
          raise it at all.
        */
        if (state.pinned && state.pickedFor !== null && state.pickedFor !== state.signature) {
            showNotice('Measuring with a colour you picked by hand, not this artwork’s own. ' +
                       'Click Auto to release it.');
            return;
        }

        if (!p || !p.ok) { showNotice(null); return; }

        /*
          Every caveat that applies, not just the first.

          The gradient's unread stops used to be announced from renderAll, which
          then called this function, which cleared the notice a moment later.
          The one warning that said "the range may understate it" never stayed
          on screen. Collected here, they all do.
        */
        var notes = [];

        var missed = (p.background && p.background.stopsMissed) || 0;
        if (missed > 0 && !state.pickBg) {
            notes.push(missed + (missed === 1 ? ' stop in this gradient could not be read'
                                              : ' stops in this gradient could not be read') +
                       '. The range may understate it. Sample the dark end to be sure.');
        }

        var mixed = mixedTextNote();
        if (mixed) notes.push(mixed);

        if (p.foreground && p.foreground.runsPartial && !state.pickFg) {
            notes.push('This text has more styles than the panel reads at once, so some parts were not checked.');
        }

        var f = p.foreground;
        if (f && f.unreadableRuns > 0 && !state.pickFg) {
            notes.push(f.unreadableRuns === 1
                ? 'Part of this text uses a gradient or pattern and was not graded. Sample it with the eyedropper.'
                : f.unreadableRuns + ' parts of this text use a gradient or pattern and were not graded. ' +
                  'Sample them with the eyedropper.');
        }

        // Gradients and patterns are handled earlier by showBlank(); by the time
        // we get here both colours are readable or sampled.
        if (!p.background && !state.pickBg) {
            notes.push('Nothing found behind this, measured against white paper.');
        }

        if (notes.length) {
            // The colour space caveat still applies, shortened to fit beside them.
            if (state.colorSpace === 'CMYK') notes.push('CMYK, so ratios are approximate.');
            showNotice(notes.join(' '));
            return;
        }

        /*
          The CMYK caveat, where the number is.

          Every ratio in a print document is computed from a conversion to sRGB,
          and that qualification lived only in #doc-note — inside the gear
          popover, which most people open once. Say it beside the verdict it
          qualifies, not in a drawer.
        */
        if (state.colorSpace === 'CMYK') {
            showNotice('CMYK document, converted to sRGB, so ratios are close but approximate.', true);
            return;
        }

        showNotice(null);
    }


    /*
      SAY WHY THE COLOUR IS NOT THE COLOUR

      Black text inside a group at 50% renders as mid-grey, and the panel was
      right to measure the grey — but reporting only "3.87:1" against artwork the
      designer knows is black reads as a broken tool. Grouping is how people
      organise work; it should not cost them an explanation.

      So name the container and the reason, show the authored colour beside the
      rendered one, and point at the switch that measures the other way.
    */
    function describeAppearance(chain) {
        if (!chain || !chain.length) return '';

        var parts = [];
        for (var i = 0; i < chain.length; i++) {
            var link = chain[i];
            var what = link.own ? 'the object itself'
                : (link.kind === 'layer' ? 'layer “' + link.name + '”'
                                         : 'group “' + link.name + '”');

            var how = [];
            if (link.opacity < 99.5) how.push(link.opacity + '% opacity');
            if (link.blend !== 'normal') how.push(link.blend + ' blend');

            parts.push(what + ' at ' + how.join(' and '));
        }
        return parts.join(', inside ');
    }

    /*
      Outlined type is paths, so it arrives classed as a graphic and is graded at
      3:1 under 1.4.11. WCAG grades images of text as TEXT, under 1.4.3, at 4.5:1
      for body sizes and 3:1 for large ones, with logos exempt. The verdict line
      did say "icon or graphic", but nothing suggested the reader might be
      looking at a word.

      The panel cannot tell a headline from an icon set, so it asks, and offers
      both answers, because outlined type is usually display type and Body would
      be the wrong guess as often as Large. The choice holds for this artwork and
      resets on the next selection: it is never saved.
    */
    function renderOutlineNote() {
        var node = el('outline-note');
        if (!node) return;

        var p = state.payload;
        var f = p && p.ok && p.foreground;
        if (!f || !f.outlineLike || state.pickFg || state.sizeMode !== 'auto' ||
            activeSizeClass() !== 'graphic') {
            show(node, false);
            return;
        }

        node.innerHTML = '';
        var text = document.createElement('span');
        text.textContent = 'Looks like outlined type, graded as a graphic at 3:1. ' +
            'WCAG grades type as text unless it is a logo. Grade it as';
        node.appendChild(text);

        [['normal', 'body text'], ['large', 'large text']].forEach(function (choice) {
            var button = document.createElement('button');
            button.className = 'link-btn';
            button.textContent = choice[1];
            button.addEventListener('click', function () {
                state.sizeMode = choice[0];
                state.sizeHinted = true;
                paintSegment('seg-size', choice[0]);
                renderAll();
            });
            node.appendChild(button);
        });

        show(node, true);
    }

    function renderAppearanceNote() {
        var node = el('appearance-note');
        if (!node) return;

        var p = state.payload;
        if (!p || !p.ok || !state.useRendered) { show(node, false); return; }

        var sides = [];

        function consider(layer, sampled, label) {
            if (!layer || !layer.rgb || sampled) return;
            if (!layer.appearance || !layer.appearance.length) return;

            var rendered = label === 'Text'
                ? foregroundColour(backgroundColour())
                : backgroundColour();
            var authored = C.toHex(layer.rgb);
            if (authored === C.toHex(rendered)) return;   // nothing surprising

            sides.push(label + ' is ' + authored + ', but renders ' + C.toHex(rendered) +
                ', ' + describeAppearance(layer.appearance) + '.');
        }

        consider(p.foreground, state.pickFg, 'Text');
        consider(p.background, state.pickBg, 'Background');

        if (!sides.length) { show(node, false); return; }

        node.innerHTML = '';
        var text = document.createElement('span');
        text.textContent = sides.join(' ');
        node.appendChild(text);

        var link = document.createElement('button');
        link.className = 'link-btn';
        link.textContent = 'Measure the authored colours instead';
        link.addEventListener('click', function () {
            el('opt-rendered').checked = false;
            state.useRendered = false;
            renderAll();
        });
        node.appendChild(link);

        show(node, true);
    }

    // -----------------------------------------------------------------------
    // Fix swatches
    // -----------------------------------------------------------------------

    /*
      Which colour should move?

      Sweeping the foreground's own hue is the obvious choice, but it gives bad
      advice for achromatic text: white failing on teal yields only near-black
      suggestions, because white has no hue to work with. Nobody wants black text
      on a teal panel — they want to darken the teal.

      So try both sides and offer whichever needs the smaller perceptual move,
      unless the user has explicitly picked a side.
    */

    /*
      Suggesting is not cheap: each call sweeps hundreds of candidates and runs
      CIEDE2000 on every one that clears the target. chooseFixTarget asks for
      both sides, then renderFixes asks again for the winner — three sweeps per
      render, and renderAll runs on every selection change and every option
      toggle. Cache on the exact inputs; the answer is a pure function of them.
    */
    var suggestCache = {};
    var suggestCacheKeys = [];

    function suggestCached(base, other, target, howMany) {
        var list = (typeof other[0] === 'number') ? [other] : other;
        var key = C.toHex(base) + '>' +
                  list.map(function (c) { return C.toHex(c); }).join('+') +
                  '@' + target + 'x' + howMany;
        if (suggestCache[key]) return suggestCache[key];

        var result = C.suggest(base, other, target, howMany);
        suggestCache[key] = result;
        suggestCacheKeys.push(key);

        // Bounded, so a long session cannot grow it without limit.
        if (suggestCacheKeys.length > 60) {
            delete suggestCache[suggestCacheKeys.shift()];
        }
        return result;
    }

    /*
      Some fills must never be overwritten.

      A gradient or a pattern is not one colour, so writing a flat fill over it
      does not adjust the artwork — it destroys it. The host refuses these too;
      this is the panel knowing not to offer in the first place.
    */
    function refusesRecolour(layer) {
        return !!(layer && layer.kind && layer.kind !== 'solid');
    }

    function chooseFixTarget(fg, against, target) {
        if (!state.fixTargetAuto) return state.fixTarget;

        var byText = suggestCached(fg, against, target, 1);
        var byBackground = suggestCached(against[0], [fg], target, 1);

        if (!byText.length && !byBackground.length) return state.fixTarget;
        if (!byText.length) return 'bg';
        if (!byBackground.length) return 'fg';

        return byBackground[0].deltaE < byText[0].deltaE ? 'bg' : 'fg';
    }

    function p2Foreground() {
        return state.payload ? state.payload.foreground : null;
    }
    function p2Background() {
        return state.payload ? state.payload.background : null;
    }

    function renderFixes(fg, bg, sizeClass, against, ratio) {
        var target = C.requiredRatio(state.level, sizeClass);
        var host = el('fixes');
        show(el('fix-block'), true);

        // Over a gradient the text has to clear the target against EVERY stop,
        // so that whole list is what a candidate colour is judged against.
        if (!against || !against.length) against = [bg];
        if (typeof ratio !== 'number') ratio = C.contrastAgainstAll(fg, against);

        if (ratio >= target) {
            /*
              Nothing to fix, so nothing to show. A header reading "Fixes · click
              to apply" over an empty row was the panel's answer to artwork that
              is already fine — visual noise pretending to be an offer.
            */
            host.innerHTML = '';
            state.fixes = [];
            setText('fix-target', '');
            show(el('fix-block'), false);
            return;
        }

        /*
          A side is writable when the panel KNOWS ITS OBJECT — nothing else.

          This used to also require that the side's colour had not been
          eyedropped, which turned out to block the most ordinary workflow there
          is: select the text, sample both colours to see the problem, then fix
          it. Nothing could be fixed at all, because both sides were "picked by
          hand". The object was right there the whole time.

          The hazard that guard was built for is real but different: a colour
          sampled off a photo, written to whichever shape the host happened to
          detect underneath, silently recolours something unrelated. The answer
          to that is disclosure, not refusal — so the panel now names the object
          it is about to change (see writeTargetLabel) and lets the designer
          decide.
        */
        var canChangeBackground = !!(state.payload && state.payload.background &&
                                     state.payload.background.token) &&
                                  !refusesRecolour(state.payload.background);
        var canChangeForeground = !!(state.payload && state.payload.foreground &&
                                     state.payload.foreground.token) &&
                                  !refusesRecolour(state.payload.foreground);

        state.fixTarget = chooseFixTarget(fg, against, target);
        if (state.fixTargetAuto) {
            if (state.fixTarget === 'bg' && !canChangeBackground) state.fixTarget = 'fg';
            if (state.fixTarget === 'fg' && !canChangeForeground) state.fixTarget = 'bg';
        }

        var writable = state.fixTarget === 'fg' ? canChangeForeground : canChangeBackground;
        if (!writable) {
            host.innerHTML = '';
            state.fixes = [];
            setText('fix-target', '');
            setFixNote(state.fixTarget === 'bg' && gradientBackdrop()
                ? 'The background is a gradient. There is no single fill to write. Change the text instead.'
                : 'Nothing on this side can be recoloured. Select the artwork you want to change.', false);
            return;
        }

        var layer = state.fixTarget === 'fg' ? p2Foreground() : p2Background();
        var count = (layer && layer.tokens && layer.tokens.length) ? layer.tokens.length : 1;
        var fgIsText = !!(p2Foreground() && p2Foreground().isText);
        var sideWord = state.fixTarget === 'fg'
            ? (fgIsText ? 'changing text' : 'changing artwork')
            : 'changing background';

        /*
          The glyph is the affordance. Underlined text alone read as a label
          nobody knew was clickable, so the panel's ability to recolour the
          other side went unnoticed.
        */
        var targetButton = el('fix-target');
        setText('fix-target', sideWord + (count > 1 ? ' · ' + count + ' objects' : '') + ' ⇄');
        targetButton.title = state.fixTarget === 'fg'
            ? 'Click to change the background instead'
            : 'Click to change the ' + (fgIsText ? 'text' : 'artwork') + ' instead';

        var base = state.fixTarget === 'fg' ? fg : bg;
        var other = state.fixTarget === 'fg' ? against : [fg];

        /*
          ONE SWATCH PER WCAG RUNG, NOT FIVE SHADES OF ONE.

          The strip used to aim at whichever single threshold the current level
          and size implied, and offer five near-identical shades around it. From
          1.3:1 with a 3:1 target you got five colours all landing near 3 — and
          no way at all to ask for 4.5 or 7 without going into Settings and
          changing the target level first.

          Designers do not think in ratios; they think "this has to pass AA as
          body text". So offer the ladder: the nearest colour that reaches 3:1,
          the nearest that reaches 4.5:1, the nearest that reaches 7:1, each
          labelled with what it satisfies. One click to any rung, from anywhere.
        */
        /*
          SHOW THE SWATCHES ONLY WHEN THE SLIDER CANNOT HELP.

          Measured over 3,504 failing pairs: the brightness slider alone reaches
          AA for 78.6% of them, the swatches add 4.1% the slider cannot reach at
          that hue (they move saturation too), and for the remaining 17.3%
          nothing on this side works and the other colour has to change.

          So for four cases in five the row was duplicating what the slider marks
          already offer, in 34px of a 240px panel. Now it appears when it is the
          only way through — which makes its presence information in itself.
        */
        var sliderReaches = C.snapBrightness(C.rgbToHsb(base), other, target,
                                            reachablePredicate(state.fixTarget)) !== null;
        if (sliderReaches) {
            host.innerHTML = '';
            state.fixes = [];
            setText('fix-target', '');
            show(el('fix-block'), false);
            return;
        }

        state.fixes = C.suggestLadder(base, other, ratio);

        /*
          And a rung the object cannot RENDER is not on offer either.

          suggestLadder works in rendered colour; applyFix has to solve back to
          an authored fill. On black text at 50% over paper the ladder happily
          proposed #757575 — a rendered target needing an authored value of -21,
          which is not a colour. Marking it blocked is the same honesty the
          slider zones now have.
        */
        var canRender = reachablePredicateFor(state.fixTarget);
        if (canRender) {
            for (var k = 0; k < state.fixes.length; k++) {
                var rung = state.fixes[k];
                if (rung.ok && !rung.met && !canRender(rung.rgb)) {
                    rung.ok = false;
                    rung.rgb = null;
                    rung.hex = '';
                }
            }
        }

        host.innerHTML = '';
        var reachable = 0;
        for (var r = 0; r < state.fixes.length; r++) {
            if (state.fixes[r].ok && !state.fixes[r].met) reachable++;
        }
        if (!reachable) {
            /*
              Over a gradient, "try the background" is advice the panel cannot
              follow: a gradient has no single fill to write. And the reason no
              text colour works is usually that the ramp passes through every
              candidate somewhere along its length. Say that instead.
            */
            if (state.fixTarget === 'fg' && gradientBackdrop()) {
                setFixNote('No single text colour clears ' + target + ':1 along this whole ' +
                    'gradient. Shorten the ramp, or sample the part the text sits on.', false);
            } else {
                setFixNote('No shade of this colour reaches ' + target +
                    ':1. Try changing the ' + (state.fixTarget === 'fg' ? 'background' : 'text') + ' instead.', false);
            }
            return;
        }

        state.fixes.forEach(function (fix, index) {
            var button = document.createElement('button');
            button.className = 'fix rung';

            var caption;
            if (fix.met) {
                // Already past this rung. Say so rather than offering a colour
                // that would change the artwork without changing the verdict.
                button.className += ' done';
                button.disabled = true;
                button.style.background = 'transparent';
                caption = 'Already clears ' + fix.label + ' · ' + fix.who;
            } else if (!fix.ok) {
                /*
                  Unreachable, and shown anyway. Hiding it made the ladder look
                  like the tool had nothing further to offer, when the real
                  answer is "not by moving this colour — move the other one".
                */
                button.className += ' blocked';
                button.disabled = true;
                button.style.background = 'transparent';
                caption = fix.label + ' is out of reach for this colour · ' + fix.who;
            } else {
                button.style.background = fix.hex;
                caption = fix.hex + ' · ' + C.displayRatio(fix.ratio) + ':1 · ' + fix.shift;
                button.addEventListener('click', function () { applyFix(index); });
            }

            button.title = caption + ', ' + fix.sc;
            button.setAttribute('aria-label',
                (fix.met || !fix.ok ? '' : 'Apply ') + caption +
                (fix.met || !fix.ok ? '' : ', reaches ' + fix.label + ' for ' + fix.who) +
                '. ' + fix.sc + '.');

            var top = document.createElement('span');
            top.className = 'rung-ratio';
            top.textContent = fix.met ? '✓' : (fix.ok ? C.displayRatio(fix.ratio) : '·');
            // The label sits on the swatch, so it has to survive any colour.
            top.style.color = fix.ok && !fix.met
                ? C.toHex(C.readableInk(fix.rgb))
                : '';
            button.appendChild(top);

            var foot = document.createElement('span');
            foot.className = 'rung-label';
            foot.textContent = fix.label;
            button.appendChild(foot);

            var describe = function () { setFixNote(rungNote(fix, ratio), false); };
            button.addEventListener('mouseenter', describe);
            button.addEventListener('focus', describe);

            host.appendChild(button);
        });

        // Describe the lowest rung still worth taking, which is the one most
        // people want and the cheapest visual change on offer.
        for (var f = 0; f < state.fixes.length; f++) {
            if (state.fixes[f].ok && !state.fixes[f].met) {
                setFixNote(rungNote(state.fixes[f], ratio), false);
                break;
            }
        }
    }

    /*
      Name the object about to be recoloured.

      When the displayed colour was sampled off the screen, the object the panel
      will actually write to may be nothing like the pixel that was picked — a
      colour taken from a photo, written to the card behind it. Refusing outright
      blocked the ordinary workflow; saying WHICH object is about to change lets
      the designer catch the mismatch themselves.
    */
    function writeTargetLabel(layer, side) {
        var name = (layer && layer.label) ? layer.label : 'the selection';
        // The side matters: a slider commits for its own side, which is not
        // necessarily whichever side the fix swatches are currently aimed at.
        if (!side) side = state.fixTarget;
        var sampled = side === 'fg' ? state.pickFg : state.pickBg;
        return sampled ? '“' + name + '” (colour was sampled)' : '“' + name + '”';
    }

    // -----------------------------------------------------------------------
    // Colour sliders
    //
    // Hue, saturation and brightness under each swatch, the way Illustrator's
    // own colour panel works. Dragging previews in the panel only; letting go
    // writes to the artwork ONCE.
    //
    // That split is deliberate. CEP cannot group undo steps, so a slider that
    // wrote on every frame would leave fifty entries between the designer and
    // the colour they started from — Cmd+Z fifty times to undo one drag. One
    // write on release costs a moment of lag and keeps undo meaning what it
    // means everywhere else in Illustrator.
    // -----------------------------------------------------------------------

    var SLIDER_IDS = {
        fg: { h: 'fg-h', s: 'fg-s', b: 'fg-b', marks: 'fg-marks', note: 'fg-slider-note' },
        bg: { h: 'bg-h', s: 'bg-s', b: 'bg-b', marks: 'bg-marks', note: 'bg-slider-note' }
    };

    function sliderHsb(side) {
        var ids = SLIDER_IDS[side];
        return [
            parseFloat(el(ids.h).value) || 0,
            parseFloat(el(ids.s).value) || 0,
            parseFloat(el(ids.b).value) || 0
        ];
    }

    // What the other side looks like, as the list this side has to work over.
    function sliderCounterpart(side) {
        if (side === 'fg') return backgroundColours();
        var bgNow = backgroundColour();
        return [foregroundColour(bgNow)];
    }

    // Which object a side would write to, or null if there is nothing to write.
    /*
      Which object a side would write to, or null if there is nothing to write.

      A readable SOLID fill is required, on both sides. Enabling on `layer.token`
      alone meant the sliders were live on artwork the panel had just refused to
      measure: a stroke-only path reads kind 'none', the verdict says "not
      measured", and one drag still sent a fill — the host does not refuse an
      unfilled path and applyFillToItem sets filled = true, so a stroke-only
      shape silently acquired a flat fill it never had.
    */
    function sliderTarget(side) {
        var p = state.payload;
        if (!p || !p.ok) return null;

        var layer = side === 'fg' ? p.foreground : p.background;
        if (!layer || !layer.token) return null;

        // Not a gradient, not a pattern, not an image, and not unfilled.
        if (refusesRecolour(layer)) return null;
        if (!layer.rgb) return null;

        return layer;
    }

    /*
      The preview pane is only worth its height while it is showing something.

      Expanded whenever the loupe is tracking, a frame is held, or an Illustrator
      render is on screen; a thin strip otherwise. This is what lifts the verdict
      to the top of the panel — the reorder alone only moved it from 420px to
      287px, and the pane is 190px of that.
    */
    function paintPreviewSize() {
        var frame = el('snapshot-frame');
        if (!frame) return;
        var showing = state.preview.live || state.preview.frozen || !!previewImage;
        frame.classList[showing ? 'remove' : 'add']('idle');
    }

    function paintSliders() {
        var bgNow = backgroundColour();
        var fgNow = foregroundColour(bgNow);

        paintSliderSide('fg', fgNow);
        paintSliderSide('bg', bgNow);
    }

    function paintSliderSide(side, rgb) {
        var ids = SLIDER_IDS[side];
        var target = sliderTarget(side);
        var hsb = C.rgbToHsb(rgb);

        // Never fight the user's hand: a slider being dragged keeps its value.
        if (state.dragging !== side) {
            el(ids.h).value = Math.round(hsb[0]);
            el(ids.s).value = Math.round(hsb[1]);
            el(ids.b).value = Math.round(hsb[2]);
        }

        var enabled = !!target;
        el(ids.h).disabled = !enabled;
        el(ids.s).disabled = !enabled;
        el(ids.b).disabled = !enabled;

        if (!enabled) {
            el(ids.marks).innerHTML = '';
            setText(ids.note, side === 'bg' && gradientBackdrop()
                ? 'gradient, not editable'
                : (state.payload && state.payload.ok ? 'no object to change' : ''));
            return;
        }

        setText(ids.note, target.label ? target.label : '');
        paintMarks(side, hsb);
    }

    /*
      The compliance thresholds, drawn on the brightness track.

      This is what makes a slider better than a row of fixed swatches rather
      than merely different from one: the passing stretch of the track is
      visible before the first drag, and each threshold is a target you can
      click to land exactly on.
    */
    function paintMarks(side, hsb) {
        var host = el(SLIDER_IDS[side].marks);
        host.innerHTML = '';

        var others = sliderCounterpart(side);
        if (!others.length) return;

        var sizeClass = activeSizeClass();
        var target = C.requiredRatio(state.level, sizeClass);

        var reachable = reachablePredicate(side);
        var zones = C.passZones(hsb, others, target, reachable);
        for (var z = 0; z < zones.length; z++) {
            var zone = document.createElement('span');
            zone.className = 'zone';
            zone.style.left = zones[z][0] + '%';
            zone.style.width = Math.max(1, zones[z][1] - zones[z][0]) + '%';
            host.appendChild(zone);
        }

        var marks = C.brightnessMarks(hsb, others, null, reachable);
        for (var m = 0; m < marks.length; m++) {
            (function (mark) {
                var tick = document.createElement('span');
                tick.className = 'mark' + (mark.target >= 7 ? ' aaa'
                                        : (mark.target >= 4.5 ? ' aa' : ''));
                tick.style.left = mark.at + '%';
                tick.title = 'Snap to ' + mark.target + ':1';
                tick.addEventListener('click', function (event) {
                    event.stopPropagation();
                    snapTo(side, mark.target);
                });
                host.appendChild(tick);
            }(marks[m]));
        }
    }

    /*
      Move the least distance that clears a threshold, then commit.

      Clicking a mark is the "just make it pass" path the fix swatches used to
      be — but expressed on the control the designer is already holding, and
      landing on the nearest passing brightness rather than a shade somebody
      else chose.
    */
    /*
      Which brightnesses this side can actually RENDER.

      The sliders work in rendered colour, but a commit has to solve backwards to
      an authored fill — and through a 50% object nothing renders darker than mid
      grey. Without this the panel painted a green passing zone and three "snap
      to" marks on artwork where every single one was a silent no-op: click the
      advertised 7:1 mark, the thumb springs back, nothing is written.

      Returns null when everything is reachable, so the common case pays nothing.
    */
    /*
      Can this side RENDER a given colour? Takes an rgb rather than a brightness,
      for callers that already hold a candidate colour.
    */
    function reachablePredicateFor(side) {
        if (!state.useRendered) return null;

        var p = state.payload;
        if (!p || !p.ok) return null;

        var layer = side === 'fg' ? p.foreground : p.background;
        var alpha = C.unsharedAlphaOf(layer);
        var sharedAlpha = (p.shared && typeof p.shared.alpha === 'number') ? p.shared.alpha : 1;
        if (alpha >= 0.999 && sharedAlpha >= 0.999 &&
            C.unsharedBlendOf(layer) === 'normal') return null;

        return function (rgb) {
            if (!rgb) return false;
            return C.solveForPair(rgb, side, p.foreground, p.background,
                                  p.backdrops, p.shared, C.PAPER).ok;
        };
    }

    function reachablePredicate(side) {
        if (!state.useRendered) return null;

        var p = state.payload;
        if (!p || !p.ok) return null;

        var layer = side === 'fg' ? p.foreground : p.background;
        var alpha = C.unsharedAlphaOf(layer);
        var sharedAlpha = (p.shared && typeof p.shared.alpha === 'number') ? p.shared.alpha : 1;
        var blend = C.unsharedBlendOf(layer);

        // Fully opaque and no blend: the authored fill IS the rendered colour.
        if (alpha >= 0.999 && sharedAlpha >= 0.999 && blend === 'normal') return null;

        var hsb = sliderHsb(side);
        var canRender = reachablePredicateFor(side);
        if (!canRender) return null;

        return function (b) {
            return canRender(C.hsbToRgb([hsb[0], hsb[1], b]));
        };
    }

    function snapTo(side, target) {
        var hsb = sliderHsb(side);
        var to = C.snapBrightness(hsb, sliderCounterpart(side), target,
                                  reachablePredicate(side));
        if (to === null) {
            setFixNote('Nothing at this hue reaches ' + target + ':1. Try the other colour.', true);
            return;
        }

        el(SLIDER_IDS[side].b).value = Math.round(to);
        setDraft(side, C.hsbToRgb([hsb[0], hsb[1], to]));
        commitSlider(side);
    }

    function setDraft(side, rgb) {
        if (side === 'fg') state.draftFg = rgb;
        else state.draftBg = rgb;
        renderAll();
    }

    function clearDrafts() {
        state.draftFg = null;
        state.draftBg = null;
    }

    /*
      One write, on release. See the note at the top of this section for why
      this is not done continuously.
    */
    function commitSlider(side) {
        var draft = side === 'fg' ? state.draftFg : state.draftBg;
        var target = sliderTarget(side);
        if (!draft || !target) { clearDrafts(); renderAll(); return; }

        var hex = C.toHex(draft);
        var tokens = (target.tokens && target.tokens.length) ? target.tokens : [target.token];

        /*
          Solve backwards, exactly as the fix swatches do: the swatch shows a
          RENDERED colour and Illustrator stores the AUTHORED fill, and through a
          semi-transparent object or a faded group those differ.
        */
        var p = state.payload;
        var solved = state.useRendered
            ? C.solveForPair(draft, side, p.foreground, p.background, p.backdrops, p.shared, C.PAPER)
            : { ok: true, rgb: draft };

        if (!solved.ok) {
            setFixNote('No fill renders as ' + hex + ' through this object\u2019s opacity.', true);
            clearDrafts();
            renderAll();
            return;
        }

        /*
          Whether this side's colour came from a screen sample, captured BEFORE
          the write clears the pick. Read afterwards it is always false, and the
          note loses exactly the disclosure it exists to make.
        */
        var label = writeTargetLabel(target, side);

        setStatus('Applying…', 'busy');
        BRIDGE.call('wcagApply', [tokens.join(','), C.toHex(solved.rgb), fromHexOf(target)], function (res) {
            if (!res.ok) {
                clearDrafts();
                setFixNote(res.error || 'Could not apply.', true);
                setStatus('Not applied', 'err');
                renderAll();
                return;
            }

            /*
              Hold the draft until the reload lands.

              Clearing it here made the panel fall back to the payload's OLD
              colour for up to one poll — release the slider at 10.55 and watch
              it snap to 4.12 for half a second before jumping back. The draft is
              already what the artwork holds; clearSampleState drops it the
              moment the fresh payload arrives.
            */

            /*
              Hand the side back to the artwork. The colour we just wrote IS the
              artwork's colour now, so a pinned override would only make the
              panel report its own edit back to itself.
            */
            if (side === 'fg') { state.pickFg = null; show(el('marker-fg'), false); }
            else { state.pickBg = null; show(el('marker-bg'), false); }
            if (!state.pickFg && !state.pickBg) { state.pinned = false; state.pickedFor = null; }

            setFixNote('Set ' + label + ' to ' + hex +
                       '. Cmd/Ctrl+Z undoes it.', true);
            state.reload = true;
            setStatus('', '');
            paintPickButtons();
            renderAll();
        });
    }

    function bindSliders() {
        ['fg', 'bg'].forEach(function (side) {
            var ids = SLIDER_IDS[side];
            ['h', 's', 'b'].forEach(function (axis) {
                var input = el(ids[axis]);

                // `input` fires continuously while dragging: preview only.
                input.addEventListener('input', function () {
                    state.dragging = side;
                    setDraft(side, C.hsbToRgb(sliderHsb(side)));
                });

                /*
                  `change` fires when the drag ends, and on every keyboard step.
                  Both are a deliberate act of choosing a colour, so both commit.
                */
                input.addEventListener('change', function () {
                    state.dragging = null;
                    commitSlider(side);
                });
            });
        });
    }

    function rungNote(fix, current) {
        if (fix.met) return 'Already clears ' + fix.label + ' for ' + fix.who + '.';
        if (!fix.ok) {
            return 'Nothing in this colour reaches ' + fix.label +
                   '. Change the ' + (state.fixTarget === 'fg' ? 'background' : 'text') + ' instead.';
        }
        var gain = fix.ratio - current;
        return fix.hex + ' · ' + C.displayRatio(fix.ratio) + ':1 ' +
            (gain >= 0 ? '↑ ' : '↓ ') + C.displayRatio(Math.abs(gain)) +
            ' · ' + fix.shift + ' · ' + fix.who;
    }

    /*
      Some notes have to outlive the next repaint.

      "Recoloured 47 objects. Cmd/Ctrl+Z undoes it." lived for about 300ms: the
      apply set state.reload, the poll re-read the selection, and renderFixes
      overwrote the note with a hover description. The one sentence that tells
      you what just happened to your artwork — and the one that says which fill
      was actually written on a transparent object — were both destroyed by the
      panel's own refresh.
    */
    var NOTE_HOLD_MS = 5000;
    var noteHeldUntil = 0;

    function setFixNote(text, sticky) {
        if (!sticky && now() < noteHeldUntil) return;
        noteHeldUntil = sticky ? now() + NOTE_HOLD_MS : 0;
        setText('fix-note', text);
        if (sticky) announce(text);
    }

    /*
      Swatches show RENDERED colours, but Illustrator stores the AUTHORED fill.
      On a semi-transparent object those differ, so solve backwards before writing.
    */
    function applyFix(index) {
        var fix = state.fixes[index];
        // A met or unreachable rung has no colour to write. Its button is
        // disabled, but a keyboard event can race a repaint and reach it.
        if (!fix || !fix.ok || fix.met || !fix.rgb) return;

        var p = state.payload;
        if (!p || !p.ok) { setFixNote('Nothing selected to change.', true); return; }

        var layer = state.fixTarget === 'fg' ? p.foreground : p.background;
        if (!layer || !layer.token) {
            setFixNote(state.fixTarget === 'fg'
                ? 'No text object is linked.'
                : 'No background shape was found, so there is nothing to recolour.', true);
            return;
        }

        /*
          Invert the SAME model the forward reading used.

          This used to solve one layer, against the already-rendered background,
          ignoring the shared container completely — wrong in two directions at
          once. On this file's own worked example (black text and a #808080 card
          in a group at 65%) it offered "#404040 · 4.56:1", wrote #060606 to the
          artwork, and produced #5D5D5D: 2.90:1, worse than the 3.08 it started
          from. There is no fill that reaches #404040 through a 65% group, and
          saying so is the only honest answer.
        */
        var alpha = state.useRendered ? C.unsharedAlphaOf(layer) : 1;
        var mode = state.useRendered ? C.unsharedBlendOf(layer) : 'normal';

        var solved = state.useRendered
            ? C.solveForPair(fix.rgb, state.fixTarget, p.foreground, p.background,
                             p.backdrops, p.shared, C.PAPER)
            : C.solveAuthoredFill(fix.rgb, 1, 'normal', C.PAPER);

        if (!solved.ok) {
            if (solved.reason === 'blend') {
                setFixNote('That object uses a ' + mode + ' blend mode. Set it to Normal first.', true);
            } else if (solved.reason === 'invisible') {
                setFixNote('That object is almost fully transparent.', true);
            } else {
                var container = (p.shared && p.shared.name)
                    ? ' inside “' + p.shared.name + '”'
                    : '';
                setFixNote('No fill renders as ' + fix.hex + container +
                    ' at ' + Math.round(alpha * 100) + '% opacity. Raise the opacity, ' +
                    'or change the other colour instead.', true);
            }
            return;
        }

        /*
          Send every object sharing this colour, not just one.

          Outlined text is a group of compound paths, one per letter. Applying to
          a single token recoloured one letter — the bug seen in the field.
        */
        var targets = (layer.tokens && layer.tokens.length) ? layer.tokens : [layer.token];

        setStatus('Applying…', 'busy');
        BRIDGE.call('wcagApply', [targets.join(','), C.toHex(solved.rgb), fromHexOf(layer)], function (res) {
            if (!res.ok) {
                setFixNote(res.error || 'Could not apply.', true);
                setStatus('Not applied', 'err');
                return;
            }

            var what = res.objects > 1
                ? ('Recoloured ' + res.objects + ' objects')
                : 'Applied ' + fix.hex + ' to ' + writeTargetLabel(layer);
            // Say it whenever the written fill differs from the target, not only
            // when this item is transparent: a shared group's opacity changes the
            // answer while the item's own alpha reads 100%.
            if (C.toHex(solved.rgb) !== fix.hex) {
                what += '. Fill set to ' + C.toHex(solved.rgb) +
                        ' so it renders as ' + fix.hex;
            }
            if (res.skipped) what += '. Skipped ' + res.skipped;

            setFixNote(what + '. Cmd/Ctrl+Z undoes it.', true);
            state.reload = true;    // the fill changed; re-read it on the next poll
            setStatus('', '');
        });
    }

    // -----------------------------------------------------------------------
    // Preview pane: the loupe, and the Illustrator render
    // -----------------------------------------------------------------------

    /*
      THE LOUPE

      What a system colour picker does, and what this pane should always have
      done: show the pixels immediately around the pointer, magnified, with the
      one under the crosshair called out.

      It reads the screen rather than the document. That is the point — it is
      what the reader actually sees, so gradients, placed photos, live effects
      and blend modes all arrive already composited. The cost is that screen
      pixels come from the display pipeline, so on a wide-gamut display they sit
      in the display's space rather than the document's sRGB. Fine for artwork we
      otherwise could not measure at all. Plain solid fills never need it: those
      are read straight from the document, in document colour.

      Frames arrive one at a time, chained rather than on a fixed interval: each
      one costs a process launch, and stacking them up would only queue work
      behind a screen grab that has not finished.
    */

    var previewImage = null;        // the source image, at its native size
    var previewMap = null;          // { dx, dy, scale } — image space to canvas space
    var sampleCanvas = null;        // offscreen, native size: exact pixels live here
    var loupeGap = null;            // next capture
    var trackTimer = null;          // pointer polling, independent of capture
    var lockTimer = null;           // how long a deferred lock waits for its pixel

    function previewFolder() {
        return state.tempFolder || (BRIDGE.isMac() ? '/tmp' : '.');
    }

    function pathIn(name) {
        var sep = BRIDGE.isMac() ? '/' : '\\';
        return previewFolder() + sep + name;
    }

    function loupePath() { return pathIn('umbra-loupe.png'); }

    /*
      One short sentence the user can act on. The raw reason stays in
      state.captureDetail and never reaches the screen. Capture problems get their own persistent line: they used to
      share the transient hint, so a frame arriving a moment later wiped the
      explanation for something the user had just clicked.
    */
    function friendlyCaptureError(raw) {
        var text = String(raw || '');
        if (/Screen Recording|System Settings/i.test(text)) {
            return 'macOS needs permission: System Settings → Privacy & Security → ' +
                   'Screen Recording → turn on Illustrator, then click the eyedropper again.';
        }
        if (/process bridge|could not start|PowerShell could not/i.test(text)) {
            return 'Couldn’t start the screenshot tool on this machine.';
        }
        if (/did not finish/i.test(text)) {
            return 'The screen grab took too long. Try the eyedropper again.';
        }
        if (/loupe helper/i.test(text)) {
            return 'Couldn’t write the eyedropper helper into the temp folder.';
        }
        if (/helper did not run/i.test(text)) {
            return 'The eyedropper helper couldn’t start. Click it again to rewrite it.';
        }
        if (/would not decode/i.test(text)) {
            return 'The screen grabs are arriving unreadable. Click the eyedropper again.';
        }
        return 'Couldn’t read the screen. Click the eyedropper to try again.';
    }

    function noteCaptureFailure(message, source) {
        state.preview.error = message || 'unknown error';
        state.noteSource = source || 'screen';
        setText('capture-note', state.preview.error);
        show(el('capture-note'), true);
    }

    function clearCaptureNote() {
        show(el('capture-note'), false);
        setText('capture-note', '');
        state.preview.error = '';
        state.noteSource = '';
    }

    /*
      keep marks a message worth showing even with the pane collapsed: the
      eyedropper failing or timing out. Anything else, the idle prompt included,
      collapses the pane all the way, because the eyedropper button already says
      what the prompt said.
    */
    function setPreviewEmpty(message, keep) {
        var node = el('snapshot-empty');
        if (!node) return;
        var frame = el('snapshot-frame');
        if (frame) frame.classList[message && keep ? 'add' : 'remove']('has-note');
        if (!message) { show(node, false); return; }
        node.textContent = message;
        show(node, true);
    }

    // ---- loupe loop --------------------------------------------------------

    function startLoupe(slot) {
        if (slot) state.picking = slot;
        if (!state.picking) state.picking = 'bg';

        /*
          Expand BEFORE the first frame arrives. The canvas sizes its backing
          store from the element, so drawing into a 26px strip and expanding
          afterwards would put the first frame at a tenth of its height.
        */
        el('snapshot-frame').classList.remove('idle');

        // Any tick already queued from a previous arming would otherwise run
        // alongside the one started below.
        if (loupeGap) { clearTimeout(loupeGap); loupeGap = null; }

        /*
          Start the pointer server before the first capture. Without it every
          frame has to launch osascript purely to ask where the mouse is, which
          measured as most of a 381ms frame.
        */
        state.preview.pointerServer = !!(BRIDGE.startPointerServer &&
                                         BRIDGE.startPointerServer(previewFolder()));
        state.preview.pointer = null;
        state.preview.pointerTick = -1;
        state.preview.pointerAt = now();
        state.preview.buttons = 0;
        state.preview.presses = -1;

        // Remember what was selected, so a pick click can be put right.
        state.preview.heldSelection = false;
        BRIDGE.call('wcagHoldSelection', [], function (res) {
            state.preview.heldSelection = !!(res && res.ok);
        });

        startTracking();

        state.preview.mode = 'loupe';
        state.preview.live = true;
        state.preview.frozen = false;
        state.preview.failures = 0;
        state.preview.frames = 0;
        state.preview.region = null;
        state.preview.lockWhenReady = false;
        state.preview.lockTarget = null;
        state.preview.lockFailed = false;
        state.preview.startedAt = now();
        state.preview.seq++;

        /*
          Drop the old frame before the first new one arrives.

          The previous image and its offscreen copy used to survive arming, so
          for the second or so before a capture landed the readout reported the
          colour at the centre of whatever was there last — an Illustrator
          render, or the frame from the previous pick — complete with a live
          contrast ratio. Press Enter in that window and it committed that pixel,
          labelled "Screen". Nothing about it looked wrong.
        */
        previewImage = null;
        previewMap = null;
        sampleCanvas = null;

        el('snapshot-frame').classList.add('picking');
        el('snapshot-frame').classList.add('tracking');
        setPreviewEmpty('Reading the screen…');
        paintPickButtons();
        updateHint();

        if (state.preview.pointerServer) awaitPointerServer(0);
        else loupeTick();
    }

    /*
      Don't capture until the pointer question is settled.

      The fast capture script reads the pointer from a file the server writes; if
      the server never starts — an OS that refuses the automation, a JXA runtime
      that has moved on — that file stays empty and every frame fails. Rather
      than let a faster path turn into a broken one, give it a moment to prove
      itself and otherwise fall back to the self-contained script, which is
      slower but asks nobody's permission.
    */
    function awaitPointerServer(waited) {
        if (!state.preview.live) return;

        if (BRIDGE.readPointer && BRIDGE.readPointer(previewFolder())) {
            loupeTick();
            return;
        }

        if (waited >= 700) {
            state.captureDetail = 'pointer server did not report' +
                (BRIDGE.pointerServerError && BRIDGE.pointerServerError()
                    ? ': ' + BRIDGE.pointerServerError() : '');
            if (BRIDGE.stopPointerServer) BRIDGE.stopPointerServer();
            state.preview.pointerServer = false;
            loupeTick();
            return;
        }

        loupeGap = setTimeout(function () { awaitPointerServer(waited + 50); }, 50);
    }

    function stopLoupe(keepFrame) {
        state.preview.live = false;
        state.preview.frozen = !!keepFrame && !!previewImage;

        if (loupeGap) { clearTimeout(loupeGap); loupeGap = null; }
        stopTracking();
        clearLockTimer();

        if (BRIDGE.stopPointerServer) BRIDGE.stopPointerServer();
        state.preview.pointerServer = false;

        el('snapshot-frame').classList.remove('tracking');
        if (!state.preview.frozen) {
            el('snapshot-frame').classList.remove('picking');
        }
        paintPreviewSize();

        if (!keepFrame) {
            BRIDGE.deleteFile(loupePath());
            BRIDGE.deleteFile(loupePath() + '.pos');
        }

        releaseHeldSelection();
        updateHint();
    }

    /*
      TRACKING — the half that has to feel instant.

      Reading the pointer is one small file read: no process, no host call. So it
      runs at 25fps independently of capture, and every tick re-centres the view
      inside the frame we already hold. The pixels refresh at whatever rate the
      screenshots manage; the crosshair, the hex readout and the panning do not
      wait for them.
    */
    function startTracking() {
        stopTracking();
        trackTimer = setInterval(trackTick, LOUPE_TRACK_MS);
    }

    function stopTracking() {
        if (trackTimer) { clearInterval(trackTimer); trackTimer = null; }
    }

    function trackTick() {
        if (!state.preview.live) { stopTracking(); return; }
        if (!BRIDGE.readPointer) return;

        var next;
        try { next = BRIDGE.readPointer(previewFolder()); } catch (e) { return; }
        if (!next) return;

        /*
          The heartbeat, not the coordinates.

          A server that dies leaves its last position on disk, and a stationary
          pointer looks exactly the same. Without a tick that keeps advancing,
          the loupe would sit on a stale frame showing a plausible hex and a
          plausible ratio for wherever the pointer USED to be, and Enter would
          lock it. Nothing would look wrong.
        */
        if (next.tick !== state.preview.pointerTick) {
            state.preview.pointerTick = next.tick;
            state.preview.pointerAt = now();
        } else if (state.preview.pointerServer &&
                   now() - state.preview.pointerAt > 1200) {
            demoteToSlowPath('the pointer server stopped reporting');
            return;
        }

        /*
          A real click, anywhere on screen, is the pick gesture.

          The panel cannot see clicks outside its own window, and it cannot stop
          one reaching Illustrator either — a native picker uses a transparent
          overlay window to swallow it, and CEP has no such window. So detect the
          press here and repair the damage instead: the host puts the selection
          back the way it was, which makes the click a no-op in the document.
        */
        var wasDown = state.preview.buttons > 0;
        var isDown = (next.buttons || 0) > 0;
        state.preview.buttons = next.buttons || 0;

        /*
          The press count catches what the button state cannot: a trackpad tap
          is down and up again between two samples, so the click reached
          Illustrator and the panel never saw it. A count that moved means a
          press happened, however short. The first reading only sets the base.
        */
        var lastPresses = state.preview.presses;
        var presses = (typeof next.presses === 'number') ? next.presses : -1;
        state.preview.presses = presses;
        var tapped = presses >= 0 && lastPresses >= 0 && presses > lastPresses;

        var before = state.preview.pointer;
        state.preview.pointer = next;

        if ((tapped || (isDown && !wasDown)) && !state.preview.overPanel) {
            pickAtClick();
            return;
        }

        if (before && before.x === next.x && before.y === next.y) {
            tryPendingLock();
            return;
        }

        if (previewImage) {
            drawPreview();
            updateHint();
        }

        tryPendingLock();
    }


    /*
      Fall back mid-session, without telling the user anything went wrong.

      The self-contained script asks for the pointer itself, so it keeps working
      when the server does not. It is slower; it is not broken. Dropping to it
      quietly is the right behaviour — an error message here would be about our
      plumbing, not about anything they can act on.
    */
    function demoteToSlowPath(why) {
        state.captureDetail = why;
        if (BRIDGE.stopPointerServer) BRIDGE.stopPointerServer();
        state.preview.pointerServer = false;
        state.preview.pointer = null;       // the frame's own cursor takes over
        state.preview.pointerTick = -2;
        stopTracking();
        if (!state.preview.busy) scheduleLoupeTick(LOUPE_MIN_GAP_MS);
    }


    /*
      Lock, then put Illustrator back.

      The click that picked this colour also landed on the artboard. With the
      Selection tool that changes what is selected; the host restores it, and
      selection changes are not undo steps, so nothing is left behind. With a
      drawing tool active the click really does draw, and no amount of tidying
      afterwards can prevent that — which the panel says out loud rather than
      pretending it is safe.
    */
    function pickAtClick() {
        // freezeAndPick -> stopLoupe -> releaseHeldSelection does the restoring.
        // Doing it again here raced the flag and dropped the re-poll on the floor.
        freezeAndPick();
    }

    /*
      Give the selection back, exactly once, however the session ended.

      The hold is taken when the loupe is armed. It used to be released only when
      a click was detected, so a session that ended any other way — Esc, the
      45-second stop, a failed capture — left the host holding a list nobody was
      going to ask for.

      The re-poll belongs here too: whatever the click did to the selection, the
      restore undid, and the panel has to re-read it. `state.reload` rather than
      clearing the signature, because the signature is the value a pinned colour
      was picked against and it must survive.
    */
    function releaseHeldSelection() {
        if (!state.preview.heldSelection) return;
        state.preview.heldSelection = false;
        BRIDGE.call('wcagReleaseSelection', [], function () {
            state.reload = true;
        });
    }

    function scheduleLoupeTick(delay) {
        if (!state.preview.live) return;
        if (loupeGap) clearTimeout(loupeGap);
        loupeGap = setTimeout(loupeTick, delay || LOUPE_MIN_GAP_MS);
    }

    // Every way a frame can fail funnels through here, so the give-up rule is
    // written once and cannot be missed by one of the branches.
    function loupeFrameFailed(detail) {
        state.captureDetail = detail;
        state.preview.failures++;

        if (state.preview.failures >= LOUPE_FAILURE_LIMIT) {
            stopLoupe(false);
            state.preview.mode = 'idle';
            state.picking = null;
            paintPickButtons();
            setPreviewEmpty('Eyedropper unavailable', true);
            noteCaptureFailure(friendlyCaptureError(detail), 'screen');
            // The helper may simply have been cleaned out of the temp folder;
            // rewriting it on the next attempt costs nothing and self-heals.
            if (BRIDGE.forgetLoupeScript) BRIDGE.forgetLoupeScript();
            return;
        }

        // A single dropped frame is not worth a message; back off and try again
        // rather than flickering an error at the user.
        scheduleLoupeTick(250);
    }

    function loupeTick() {
        if (!state.preview.live || state.preview.busy) return;

        /*
          Nothing else ends a tracking session — the pointer is out over the
          artboard, so there is no mouseout, no blur, no selection change to hang
          it off. Left alone, a user who armed the eyedropper and then went back
          to work would leave a screen-capture process launching several times a
          second for as long as the panel stayed open.
        */
        if (now() - state.preview.startedAt > LOUPE_SESSION_MS) {
            stopLoupe(false);
            state.preview.mode = 'idle';
            state.picking = null;
            paintPickButtons();
            setPreviewEmpty('Eyedropper timed out. Click it again', true);
            return;
        }

        state.preview.busy = true;
        var started = now();

        BRIDGE.loupeCapture(previewFolder(), loupePath(), LOUPE_POINTS,
            function (okay, problem, base64, region) {
                state.preview.busy = false;
                state.preview.lastMs = now() - started;

                // The user may have cancelled while this frame was in flight.
                if (!state.preview.live) return;

                if (!okay) { loupeFrameFailed(problem); return; }

                state.preview.frames++;
                if (state.noteSource === 'screen') clearCaptureNote();

                /*
                  Back off while the pointer is not moving. Re-grabbing the same
                  pixels ten times a second buys nothing, and this is the state a
                  forgotten loupe sits in.
                */
                var moved = !samePointer(region, state.preview.region);

                loadPreviewImage(base64, null, region, function (decoded) {
                    if (!decoded) {
                        // A frame that arrived but would not decode has to count
                        // too, or a persistently corrupt capture would loop for
                        // ever without ever saying so.
                        loupeFrameFailed('a captured frame would not decode');
                        return;
                    }
                    state.preview.failures = 0;

                    if (tryPendingLock()) return;

                    scheduleLoupeTick(moved ? LOUPE_MIN_GAP_MS : LOUPE_IDLE_GAP_MS);
                });
            });
    }

    function samePointer(a, b) {
        if (!a || !b) return false;
        return a.cursorX === b.cursorX && a.cursorY === b.cursorY;
    }

    /*
      Lock the pixel under the crosshair.

      The pointer is out over the artboard at this moment, so a click cannot be
      the confirm gesture — it would land in Illustrator. A keypress can, because
      the panel still holds keyboard focus. The frame then freezes, which is what
      makes precision possible: aiming at a moving target is hopeless, but
      clicking a specific pixel in a still image is easy.
    */
    /*
      Enter means "the pixel under the pointer AT THIS INSTANT".

      Two things can stop us honouring that immediately: no frame has arrived
      yet, or the pointer has travelled outside the frame we are holding. In
      both cases the answer is to wait — but to wait for THAT pixel, not for
      "any pixel that becomes lockable". Recording only the intent meant the
      lock fired wherever the pointer had wandered to by the time a frame
      landed, which on a photo is a completely different colour.
    */
    function freezeAndPick() {
        if (!state.preview.live) return;

        var pointer = state.preview.pointer;

        // No pointer server: the frame's own recorded cursor is the only truth
        // available, and for that path it is the right one.
        if (!pointer) {
            if (previewImage) completeLock(null);
            else awaitLock(null);
            return;
        }

        var target = { x: pointer.x, y: pointer.y };
        if (previewImage && pointToImagePixel(target.x, target.y)) {
            completeLock(target);
            return;
        }
        awaitLock(target);
    }

    function awaitLock(target) {
        state.preview.lockFailed = false;
        state.preview.lockTarget = target;
        state.preview.lockWhenReady = true;
        state.preview.lockAt = now();

        /*
          Its own timer, rather than a deadline checked whenever a frame happens
          to land. Frames slow to one every 600ms once the pointer stops moving,
          so a frame-driven check made "give up" arrive somewhere between 1.8 and
          2.5 seconds — and if captures stopped entirely it would never arrive at
          all, leaving the loupe waiting silently forever.
        */
        if (lockTimer) clearTimeout(lockTimer);
        lockTimer = setTimeout(expireLock, LOCK_PATIENCE_MS);

        updateHint();
    }

    function clearLockTimer() {
        if (lockTimer) { clearTimeout(lockTimer); lockTimer = null; }
    }

    function expireLock() {
        lockTimer = null;
        if (!state.preview.lockWhenReady) return;

        state.preview.lockWhenReady = false;
        state.preview.lockTarget = null;
        state.preview.lockFailed = true;
        updateHint();
    }

    /*
      Try to honour a pending lock. Returns true if it completed.

      Gives up after a moment: the capture region follows the pointer, so if the
      user has moved away the requested pixel may never be captured again, and
      waiting silently forever is worse than saying so.
    */
    function tryPendingLock() {
        if (!state.preview.lockWhenReady) return false;

        var target = state.preview.lockTarget;
        var reachable = previewImage &&
            (!target || !!pointToImagePixel(target.x, target.y));

        if (reachable) {
            state.preview.lockWhenReady = false;
            clearLockTimer();
            completeLock(target);
            return true;
        }

        return false;
    }

    function completeLock(target) {
        var point = target ? pointToImagePixel(target.x, target.y) : centreImagePixel();
        var hit = point ? sampleImagePixel(point) : null;
        stopLoupe(true);

        if (!hit) {
            setText('pick-hint', 'That frame could not be read. Press the eyedropper again');
            return;
        }
        commitSample(hit, 'screen');
    }

    function cancelPicking() {
        stopLoupe(false);
        state.preview.seq++;          // orphan any render still in flight
        state.preview.mode = 'idle';
        state.preview.frozen = false;
        state.preview.lockWhenReady = false;
        state.preview.lockTarget = null;
        state.preview.lockFailed = false;
        state.preview.pointer = null;
        state.picking = null;
        previewImage = null;
        previewMap = null;
        paintPickButtons();
        clearCanvas();
        setPreviewEmpty(idleMessage());
        // AFTER previewImage is cleared: collapsing is conditional on there
        // being nothing to show, and run any earlier it still sees the old frame.
        paintPreviewSize();
        updateHint();
    }

    function idleMessage() {
        // Short enough for one line in the collapsed strip. The old wording ran
        // to two lines at 26px and read as clipped rather than compact.
        return 'Eyedrop any colour on screen';
    }

    // ---- image loading and drawing ----------------------------------------

    /*
      region is the loupe's metadata — where on the desktop the grab came from,
      and where the pointer was inside it. Null for an Illustrator render, which
      is simply fitted into the pane.
    */
    function loadPreviewImage(base64, path, region, done) {
        var img = new Image();
        var settled = false;
        var isLoupeFrame = !!region;
        var decodeTimer = null;

        function finish(decoded) {
            if (settled) return;
            settled = true;
            if (decodeTimer) { clearTimeout(decodeTimer); decodeTimer = null; }
            if (done) done(decoded);
        }

        /*
          A decode that never settles used to hang the whole loupe session.

          The next frame is scheduled from this callback and from nowhere else,
          so if neither onload nor onerror ever fired the session was left live,
          not busy, and with no pending tick. loupeTick never ran again, which
          meant the 45 second hard stop it enforces never ran either, and the
          crosshair tracker kept doing a synchronous file read every 40ms for the
          life of the panel. The `settled` flag guarded against finish() running
          twice; nothing guarded against it never running at all.
        */
        decodeTimer = setTimeout(function () {
            if (settled) return;
            reportDecodeFailure('The preview image did not decode in time.');
            finish(false);
        }, 4000);

        // A single unreadable loupe frame is not worth a banner — the loop
        // counts it and speaks up only if they keep coming. A failed render is
        // a one-shot the user asked for, so that one does get said out loud.
        function reportDecodeFailure(message) {
            state.captureDetail = message;
            if (!isLoupeFrame) noteCaptureFailure(message, 'illustrator');
        }

        img.onload = function () {
            /*
              finish() must run whatever happens in here. It is what drives the
              next loupe frame, so a throw while drawing would not just lose one
              frame — it would stop the loop dead with the pane still saying it
              was tracking.
            */
            try {
                previewImage = img;
                state.preview.region = region;
                captureSampleSource(img);
                setPreviewEmpty(null);
                drawPreview();
                updateHint();
            } catch (e) {
                state.captureDetail = 'preview draw failed: ' + e.message;
                finish(false);
                return;
            }
            finish(true);
        };

        img.onerror = function () {
            // A data URL failing is odd, but a file URL is worth one try before
            // giving up on the preview entirely.
            if (!img._triedFileUrl && path) {
                img._triedFileUrl = true;
                state.canvasMayBeTainted = true;
                img.src = BRIDGE.fileUrl(path);
                return;
            }
            reportDecodeFailure('The preview image would not decode.');
            finish(false);
        };

        if (base64) {
            state.canvasMayBeTainted = false;
            img.src = 'data:image/png;base64,' + base64;
        } else if (path) {
            state.canvasMayBeTainted = true;
            img._triedFileUrl = true;
            img.src = BRIDGE.fileUrl(path);
        } else {
            reportDecodeFailure('Nothing to load into the preview.');
            finish(false);
        }
    }

    /*
      Sampling reads from a native-resolution copy, never from what is on screen.

      The visible canvas is scaled — down for a render, up for the loupe — and
      the browser interpolates when it scales. Reading a pixel back out of it
      therefore returned a blend of neighbouring colours rather than the colour
      the user pointed at, which on anti-aliased text is wildly wrong. Keep an
      unscaled copy and sample that.
    */
    function captureSampleSource(img) {
        if (!sampleCanvas) sampleCanvas = document.createElement('canvas');
        sampleCanvas.width = img.width || 1;
        sampleCanvas.height = img.height || 1;

        try {
            var ctx = sampleCanvas.getContext('2d');
            ctx.drawImage(img, 0, 0);
        } catch (e) {
            state.captureDetail = 'offscreen draw failed: ' + e.message;
        }
    }

    function clearCanvas() {
        var canvas = el('snapshot');
        if (!canvas) return;

        var frame = el('snapshot-frame');
        canvas.width = frame.clientWidth || 220;
        canvas.height = frame.clientHeight || 120;

        try {
            var ctx = canvas.getContext('2d');
            ctx.fillStyle = '#2f2f2f';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
        } catch (e) {}
    }

    function drawPreview() {
        var canvas = el('snapshot');
        if (!canvas || !previewImage) return;

        var frame = el('snapshot-frame');
        var w = frame.clientWidth || 220;
        var h = frame.clientHeight || 120;

        canvas.width = w;
        canvas.height = h;

        var ctx;
        try { ctx = canvas.getContext('2d'); } catch (e) { return; }

        ctx.fillStyle = '#2f2f2f';
        ctx.fillRect(0, 0, w, h);

        if (state.preview.mode === 'loupe') {
            drawLoupeFrame(ctx, w, h);
        } else {
            drawFittedImage(ctx, w, h);
        }
    }

    function drawLoupeFrame(ctx, w, h) {
        var img = previewImage;

        // Nearest neighbour: a magnified loupe must show pixels as pixels. Left
        // smoothed, every edge becomes a gradient of colours that are not in the
        // artwork, which is the opposite of what an eyedropper is for.
        setSmoothing(ctx, false);

        var mag = Math.max(2, Math.round(w / LOUPE_PIXELS_ACROSS));
        var centre = centreImagePixel();

        var dx = Math.round(w / 2 - (centre.x + 0.5) * mag);
        var dy = Math.round(h / 2 - (centre.y + 0.5) * mag);

        try {
            ctx.drawImage(img, dx, dy, img.width * mag, img.height * mag);
        } catch (e) {
            return;
        }

        previewMap = { dx: dx, dy: dy, scale: mag };

        // Crosshair on the pixel that Enter would lock. Two rings, light over
        // dark, so it stays visible whatever colour it lands on.
        var boxX = dx + centre.x * mag;
        var boxY = dy + centre.y * mag;

        /*
          Dimmed while the pointer has outrun the frame. The crosshair is then
          showing where the pointer was when this frame was captured, not where
          it is — true, useful, and a fraction of a second stale. Saying so
          quietly beats letting a confident marker imply otherwise.
        */
        var current = !state.preview.pointer || !!livePointerPixel();

        var strong = current ? 1 : 0.45;

        /*
          Reticle lines as well as a box.

          Zoomed out, one magnified pixel is only a few points across and a bare
          outline that small is genuinely hard to find against busy artwork. Four
          short lines reaching in from the edges point at it from anywhere in the
          frame, which is what every real picker draws — and they stop short of
          the box so they never cover the pixel being measured.
        */
        var cx = boxX + mag / 2;
        var cy = boxY + mag / 2;
        var gap = mag / 2 + 4;
        var reach = 14;

        ctx.lineWidth = 1;
        for (var pass = 0; pass < 2; pass++) {
            // Dark underlay first, then light: readable on any colour.
            ctx.strokeStyle = pass === 0
                ? 'rgba(0,0,0,' + (0.75 * strong) + ')'
                : 'rgba(255,255,255,' + (0.95 * strong) + ')';
            var off = pass === 0 ? 1 : 0;

            ctx.beginPath();
            ctx.moveTo(cx + off, cy - gap + off);       ctx.lineTo(cx + off, cy - gap - reach + off);
            ctx.moveTo(cx + off, cy + gap + off);       ctx.lineTo(cx + off, cy + gap + reach + off);
            ctx.moveTo(cx - gap + off, cy + off);       ctx.lineTo(cx - gap - reach + off, cy + off);
            ctx.moveTo(cx + gap + off, cy + off);       ctx.lineTo(cx + gap + reach + off, cy + off);
            ctx.stroke();

            ctx.strokeRect(boxX - 0.5 + off, boxY - 0.5 + off, mag + 1, mag + 1);
        }
    }

    function drawFittedImage(ctx, w, h) {
        var img = previewImage;
        setSmoothing(ctx, true);

        var scale = Math.min(w / (img.width || 1), h / (img.height || 1));
        var dw = (img.width || 1) * scale;
        var dh = (img.height || 1) * scale;
        var dx = Math.round((w - dw) / 2);
        var dy = Math.round((h - dh) / 2);

        try {
            ctx.drawImage(img, dx, dy, dw, dh);
        } catch (e) {
            return;
        }

        previewMap = { dx: dx, dy: dy, scale: scale };
    }

    function setSmoothing(ctx, on) {
        try {
            ctx.imageSmoothingEnabled = on;
            ctx.webkitImageSmoothingEnabled = on;
        } catch (e) {}
    }

    // A screen point inside this frame, as an image pixel — or null if it falls
    // outside what was captured.
    function pointToImagePixel(px, py) {
        var img = previewImage;
        var region = state.preview.region;
        if (!img || !region || !region.size) return null;

        var pxPerPoint = img.width / region.size;
        var x = Math.floor((px - region.x) * pxPerPoint);
        var y = Math.floor((py - region.y) * pxPerPoint);

        if (x < 0 || y < 0 || x >= img.width || y >= img.height) return null;
        return { x: x, y: y };
    }

    /*
      Where the pointer is NOW, inside the frame we are holding.

      This is what makes panning honest rather than cosmetic. The capture covers
      far more than the pane shows, so when the pointer moves a little the pixel
      beneath it is genuinely inside the frame already — the crosshair is not
      guessing, it is pointing at real captured pixels. Returns null once the
      pointer has travelled outside the frame, which is the signal to wait for a
      fresh one rather than sample the wrong thing.
    */
    function livePointerPixel() {
        var p = state.preview.pointer;
        if (!p) return null;
        return pointToImagePixel(p.x, p.y);
    }

    /*
      Where the crosshair goes. The live pointer if we can place it; otherwise
      where the frame itself was centred, which near a screen edge is not the
      middle of the image — the grab gets clamped and the pointer sits off-centre.
    */
    function centreImagePixel() {
        var img = previewImage;
        var region = state.preview.region;

        var w = (img && img.width) || 1;
        var h = (img && img.height) || 1;

        var live = livePointerPixel();
        if (live) return live;

        if (!region || !region.size) {
            return { x: Math.floor(w / 2), y: Math.floor(h / 2) };
        }

        var pxPerPoint = w / region.size;
        var x = Math.floor((region.cursorX - region.x) * pxPerPoint);
        var y = Math.floor((region.cursorY - region.y) * pxPerPoint);

        return {
            x: Math.max(0, Math.min(w - 1, x)),
            y: Math.max(0, Math.min(h - 1, y))
        };
    }

    function sampleImagePixel(point) {
        if (!sampleCanvas || !point) return null;

        var x = Math.max(0, Math.min(sampleCanvas.width - 1, Math.round(point.x)));
        var y = Math.max(0, Math.min(sampleCanvas.height - 1, Math.round(point.y)));

        try {
            var data = sampleCanvas.getContext('2d').getImageData(x, y, 1, 1).data;
            return { rgb: [data[0], data[1], data[2]], x: x, y: y };
        } catch (e) {
            /*
              A file-URL image taints the canvas, which makes getImageData throw.
              Say something useful rather than failing silently.
            */
            state.captureDetail = 'getImageData blocked: ' + e.message +
                ' (canvas tainted by a file URL)';
            noteCaptureFailure('This preview can’t be sampled. Try the eyedropper again.', 'screen');
            return null;
        }
    }

    // Canvas coordinates back to image pixels, through whatever transform the
    // last draw used.
    function imagePixelAtEvent(event) {
        var canvas = el('snapshot');
        if (!canvas || !previewImage || !previewMap) return null;

        var rect = canvas.getBoundingClientRect();
        if (!rect.width || !rect.height) return null;

        var cx = (event.clientX - rect.left) * (canvas.width / rect.width);
        var cy = (event.clientY - rect.top) * (canvas.height / rect.height);

        var ix = Math.floor((cx - previewMap.dx) / previewMap.scale);
        var iy = Math.floor((cy - previewMap.dy) / previewMap.scale);

        if (ix < 0 || iy < 0 || ix >= previewImage.width || iy >= previewImage.height) {
            return null;
        }
        return { x: ix, y: iy };
    }

    function commitSample(hit, source) {
        if (!hit) return;

        var slot = state.picking === 'fg' ? 'fg' : 'bg';

        if (slot === 'fg') {
            state.pickFg = hit.rgb;
        } else {
            state.pickBg = hit.rgb;
        }
        state.pickSource = source;
        state.pinned = true;
        // Which artwork this was picked for, so the panel can notice later that
        // it is no longer describing what is on screen.
        state.pickedFor = state.signature;

        placeMarker(slot === 'fg' ? 'marker-fg' : 'marker-bg', hit);

        /*
          Remember the slot. The next click inside a frozen frame is the
          documented way to correct a pick that landed a pixel off, so it has to
          land in the same slot — defaulting it to the background quietly
          overwrote the wrong colour and produced a ratio between two pixels that
          were never text and background at all.
        */
        state.lastSlot = slot;
        state.picking = null;
        paintPickButtons();
        updateHint();
        renderAll();
    }

    function placeMarker(id, hit) {
        var marker = el(id);
        var canvas = el('snapshot');
        if (!marker || !canvas || !previewMap) return;

        var x = previewMap.dx + (hit.x + 0.5) * previewMap.scale;
        var y = previewMap.dy + (hit.y + 0.5) * previewMap.scale;

        marker.style.left = (x / (canvas.width || 1) * 100) + '%';
        marker.style.top = (y / (canvas.height || 1) * 100) + '%';
        show(marker, true);
    }

    // ---- pick state --------------------------------------------------------

    /*
      AUTO IS A MODE, NOT A LABEL.

      The chip used to change its wording to report where the last sample came
      from, and lit up when a colour had been picked — which read as "sampling is
      on" when it actually meant "automatic is off". Inverted.

      Now it says one thing and behaves like a switch: lit while the panel is
      reading the artwork itself, dimmed the moment you override either colour by
      hand, and clicking it hands both sides back to the artwork. Provenance
      moved to where it belongs — a dot on the button whose colour you replaced.
    */
    function paintPickButtons() {
        el('btn-pick-fg').classList.toggle('on', state.picking === 'fg');
        el('btn-pick-bg').classList.toggle('on', state.picking === 'bg');
        el('btn-camera').classList.toggle('on', state.preview.live);

        paintPickDot('dot-fg', state.pickFg);
        paintPickDot('dot-bg', state.pickBg);

        var overridden = !!(state.pickFg || state.pickBg);
        var chip = el('mode-chip');

        chip.classList.toggle('on', !overridden);
        chip.classList.toggle('off', overridden);
        chip.textContent = 'Auto';
        chip.disabled = false;

        chip.title = overridden
            ? (describeOverride() + ' Click to go back to the artwork’s own colours.')
            : 'Reading both colours from the artwork itself, colour-managed.';
    }

    function paintPickDot(id, rgb) {
        var dot = el(id);
        if (!dot) return;
        if (rgb) {
            dot.style.background = C.toHex(rgb);
            dot.classList.add('set');
        } else {
            dot.style.background = '';
            dot.classList.remove('set');
        }
    }

    function describeOverride() {
        var sides = [];
        if (state.pickFg) sides.push('Text');
        if (state.pickBg) sides.push('Background');

        // Every sample comes from the eyedropper, so every sample is screen pixels.
        var where = 'sampled from the screen, exactly what is displayed, but on a wide-gamut ' +
            'display the values are in the display’s colour space rather than the ' +
            'document’s sRGB, so treat borderline numbers with care';

        return sides.join(' and ') + ' ' + where + '.';
    }

    /*
      What the other half of the pair currently is — or null if we do not
      honestly know. Used for the live ratio, and it must not fall back to the
      black-on-white defaults: a made-up counterpart makes a made-up ratio.
    */
    function counterpartColour() {
        var p = state.payload;
        var readable = function (side) {
            return !!(p && p.ok && p[side] && p[side].kind === 'solid');
        };

        if (state.picking === 'fg') {
            if (state.pickBg) return state.pickBg;
            return readable('background') ? backgroundColour() : null;
        }
        if (state.pickFg) return state.pickFg;
        return readable('foreground') ? foregroundColour(backgroundColour()) : null;
    }

    function updateHint() {
        var node = el('pick-hint');
        if (!node) return;

        var slot = state.picking === 'fg' ? 'text' : 'background';

        /*
          Both of these outlast the next redraw on purpose. They are the only
          signal that Enter was heard, and a frame arriving 40ms later used to
          wipe them — leaving the user pressing Enter at something that looked
          like it was ignoring them.
        */
        if (state.preview.live && state.preview.lockWhenReady) {
            node.textContent = 'Catching up to that pixel…';
            return;
        }
        if (state.preview.live && state.preview.lockFailed) {
            node.textContent = 'Couldn’t reach that pixel. Press Enter again';
            return;
        }

        if (state.preview.live) {
            var centre = sampleImagePixelQuiet(centreImagePixel());
            if (!centre) {
                node.textContent = 'Reading the screen…';
                return;
            }

            /*
              The ratio, live, before anything is committed.

              This is the single most useful thing the loupe can show: hovering
              around a photo or a gradient tells you where the text would pass,
              instead of making you lock a colour, read the verdict, undo, and
              try again. It is what the desktop contrast analysers do, and the
              reason to bother building a loupe at all.
            */
            node.innerHTML = '';
            var hex = document.createElement('span');
            hex.className = 'live-hex';
            hex.textContent = C.toHex(centre.rgb);
            node.appendChild(hex);

            var other = counterpartColour();
            if (other) {
                var ratio = C.contrastRatio(centre.rgb, other);
                var need = C.requiredRatio(state.level, activeSizeClass());
                var span = document.createElement('span');
                span.className = 'live-ratio ' + (ratio >= need ? 'live-pass' : 'live-fail');
                span.textContent = ' · ' + C.displayRatio(ratio) + ':1';
                node.appendChild(span);
            }

            /*
              Terse on purpose. At 240px the long form wrapped to a second line
              and left "Esc" orphaned on its own — and this line updates 25 times
              a second, so a reflow between one and two lines made the whole
              panel jitter while tracking.
            */
            /*
              Only offer the click when there is something watching for it.

              Click-to-pick needs the pointer server; on the fallback path the
              panel cannot see a press at all. Advertising it there meant the
              click went to Illustrator, changed the selection, picked nothing,
              and left no trace of why.
            */
            node.appendChild(document.createTextNode(
                (state.preview.pointerServer ? ' · click or ⏎ to lock ' : ' · ⏎ to lock ') +
                (slot === 'text' ? 'text' : 'bg')));
            return;
        }

        if (state.preview.frozen) {
            node.textContent = state.picking
                ? 'Click a pixel to set the ' + slot + ' · Esc closes'
                : 'Click a pixel to sample again · Esc closes';
            return;
        }

        // Idle, but holding a colour the user picked. Name the way out — the
        // Auto chip is the only release and nothing on screen said so.
        if (state.pinned) {
            node.textContent = 'Using a picked colour · Esc or Auto releases it';
            return;
        }

        node.textContent = '';
    }

    // Same read, but a failure here is cosmetic — never raise an error banner
    // just because the live hex readout could not be filled in.
    function sampleImagePixelQuiet(point) {
        if (!sampleCanvas || !point) return null;
        try {
            var x = Math.max(0, Math.min(sampleCanvas.width - 1, Math.round(point.x)));
            var y = Math.max(0, Math.min(sampleCanvas.height - 1, Math.round(point.y)));
            var data = sampleCanvas.getContext('2d').getImageData(x, y, 1, 1).data;
            return { rgb: [data[0], data[1], data[2]] };
        } catch (e) {
            return null;
        }
    }

    // "Go back to the artwork's own colours" — which means abandoning a pick in
    // progress too, not leaving the loupe running with nowhere to put its result.
    function clearSamples() {
        if (state.preview.live || state.preview.frozen) {
            cancelPicking();
        }

        state.pinned = false;
        state.pickedFor = null;     // null, not '': '' is a signature the panel can hold
        state.pickFg = null;
        state.pickBg = null;
        state.pickSource = '';
        show(el('marker-fg'), false);
        show(el('marker-bg'), false);
        state.picking = null;
        paintPickButtons();
        renderAll();
    }

    function now() {
        return (new Date()).getTime();
    }

    // -----------------------------------------------------------------------
    // Polling
    // -----------------------------------------------------------------------

    /*
      Self-scheduling rather than setInterval.

      An interval keeps firing while a call is still outstanding, so a host that
      slows down gets more work piled onto it, not less — the opposite of what
      should happen. Chain the next poll off the last one instead.
    */
    var pollTimer = null;
    var pollStopped = false;        // the host is going away: never poll again
    var panelVisible = true;
    var quietPolls = 0;
    var lastBeat = 0;

    function nowMs() { return new Date().getTime(); }

    function pollDelay() {
        if (quietPolls >= POLL_REST_AFTER) return POLL_RESTING_MS;
        if (quietPolls >= POLL_IDLE_AFTER) return POLL_IDLE_MS;
        return POLL_MS;
    }

    // Slower again once resting, so a forgotten panel with something selected
    // is not re-reading the document every few seconds all afternoon.
    function beatGap() {
        return quietPolls >= POLL_REST_AFTER ? HEARTBEAT_MS * 4 : HEARTBEAT_MS;
    }

    /*
      Never beat on top of a gesture.

      A heartbeat is a re-read, and a re-read clears the slider draft. Landing
      one mid-drag would snap the thumb back to where the artwork still is and
      silently drop the edit, which is precisely the bug the token-name feedback
      loop used to cause and which the panel suite has guarded against ever
      since. Someone holding a slider is also someone who is not waiting on a
      background refresh, so there is nothing to trade away by waiting.
    */
    function beatSafe() {
        if (state.dragging) return false;
        if (state.draftFg || state.draftBg) return false;
        if (state.picking || state.preview.live) return false;
        if (state.preview.frozen) return false;
        return true;
    }

    function schedulePoll(delay) {
        if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
        if (pollStopped || !panelVisible) return;
        pollTimer = setTimeout(pollSignature, delay === undefined ? pollDelay() : delay);
    }

    /*
      `permanent` is for application teardown and nothing else. A hidden panel
      comes back; a quitting host does not, and an evalScript dispatched into a
      host that is unloading its extensions is the same class of problem as the
      one that crashed 1.9.0.
    */
    function stopPolling(permanent) {
        if (permanent) pollStopped = true;
        if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
    }

    /*
      Coming back from hidden is the one moment the panel cannot account for.

      Anything could have happened while it was not polling, including the one
      case the host's document-key check cannot catch on its own: the same file
      closed and reopened from the same path, which produces a matching key over
      dead handles. So the handles go, unconditionally, before anything asks for
      one. Then re-read, because the reading on screen is however old the panel
      has been away.
    */
    function resumePolling() {
        if (pollStopped) return;
        quietPolls = 0;
        BRIDGE.call('wcagDropHandles', [], function () {
            state.reload = true;
            schedulePoll(0);
        });
    }

    /*
      Ask the host to tell us when to be quiet.

      None of these is guaranteed to fire on every Illustrator build, and that is
      fine: they are an optimisation on top of the backoff, not a dependency. If
      the host says nothing the panel still steps itself down.
    */
    function watchHostLifecycle() {
        try {
            document.addEventListener('visibilitychange', function () {
                panelVisible = !document.hidden;
                if (panelVisible) resumePolling(); else stopPolling(false);
            });
        } catch (eVis) {}

        if (!BRIDGE.onHostEvent) return;

        BRIDGE.onHostEvent('com.adobe.csxs.events.WindowVisibilityChanged', function (ev) {
            var visible = true;
            try {
                var d = ev && ev.data;
                if (d === false || d === 'false' || (d && d.visible === false)) visible = false;
            } catch (eData) {}
            panelVisible = visible;
            if (visible) resumePolling(); else stopPolling(false);
        });

        BRIDGE.onHostEvent('applicationBeforeQuit', function () { stopPolling(true); });
        BRIDGE.onHostEvent('com.adobe.csxs.events.ApplicationBeforeQuit', function () { stopPolling(true); });
    }

    function pollSignature() {
        /*
          Tell the host what we are measuring.

          The background is found by geometry and is not part of the selection,
          so recolouring it moved nothing in the signature and the panel showed
          a stale ratio indefinitely. Sending the tokens costs one registry
          lookup each on the host side.
        */
        if (pollStopped || !panelVisible) { stopPolling(false); return; }

        BRIDGE.call('wcagSelectionSignature', [], function (res) {
            /*
              Schedule the next poll first. Anything below this line that throws
              would otherwise take the whole loop with it, and the panel would
              sit there looking connected while quietly never updating again.
            */
            var healthy = !!(res && res.ok);

            if (!healthy) {
                /*
                  A host that did not answer needs less traffic, not the same
                  amount three times slower. 1.9.0 counted these and then went
                  straight back to full rate on the next reply, so a struggling
                  Illustrator got no relief from the one thing that could give it
                  any. Drop to resting and let a real change wake us.
                */
                quietPolls = POLL_REST_AFTER;
                schedulePoll();
                setStatus('Not connected', 'err');
                return;
            }

            /*
              Step the rate down when nothing is happening, and snap it straight
              back the moment something does. `changed` is computed once here and
              reused below so the two cannot disagree.
            */
            var changed = state.reload || res.sig !== state.signature;
            quietPolls = changed ? 0 : quietPolls + 1;
            schedulePoll();

            /*
              Two separate questions, which used to share one field.

              `state.signature = ''` was the idiom for "re-read the selection",
              and it worked — at the cost of destroying the record of what the
              artwork actually was. A colour pinned in that window recorded an
              empty signature, and the notice that says "this colour is not from
              this artwork" could then never fire for it. Keep the identity in
              `signature` and the request in `reload`.
            */
            if (changed) {
                /*
                  A forced reload is the panel re-reading after its own edit; a
                  signature change is the user selecting something else. Only the
                  second invalidates a held frame.

                  The FIRST read is neither. `state.signature` starts empty, so
                  without that guard the opening poll counted as "the user
                  selected something else" — and if it landed after a render had
                  begun (the CEP queue is serialised, so a Diagnose ahead of it
                  is enough), it threw the render away before it was ever shown.
                */
                var realChange = !state.reload &&
                                 state.signature !== '' &&
                                 selectionPart(res.sig) !== selectionPart(state.signature);

                // A size picked from the outlined type note was about that artwork.
                if (realChange && state.sizeHinted) {
                    state.sizeHinted = false;
                    state.sizeMode = 'auto';
                    paintSegment('seg-size', 'auto');
                }
                state.reload = false;
                state.signature = res.sig;
                lastBeat = nowMs();
                loadSelection(realChange);
            } else if (state.payload && state.payload.ok && beatSafe() &&
                       nowMs() - lastBeat >= beatGap()) {
                /*
                  Nothing in the selection moved, but the background this reading
                  is measured against may have been recoloured elsewhere in the
                  document. Re-read to find out.

                  This is the reference-free replacement for the watched-token
                  stamps that crashed 1.9.0. wcagSelection resolves every item
                  fresh inside its own call, so nothing is held across calls and
                  there is no handle here that Illustrator can free underneath us.
                */
                lastBeat = nowMs();
                loadSelection(false);
            }

            /*
              The document itself, when it changes.

              Document info was read exactly once, at boot. Illustrator restores
              panels BEFORE it restores documents, so the common case was a CMYK
              caveat describing a file that was no longer open.

              The signature's first field is the document; watch that, not the
              whole string, or every click would re-read the document info.
            */
            var stem = String(res.sig).split('|')[0];
            if (stem !== state.docStem) {
                state.docStem = stem;
                loadDocInfo();
            }
        });
    }

    /*
      The signature with the watched-object stamps removed: what is left
      identifies the SELECTION.

      The signature carries two kinds of field — the selection itself, and
      `w0:`/`w1:` stamps for the objects the panel asked to watch. Those stamps
      appear as soon as the panel has a payload to name them from, so the second
      poll of every session differed from the first for no reason but their
      arrival. Read as a selection change, that discarded a held Illustrator
      render before it had ever been seen.
    */
    function selectionPart(sig) {
        var fields = String(sig).split('|');
        var kept = [];
        for (var i = 0; i < fields.length; i++) {
            if (!/^w\d+:/.test(fields[i])) kept.push(fields[i]);
        }
        return kept.join('|');
    }

    function loadSelection(realChange) {
        BRIDGE.call('wcagSelection', [], function (res) {
            if (!res.ok) {
                state.payload = null;
                clearSampleState(realChange);
                renderAll();
                setStatus('', '');
                return;
            }

            state.payload = res;
            clearSampleState(realChange);
            renderAll();
            setStatus('', '');
        });
    }

    /*
      A new selection invalidates every sampled colour. Always.

      What it must NOT invalidate is a pick still in progress: the pointer is out
      over the artboard while the loupe tracks, so a selection change mid-pick is
      expected, and cancelling on it made the eyedropper unusable.

      Those are two different things, and conflating them was worse than either
      bug alone. Holding the samples too meant a colour eyedropped from the old
      selection was silently measured against the new one — a confident ratio
      built from two unrelated objects, which is exactly the failure this panel
      refuses to make anywhere else.
    */
    function clearSampleState(realChange) {
        // A drag against the old artwork means nothing against the new.
        clearDrafts();
        state.dragging = null;

        /*
          A held frame belongs to the artwork it was captured from.

          Selecting something else left the old still on screen, inviting "click
          a pixel to set the background" — and the click committed a pixel of the
          PREVIOUS selection as the new one's background, with no notice, because
          the pinned-colour warning compares against the signature at pick time
          and the mismatch happened before the pick.

          Only on a genuine change: a forced reload (state.reload) is how the
          panel re-reads after its own click-to-pick, and dropping the frame
          there would break refining inside it.
        */
        if (realChange && (state.preview.frozen || previewImage)) {
            state.preview.frozen = false;
            previewImage = null;
            previewMap = null;
            state.preview.mode = 'idle';
            clearCanvas();
            setPreviewEmpty(idleMessage());
            paintPreviewSize();
            updateHint();
        }

        /*
          A hand-picked colour is a deliberate override and outlives a change of
          selection — the click that picked it may well have BEEN the change of
          selection. What makes that safe is that it is impossible to miss: the
          Auto chip is dimmed and the button carries the colour, so a stale
          reading announces itself instead of hiding.
        */
        if (!state.pinned) {
            state.pickFg = null;
            state.pickBg = null;
            state.pickSource = '';
        }
        state.fixTargetAuto = true;

        if (!state.pinned) {
            show(el('marker-fg'), false);
            show(el('marker-bg'), false);
        }

        // Keep the armed slot only while a pick is actually under way.
        if (!state.preview.live && !state.preview.frozen) state.picking = null;

        paintPickButtons();
    }

    // -----------------------------------------------------------------------
    // Document info
    // -----------------------------------------------------------------------

    function loadDocInfo() {
        BRIDGE.call('wcagPing', [], function (ping) {
            if (!ping) return;
            if (ping.tempFolder && ping.tempFolder !== state.tempFolder) {
                state.tempFolder = ping.tempFolder;
                /*
                  The sweep at boot ran before the host had named its temp
                  folder, so it wrote its stop file to a guess and a helper
                  left behind by a reloaded panel kept polling. Sweep again
                  now that the folder is known, unless a pick is underway.
                */
                if (BRIDGE.sweepOrphanServers && !state.preview.live) {
                    BRIDGE.sweepOrphanServers(previewFolder());
                }
            }
            // Authoritative platform, straight from ExtendScript's $.os.
            if (ping.os) BRIDGE.setPlatform(ping.os);
            /*
              The version the HOST reports, which is the code Illustrator loaded.
              With Diagnose gone this is the one place a user can read it off
              when filing a bug, and it cannot name a build that is not running.
            */
            if (ping.version) setText('panel-version', 'Version ' + ping.version);
        });

        BRIDGE.call('wcagDocInfo', [], function (res) {
            if (!res.ok) {
                setText('doc-note', res.error || 'No document open.');
                return;
            }

            state.docName = res.name;
            var spaceChanged = state.colorSpace !== res.colorSpace;
            state.colorSpace = res.colorSpace;
            /*
              The colour space decides the medium in Auto, and the medium decides
              what counts as large text. Document info can arrive after the first
              reading has already been drawn, so redraw when it changes rather than
              leaving a verdict graded for the wrong medium on screen.
            */
            if (spaceChanged && state.medium === 'auto' && state.payload) renderAll();

            setText('doc-note', res.name + ' · ' + res.colorSpace +
                (res.colorSpace === 'CMYK'
                    ? '. Ratios are converted to sRGB and approximate.'
                    : ''));
        });
    }

    // -----------------------------------------------------------------------
    // Wiring
    // -----------------------------------------------------------------------

    function bindSegment(id, onPick) {
        var group = el(id);
        group.addEventListener('click', function (event) {
            var button = event.target.closest('button');
            if (!button) return;
            paintSegment(id, button.getAttribute('data-value'));
            onPick(button.getAttribute('data-value'));
        });
    }

    // A segmented control is a radio group; say so, and keep it honest when the
    // value is changed from somewhere else (the header chip, or a saved setting).
    function paintSegment(id, value) {
        var group = el(id);
        if (!group) return;
        var all = group.querySelectorAll('button');
        for (var i = 0; i < all.length; i++) {
            var on = all[i].getAttribute('data-value') === value;
            all[i].classList[on ? 'add' : 'remove']('on');
            all[i].setAttribute('aria-pressed', on ? 'true' : 'false');
        }
    }

    /*
      One setting, two places to change it.

      The target level is what every verdict on screen MEANS, so it now sits in
      the header where it is always visible — but it is also in the popover,
      where people first find it. Route both through here so they cannot disagree.
    */
    function setLevel(value) {
        if (value !== 'AA' && value !== 'AAA') return;
        state.level = value;
        savePrefs();
        paintSegment('seg-level', value);
        paintLevelSwitch();
        renderAll();
    }

    /*
      Everything on screen that names the target level, painted together: the
      header switch, the tinted column in the results table, and the footnote.

      The footnote names the criteria the level actually applies. At AA that is
      1.4.3 and 1.4.11; AAA adds 1.4.6 on top of them, because conforming at AAA
      means meeting the AA criteria as well.
    */
    function paintLevelSwitch() {
        var aaa = state.level === 'AAA';
        var parts = [['level-aa', 'col-aa', 'th-aa', !aaa],
                     ['level-aaa', 'col-aaa', 'th-aaa', aaa]];

        for (var i = 0; i < parts.length; i++) {
            var on = parts[i][3];
            var button = el(parts[i][0]);
            if (button) {
                button.className = 'level-opt' + (on ? ' on' : '');
                button.setAttribute('aria-pressed', on ? 'true' : 'false');
            }
            var col = el(parts[i][1]);
            if (col) col.className = on ? 'sel' : '';
            var head = el(parts[i][2]);
            if (head) head.className = on ? 'sel' : '';
        }

        // Kept to one line at the panel's 220px minimum: with three criteria the
        // old "SC 1.4.3 · 1.4.6 · 1.4.11" form wrapped. The numbers alone are
        // unambiguous next to "WCAG 2.2", and opening the line names each one.
        setText('conformance-line', 'WCAG 2.2 ' + state.level + ' · ' +
            (aaa ? '1.4.3, 1.4.6, 1.4.11' : '1.4.3, 1.4.11'));
    }

    function wire() {
        /*
          Options behave like a native Illustrator panel menu: a popover under
          the gear, over the content, dismissed by clicking away or pressing Esc.
        */
        var focusBeforeOptions = null;

        function setOptionsOpen(open) {
            var wasOpen = !el('options').hidden;
            show(el('options'), open);
            show(el('options-scrim'), open);
            el('btn-options').setAttribute('aria-expanded', open ? 'true' : 'false');

            if (open) {
                focusBeforeOptions = document.activeElement;
                var first = el('options').querySelector('button, input, select');
                if (first) { try { first.focus(); } catch (e) {} }
                return;
            }

            /*
              Put focus back where it came from.

              Closing used to hide the popover and leave activeElement on BODY,
              so the next Tab restarted at the top of the panel — WCAG 2.4.3, and
              genuinely disorienting on a 240px panel with twenty controls.
            */
            if (wasOpen) {
                var back = focusBeforeOptions || el('btn-options');
                focusBeforeOptions = null;
                try { back.focus(); } catch (e2) {
                    try { el('btn-options').focus(); } catch (e3) {}
                }
            }
        }

        /*
          Keep Tab inside the popover while it is open.

          The scrim blocks the mouse and nothing blocks the keyboard, so nine
          Tabs walked out to the controls behind it — including the eyedropper,
          which could then be ARMED from behind a dialog the user cannot see
          past, with Esc captured by the popover so the loupe could not be
          cancelled. A screen grab running under a modal nobody knows is running.
        */
        function trapTab(event) {
            if (event.key !== 'Tab' || el('options').hidden) return;

            /*
              `summary` is focusable and is none of the others — leaving it out
              made the trap miscount which element was last, so Tab from the
              disclosure walked straight past the boundary it is meant to hold.
            */
            var focusables = el('options').querySelectorAll(
                'button, input, select, textarea, summary, [tabindex]:not([tabindex="-1"])');
            var live = [];
            for (var i = 0; i < focusables.length; i++) {
                if (!focusables[i].hidden && focusables[i].offsetParent !== null) {
                    live.push(focusables[i]);
                }
            }
            if (!live.length) return;

            var first = live[0];
            var last = live[live.length - 1];
            var here = document.activeElement;

            if (event.shiftKey && (here === first || !el('options').contains(here))) {
                event.preventDefault();
                try { last.focus(); } catch (e) {}
            } else if (!event.shiftKey && (here === last || !el('options').contains(here))) {
                event.preventDefault();
                try { first.focus(); } catch (e2) {}
            }
        }
        document.addEventListener('keydown', trapTab, true);

        el('btn-options').addEventListener('click', function () {
            setOptionsOpen(el('options').hidden);
        });
        el('btn-options-close').addEventListener('click', function () {
            setOptionsOpen(false);
        });
        el('options-scrim').addEventListener('click', function () {
            setOptionsOpen(false);
        });

        /*
          Where the pointer is relative to the panel.

          `mouseover` rather than `mouseenter`: CEP panels can be entered without
          a crossing event when the window is raised under a stationary pointer,
          and mouseover fires on every move inside, so a missed enter repairs
          itself on the next pixel of movement. `mouseout` with no relatedTarget
          is the pointer leaving the document entirely.
        */
        document.addEventListener('mouseover', function () {
            state.preview.overPanel = true;
        }, true);
        document.addEventListener('mousemove', function () {
            state.preview.overPanel = true;
        }, true);
        document.addEventListener('mouseout', function (e) {
            if (!e.relatedTarget) state.preview.overPanel = false;
        }, true);
        window.addEventListener('blur', function () {
            // The panel losing focus means the click went somewhere else, which
            // is exactly the case the screen detector is for.
            state.preview.overPanel = false;
        });

        /*
          One keyboard handler, in priority order.

          Enter and Space have to be intercepted while the loupe is live: the
          button that armed it still has focus, so left alone the browser would
          fire its click and disarm the very thing the user is trying to confirm.
        */
        document.addEventListener('keydown', function (e) {
            if (e.key === 'Escape') {
                if (!el('options').hidden) { setOptionsOpen(false); return; }
                /*
                  Escalating, and in that order.

                  Esc used to cancel a pick in progress and stop there, while the
                  hint said "Esc clears" — it did not: the locked colours stayed,
                  the chip stayed dimmed, and the only way back to the artwork's
                  own colours was the Auto chip, which the hint never named.
                */
                if (state.preview.live || state.preview.frozen) {
                    e.preventDefault();
                    cancelPicking();
                    return;
                }
                if (state.pinned) {
                    e.preventDefault();
                    clearSamples();
                }
                return;
            }

            if (!state.preview.live) return;

            if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
                e.preventDefault();
                e.stopPropagation();
                freezeAndPick();
            }
        });

        // Clicking the label lets the user override which colour moves.
        el('fix-target').addEventListener('click', function () {
            if (!state.fixes.length && state.fixTargetAuto) return;
            state.fixTargetAuto = false;
            state.fixTarget = state.fixTarget === 'fg' ? 'bg' : 'fg';
            renderAll();
        });

        /*
          TEXT AND BG ARE EYEDROPPERS. ONE PRESS, NOT TWO.

          They always started the loupe — except when a frozen frame was being
          held, where they set the slot and returned, leaving the user looking at
          a stale still of somewhere they sampled a minute ago. Pressing the
          button appeared to do nothing, so people pressed the eyedropper next,
          and the tool taught them a two-step gesture it never needed.

          Refining inside a held frame is still available, and is the thing it
          was always meant to be: a click directly on the pixel in that frame.
          Pressing Text or Bg means "start again on this slot".
        */
        function armSlot(which, button) {
            // Toggling off an already-armed slot.
            if (state.picking === which && state.preview.live) {
                cancelPicking();
                return;
            }

            /*
              Switching slots is starting a new session, not continuing one.

              The guard above only catches re-clicking the SAME slot, so clicking
              Bg while Fg was armed fell straight through to startLoupe. That
              cleared state.preview.heldSelection and immediately took a second
              hold, and because releaseHeldSelection early-returns on that flag
              the first hold was never given back. The host kept live page item
              references in $.global.WCAG_HELD indefinitely, including across a
              document close, which is the same dangling-handle exposure that
              crashed 1.9.0 from the poll.
            */
            if (state.preview.live || state.preview.heldSelection) stopLoupe(false);

            state.picking = which;

            // The arming button keeps focus otherwise, and then Space would
            // press it again instead of locking the colour.
            try { if (button) button.blur(); } catch (e) {}

            // A held frame is last week's news the moment a fresh pick is asked
            // for. Drop it rather than inviting a click into it.
            if (state.preview.frozen) state.preview.frozen = false;

            startLoupe(which);
        }

        el('btn-pick-fg').addEventListener('click', function () {
            armSlot('fg', el('btn-pick-fg'));
        });
        el('btn-pick-bg').addEventListener('click', function () {
            armSlot('bg', el('btn-pick-bg'));
        });

        el('mode-chip').addEventListener('click', clearSamples);
        bindSliders();

        /*
          Click a swatch to copy its hex.

          The number is right there and you almost always want it somewhere else
          — a spec, a ticket, a stylesheet. Selecting it by hand is impossible
          because the panel disables text selection to stop drag-selects while
          picking, so without this the value is readable and unreachable.
        */
        bindCopy('swatch-fg', function () { return el('hex-fg').textContent; });
        bindCopy('swatch-bg', function () { return el('hex-bg').textContent; });

        // The eyedropper: start the loupe, defaulting to the background, which
        // is what people are usually chasing on a gradient or a photo.
        el('btn-camera').addEventListener('click', function () {
            if (state.preview.live) { cancelPicking(); return; }
            try { el('btn-camera').blur(); } catch (e) {}
            clearCaptureNote();
            startLoupe(state.picking || 'bg');
        });

        // Colour-managed alternative: ask Illustrator to render, and hold it.

        el('snapshot').addEventListener('click', function (event) {
            if (!state.preview.frozen) return;
            var point = imagePixelAtEvent(event);
            if (!point) return;

            var hit = sampleImagePixel(point);
            if (!hit) return;

            // A refining click goes back to the slot that was just filled.
            if (!state.picking) state.picking = state.lastSlot || 'bg';
            commitSample(hit, 'screen');
        });

        bindSegment('seg-level', function (value) { setLevel(value); });
        bindSegment('seg-medium', function (value) {
            state.medium = value;
            savePrefs();
            renderAll();
        });
        bindSegment('seg-size', function (value) {
            state.sizeMode = value;
            state.sizeHinted = false;   // chosen here, deliberately, so it is the user's setting
            savePrefs();
            renderAll();
        });

        // The header switch and the popover's segmented control are two views
        // of one setting; either must move the other.
        el('level-aa').addEventListener('click', function () { setLevel('AA'); });
        el('level-aaa').addEventListener('click', function () { setLevel('AAA'); });

        /*
          The footnote opens downward from the foot of the panel. In a docked
          panel taller than its content that is off screen, so bring the
          thresholds into view rather than leave the click looking like it did
          nothing.
        */
        var footnote = el('footnote');
        if (footnote) {
            footnote.addEventListener('toggle', function () {
                if (!footnote.open || !footnote.scrollIntoView) return;
                try { footnote.scrollIntoView({ block: 'nearest' }); } catch (e) {}
            });
        }

        el('opt-rendered').addEventListener('change', function () {
            state.useRendered = el('opt-rendered').checked;
            savePrefs();
            renderAll();
        });

        /*
          Anything that leaves the panel, opened in a real browser.

          Deliberately not an <a href>: a CEP panel is a chrome-less webview, so
          a normal link replaces the extension with a web page and leaves no way
          back. Outside CEP — the test harness — there is nothing to open, and
          showing the URL beats failing silently.
        */
        // When no browser can be opened, the URL is shown beside the button that
        // asked for it, so it can be copied by hand.
        function bindExternal(id, url, noteId) {
            el(id).addEventListener('click', function () {
                var opened = BRIDGE.openExternal && BRIDGE.openExternal(url);
                if (!opened) setText(noteId || 'doc-note', url);
            });
        }

        bindExternal('btn-wcag-link', 'https://www.w3.org/TR/WCAG22/#contrast-minimum', 'spec-note');
        bindExternal('btn-site', 'https://artchemylabs.com');
        bindExternal('btn-kofi', 'https://ko-fi.com/artchemylabs');

        window.addEventListener('resize', function () {
            if (previewImage) drawPreview();
            else clearCanvas();
        });
    }

    /*
      Only a real colour goes on the clipboard.

      #hex-bg reads "gradient" when the background is a ramp, and the copy
      handler put that literal word on the clipboard with the confirmation
      "gradient copied".
    */
    function bindCopy(id, getValue) {
        var node = el(id);
        if (!node) return;

        node.setAttribute('role', 'button');
        node.setAttribute('tabindex', '0');
        node.title = 'Click to copy this hex';

        function copy() {
            var value = getValue();
            // A hex, or nothing. #hex-bg reads "gradient" over a ramp, and that
            // literal word was going on the clipboard as though it were a colour.
            if (!value || !/^#[0-9A-Fa-f]{6}$/.test(value)) return;

            var field = document.createElement('textarea');
            field.value = value;
            field.setAttribute('readonly', 'readonly');
            field.style.position = 'fixed';
            field.style.opacity = '0';
            document.body.appendChild(field);

            var done = false;
            try {
                field.select();
                done = document.execCommand('copy');
            } catch (e) {}
            document.body.removeChild(field);

            node.classList.add('copied');
            setTimeout(function () { node.classList.remove('copied'); }, 900);
            setFixNote(done ? value + ' copied' : 'Could not copy ' + value, true);
        }

        node.addEventListener('click', copy);
        node.addEventListener('keydown', function (e) {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); copy(); }
        });
    }

    /*
      What the panel believes, as data, for the test harness only.

      Diagnose used to print these facts into a report. Diagnose is gone, but the
      panel suite still has to see the eyedropper's internals, its frame count and
      which pointer path it is on, and nothing on screen shows those. So the same
      facts are exposed here, and only when the harness sets __UMBRA_TEST__ on the
      window before the panel loads. Nothing inside Illustrator sets it, so in a
      real install this function is never reachable from outside.
    */
    function testProbe() {
        var p = state.payload;
        var nothing = !(p && p.ok) && !state.pickFg && !state.pickBg;
        var blocked = nothing ? null : unreadableReason();
        var ratio = null;
        if (!nothing && !blocked) {
            var bg = backgroundColour();
            var fg = foregroundColour(bg);
            ratio = C.displayRatio(C.contrastRatio(fg, bg));
        }
        return {
            measurable: nothing ? 'nothing' : (blocked ? 'blocked' : 'yes'),
            ratio: ratio,
            sizeClass: activeSizeClass(),
            fixes: state.fixes.length,
            mode: state.preview.mode,
            live: !!state.preview.live,
            frozen: !!state.preview.frozen,
            frames: state.preview.frames,
            pointerServer: (BRIDGE.pointerServerLive && BRIDGE.pointerServerLive()) ? 'fast'
                : (state.preview.live ? 'slow' : 'idle'),
            captureDetail: state.captureDetail || '',
            tainted: !!state.canvasMayBeTainted,
            pickSource: state.pickSource || ''
        };
    }
    // -----------------------------------------------------------------------
    // Boot
    // -----------------------------------------------------------------------

    var booted = false;

    function boot() {
        // Binding twice would make every click fire twice and cancel itself out.
        if (booted) return;
        booted = true;

        if (window.__UMBRA_TEST__) window.__umbraProbe = testProbe;

        if (!BRIDGE.available()) {
            setStatus('Not connected', 'err');
            setText('ratio-note', 'This panel must run inside Illustrator.');
            return;
        }

        wire();

        /*
          Settings first, then paint. Loading them after the first render made the
          panel show an AA verdict for a moment before correcting itself to AAA,
          which reads as the tool changing its mind.
        */
        loadPrefs();
        paintSegment('seg-level', state.level);
        paintSegment('seg-size', state.sizeMode);
        paintSegment('seg-medium', state.medium);
        paintLevelSwitch();
        el('opt-rendered').checked = state.useRendered;

        /*
          A panel reload does not reliably run beforeunload, so a pointer server
          can outlive the page that started it. Clear any survivor before the
          user arms a new one.
        */
        if (BRIDGE.sweepOrphanServers) BRIDGE.sweepOrphanServers(previewFolder());
        loadDocInfo();
        renderAll();
        paintPickButtons();
        setPreviewEmpty(idleMessage());
        clearCanvas();
        setStatus('', '');

        // Before the first poll, so a host that is already quitting or already
        // hidden is heard before the panel starts talking to it.
        watchHostLifecycle();
        pollSignature();

        // Renders pile up in the temp folder; clear them on the way out.
        window.addEventListener('beforeunload', function () {
            /*
              First, and permanently. beforeunload means this page is going away,
              and an evalScript dispatched into a host that is tearing down its
              extensions is exactly the kind of badly-timed call this version
              exists to stop making.
            */
            stopPolling(true);
            stopLoupe(false);
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }

}());
