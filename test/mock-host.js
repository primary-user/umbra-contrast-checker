/*
  Mock Illustrator host.

  Reproduces the JSON payloads host/index.jsx returns, so the panel can be driven
  outside Illustrator. Shared by run-panel.js (jsdom) and run-render.js (Chromium). The fixtures describe a generic CMYK layout: a teal panel (#0E8C82) with 12pt
  white body text, a blue banner (#1B4E9B) with a 28pt white heading, a lilac
  callout, a gradient hero, and a half-opacity footer.
*/

function makeHost() {
    var scenario = 'teal';
    var applied = [];
    var sigCounter = 0;
    var failApply = false;
    var screenBlocked = false;
    var processMissing = false;
    var processCalls = [];
    var written = {};

    /*
      Where the mock pretends the pointer is, and what region the helper script
      would have grabbed. Format matches the real sidecar exactly:
        cursorX cursorY regionX regionY sizeInPoints
      A 128-point region grabbed at (36, 36) with the pointer at (100, 100) puts
      the pointer 64 points in — pixel (2, 2) on the 4x4 fixture, and (48, 48)
      on the 96x96 one the render suite uses.
    */
    var loupePos = '100 100 36 36 128';

    /*
      What the pointer server writes: "x y deskLeft deskTop deskRight deskBottom tick".

      The tick is a heartbeat, so a live server must keep advancing it — a mock
      that returned a constant line would look dead to the panel and every test
      would silently fall back to the slow path after a second. Six fields here
      means "alive": the tick is appended and incremented on each read. Pass a
      seventh field explicitly to pin it, which is how a dead server is faked.
    */
    var pointerLine = '100 100 0 0 1920 1080';
    var pointerTick = 0;
    var pointerServerBroken = false;
    var heldSelection = false;
    var releases = 0;

    function pointerReading() {
        var fields = pointerLine.split(/\s+/);
        if (fields.length >= 7) return pointerLine;
        pointerTick++;
        return pointerLine + ' ' + pointerTick;
    }
    var helperMissing = false;   // the helper script never ran at all
    var colorSpace = 'CMYK';     // what wcagDocInfo reports; decides the medium in Auto

    var SCENARIOS = {
        teal: {
            signature: 'n1|TextFrame:1200,-28400,3100',
            selection: {
                ok: true, selectionCount: 1, autoBackground: true,
                foreground: {
                    token: 's1', tokens: ['s1'], label: 'Body copy line', kind: 'solid',
                    rgb: [255, 255, 255], alpha: 1, blend: 'normal',
                    isText: true, pointSize: 12, bold: false, sizeClass: 'normal'
                },
                background: {
                    token: 's2', tokens: ['s2'], label: 'teal panel', kind: 'solid',
                    rgb: [14, 140, 130], alpha: 1, blend: 'normal'
                },
                backdrops: []
            }
        },

        blueHeading: {
            signature: 'n1|TextFrame:1000,-1800,4000',
            selection: {
                ok: true, selectionCount: 1, autoBackground: true,
                foreground: {
                    token: 's5', label: 'What you need to know', kind: 'solid',
                    rgb: [255, 255, 255], alpha: 1, blend: 'normal',
                    isText: true, pointSize: 28, bold: true, sizeClass: 'large'
                },
                background: {
                    token: 's6', label: 'blue banner', kind: 'solid',
                    rgb: [27, 78, 155], alpha: 1, blend: 'normal'
                },
                backdrops: []
            }
        },

        // Half-opacity black text on an 80% teal block over paper.
        transparent: {
            signature: 'n1|TextFrame:900,-2200,2000',
            selection: {
                ok: true, selectionCount: 1, autoBackground: true,
                foreground: {
                    token: 's7', label: 'Footer disclaimer', kind: 'solid',
                    rgb: [0, 0, 0], alpha: 0.5, blend: 'normal',
                    isText: true, pointSize: 8, bold: false, sizeClass: 'normal'
                },
                background: {
                    token: 's8', label: 'tint block', kind: 'solid',
                    rgb: [14, 140, 130], alpha: 0.8, blend: 'normal'
                },
                backdrops: []
            }
        },

        gradient: {
            signature: 'n1|TextFrame:400,-900,2600',
            selection: {
                ok: true, selectionCount: 1, autoBackground: true,
                foreground: {
                    token: 's3', label: 'Overlay headline', kind: 'solid',
                    rgb: [255, 255, 255], alpha: 1, blend: 'normal',
                    isText: true, pointSize: 14, bold: false, sizeClass: 'normal'
                },
                /*
                  A real gradient carries its stops. The panel grades the WORST
                  of them and reports the range; averaging would let black text
                  pass on a ramp it vanishes into at one end.
                */
                background: {
                    token: 's4', label: 'hero gradient', kind: 'gradient',
                    rgb: null, alpha: 1, alphaOverBackground: 1,
                    blend: 'normal', blendOverBackground: 'normal',
                    stops: [
                        { rgb: [255, 255, 255], alpha: 1 },
                        { rgb: [16, 16, 16], alpha: 1 }
                    ]
                },
                backdrops: [], shared: { alpha: 1, blend: 'normal', name: '', kind: '' }
            }
        },

        /*
          White text over a placed photo. The host reports kind 'image' with no
          rgb; before it did, a raster read as "no fill" and the backdrop search
          stepped straight through it onto the white card underneath — 12.63:1,
          a confident AAA pass, for artwork that renders at about 1.42.
        */
        photo: {
            signature: 'n1|TextFrame:700,-1500,2200',
            selection: {
                ok: true, selectionCount: 1, autoBackground: true,
                foreground: {
                    token: 'p1', label: 'Caption over photo', kind: 'solid',
                    rgb: [255, 255, 255], alpha: 1, alphaOverBackground: 1,
                    blend: 'normal', blendOverBackground: 'normal',
                    isText: true, pointSize: 11, bold: false, sizeClass: 'normal'
                },
                background: {
                    token: 'p2', label: 'hero photograph', kind: 'image',
                    rgb: null, alpha: 1, alphaOverBackground: 1,
                    blend: 'normal', blendOverBackground: 'normal'
                },
                backdrops: [], shared: { alpha: 1, blend: 'normal', name: '', kind: '' }
            }
        },

        noBackground: {
            signature: 'n1|TextFrame:100,-100,900',
            selection: {
                ok: true, selectionCount: 1, autoBackground: true,
                foreground: {
                    token: 's9', label: 'Floating caption', kind: 'solid',
                    rgb: [180, 180, 180], alpha: 1, blend: 'normal',
                    isText: true, pointSize: 9, bold: false, sizeClass: 'normal'
                },
                background: null,
                backdrops: []
            }
        },

        // Outlined text: one group, 47 compound paths, all the same black.
        outlined: {
            signature: 'n1|GroupItem:500,-1200,3400',
            selection: {
                ok: true, selectionCount: 47, autoBackground: true,
                foreground: {
                    token: 'o1',
                    tokens: (function () {
                        var t = [];
                        for (var i = 1; i <= 47; i++) t.push('o' + i);
                        return t;
                    }()),
                    label: 'outlined headline', kind: 'solid',
                    rgb: [170, 170, 170], alpha: 1, blend: 'normal',
                    isText: false, pointSize: 0, bold: false, sizeClass: 'graphic',
                    outlineLike: true
                },
                background: {
                    token: 'o99', tokens: ['o99'], label: 'white card', kind: 'solid',
                    rgb: [255, 255, 255], alpha: 1, blend: 'normal'
                },
                backdrops: []
            }
        },

        none: {
            signature: 'none',
            selection: { ok: false, empty: true, error: 'Nothing selected.' }
        },

        /*
          Black text on #808080, both inside one group at 65% over white paper.
          Illustrator draws the group into a buffer and lays that buffer down
          once: #595959 on #ACACAC, 3.08:1, a failure. Charging the 65% to the
          background AND again to the text gives 4.86; cancelling it from the
          text gives 9.25. Both flatter the artwork, so this must read 3.08.

          This lived in the scan fixtures until the scan was removed. It is the
          main view's wiring that matters, so it is a main-view scenario now.
        */
        group: {
            signature: 'n1|TextFrame:300,-500,1200',
            selection: {
                ok: true, selectionCount: 1, autoBackground: true,
                foreground: {
                    token: 's9', label: 'Text in a faded group', kind: 'solid',
                    rgb: [0, 0, 0], alpha: 0.65, alphaOverBackground: 1,
                    blend: 'normal', blendOverBackground: 'normal',
                    isText: true, pointSize: 12, bold: false, sizeClass: 'normal'
                },
                background: {
                    token: 's10', label: 'Card', kind: 'solid',
                    rgb: [128, 128, 128], alpha: 0.65, alphaOverBackground: 1,
                    blend: 'normal', blendOverBackground: 'normal'
                },
                shared: { alpha: 0.65, blend: 'normal', name: 'Card', kind: 'group' },
                backdrops: []
            }
        },

        /*
          Text whose luminance sits between the two stops. Against the stops it
          reads 4.54 and 4.62, an AA pass at either end; a little past halfway
          the ramp is #767676 and the text vanishes. Grading the path catches it.
        */
        gradientCrossing: {
            signature: 'n1|TextFrame:410,-910,2610',
            selection: {
                ok: true, selectionCount: 1, autoBackground: true,
                foreground: {
                    token: 's11', label: 'Caption on the ramp', kind: 'solid',
                    rgb: [0x76, 0x76, 0x76], alpha: 1, blend: 'normal',
                    isText: true, pointSize: 12, bold: false, sizeClass: 'normal'
                },
                background: {
                    token: 's12', label: 'ramp', kind: 'gradient',
                    rgb: null, alpha: 1, alphaOverBackground: 1,
                    blend: 'normal', blendOverBackground: 'normal',
                    stops: [
                        { rgb: [255, 255, 255], alpha: 1, rampPoint: 0 },
                        { rgb: [0, 0, 0], alpha: 1, rampPoint: 100 }
                    ]
                },
                backdrops: [], shared: { alpha: 1, blend: 'normal', name: '', kind: '' }
            }
        },

        /*
          An 18 unit heading in white on mid grey: 3.94:1. In print that is large
          text and passes AA at 3:1. On screen 18 units is 18 CSS px, which is
          body text, and needs 4.5:1. Same artwork, opposite verdicts, and the
          medium is the only thing that decides between them.
        */
        /*
          One frame, two colours. The host hands the black run over first, as
          the frame's representative colour: 21:1, a pass. The grey run beside
          it reads 4.54 against white, so it is the weakest part, and the one
          a fix has to replace.
        */
        mixedText: {
            signature: 'n1|TextFrame:500,-600,3000',
            selection: {
                ok: true, selectionCount: 1, autoBackground: true,
                foreground: {
                    token: 's21', tokens: ['s21'], label: 'Sale ends Friday', kind: 'solid',
                    rgb: [0, 0, 0], alpha: 1, blend: 'normal',
                    isText: true, pointSize: 12, bold: false, sizeClass: 'normal',
                    runs: [
                        { rgb: [0, 0, 0], pointSize: 12, bold: false, chars: 5 },
                        { rgb: [118, 118, 118], pointSize: 12, bold: false, chars: 11 }
                    ],
                    unreadableRuns: 0
                },
                background: {
                    token: 's22', tokens: ['s22'], label: 'white card', kind: 'solid',
                    rgb: [255, 255, 255], alpha: 1, blend: 'normal'
                },
                backdrops: []
            }
        },

        /*
          One colour at two sizes. #888888 on white is 3.54: enough for the 24px
          headline, not for the 12px line under it. The host reports the
          headline first.
        */
        mixedSizes: {
            signature: 'n1|TextFrame:520,-620,3020',
            selection: {
                ok: true, selectionCount: 1, autoBackground: true,
                foreground: {
                    token: 's23', tokens: ['s23'], label: 'Headline and note', kind: 'solid',
                    rgb: [136, 136, 136], alpha: 1, blend: 'normal',
                    isText: true, pointSize: 24, bold: false, sizeClass: 'large',
                    runs: [
                        { rgb: [136, 136, 136], pointSize: 24, bold: false, chars: 8 },
                        { rgb: [136, 136, 136], pointSize: 12, bold: false, chars: 20 }
                    ],
                    unreadableRuns: 1
                },
                background: {
                    token: 's24', tokens: ['s24'], label: 'white card', kind: 'solid',
                    rgb: [255, 255, 255], alpha: 1, blend: 'normal'
                },
                backdrops: []
            }
        },

        heading18: {
            signature: 'n1|TextFrame:120,-300,1800',
            selection: {
                ok: true, selectionCount: 1, autoBackground: true,
                foreground: {
                    token: 's13', label: 'Section heading', kind: 'solid',
                    rgb: [255, 255, 255], alpha: 1, blend: 'normal',
                    isText: true, pointSize: 18, bold: false, sizeClass: 'large'
                },
                background: {
                    token: 's14', label: 'band', kind: 'solid',
                    rgb: [128, 128, 128], alpha: 1, blend: 'normal'
                },
                backdrops: []
            }
        },

        /*
          No crossing anywhere, and still a false pass at the stops. Gradients mix
          in gamma-encoded RGB, so red to green is darker in the middle than at
          either end: black text is 5.25 at the stops and 3.94 at worst.
        */
        gradientMuddy: {
            signature: 'n1|TextFrame:420,-920,2620',
            selection: {
                ok: true, selectionCount: 1, autoBackground: true,
                foreground: {
                    token: 's15', label: 'Label on the ramp', kind: 'solid',
                    rgb: [0, 0, 0], alpha: 1, blend: 'normal',
                    isText: true, pointSize: 12, bold: false, sizeClass: 'normal'
                },
                background: {
                    token: 's16', label: 'warm to cool ramp', kind: 'gradient',
                    rgb: null, alpha: 1, alphaOverBackground: 1,
                    blend: 'normal', blendOverBackground: 'normal',
                    stops: [
                        { rgb: [255, 0, 0], alpha: 1, rampPoint: 0 },
                        { rgb: [0, 255, 0], alpha: 1, rampPoint: 100 }
                    ]
                },
                backdrops: [], shared: { alpha: 1, blend: 'normal', name: '', kind: '' }
            }
        },

        nodoc: {
            signature: 'nodoc',
            selection: { ok: false, error: 'No document open.' }
        }
    };

    // 4x4 solid PNG — enough to exercise the preview and eyedropper paths under
    // jsdom, where nothing is really decoded. run-render.js swaps in a real
    // 96x96 patterned capture via setFramePng().
    var PNG_B64 =
        'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAHElEQVQIW2NkYGD4z4AGGEcFGRhH' +
        'A2E0EAaCAAAcOwEBoRr7WQAAAABJRU5ErkJggg==';

    var callCounts = {};
    var tokenSeq = 0;

    /*
      The real host clears its token registry and hands out new names on every
      wcagSelection. Reproduce that: anything keyed on a token name must survive
      the name changing under it.

      Colours follow the object, so tokenColours is re-keyed too — the mock's
      recolour() addresses the CURRENT name.
    */
    function reissueTokens(payload) {
        if (!payload || !payload.ok) return payload;

        ['foreground', 'background'].forEach(function (side) {
            var layer = payload[side];
            if (!layer || !layer.token) return;

            var old = layer.token;
            var fresh = old.charAt(0) + (++tokenSeq + 100);
            tokenAliases[fresh] = tokenAliases[old] || old;
            if (tokenColours[old] !== undefined) tokenColours[fresh] = tokenColours[old];

            if (layer.tokens && layer.tokens.length) {
                layer.tokens = layer.tokens.map(function (t) {
                    return t === old ? fresh : t;
                });
            }
            layer.token = fresh;
        });
        return payload;
    }

    // fresh name -> the fixture's stable name, so applies and colours still land.
    var tokenAliases = {};
    function stableToken(token) { return tokenAliases[token] || token; }

    // Which side of the current selection a set of tokens addresses.
    function sideOf(tokens) {
        var sel = SCENARIOS[scenario].selection;
        if (!sel || !sel.ok) return '';
        var names = ['foreground', 'background'];
        for (var n = 0; n < names.length; n++) {
            var layer = sel[names[n]];
            if (!layer || !layer.token) continue;
            for (var i = 0; i < tokens.length; i++) {
                if (stableToken(tokens[i]) === layer.token) return names[n];
            }
        }
        return '';
    }

    function hexToRgb(hex) {
        var h = String(hex).replace('#', '');
        return [parseInt(h.substring(0, 2), 16),
                parseInt(h.substring(2, 4), 16),
                parseInt(h.substring(4, 6), 16)];
    }

    // Write a colour onto whichever side of the current scenario owns a token.
    function applyToFixture(tokens, hex, fromHex) {
        var rgb = hexToRgb(hex);
        var from = fromHex ? hexToRgb(fromHex) : null;
        function same(a, b) { return a && b && a[0] === b[0] && a[1] === b[1] && a[2] === b[2]; }
        var sel = SCENARIOS[scenario].selection;
        if (!sel || !sel.ok) return;

        ['foreground', 'background'].forEach(function (side) {
            var layer = sel[side];
            if (!layer || !layer.token) return;
            for (var i = 0; i < tokens.length; i++) {
                // Through the alias: the panel holds whatever name the last
                // wcagSelection issued, the fixture holds its original one.
                if (stableToken(tokens[i]) !== layer.token) continue;
                // A frame with several runs changes only the runs painted the
                // colour being replaced, as the host does.
                if (layer.runs && from) {
                    layer.runs.forEach(function (run) { if (same(run.rgb, from)) run.rgb = rgb.slice(); });
                    layer.rgb = layer.runs[0].rgb.slice();
                } else {
                    layer.rgb = rgb.slice();
                }
                tokenColours[layer.token] = rgb.join(',');
                return;
            }
        });
    }
    // Colours the document holds for a given token, so a test can recolour an
    // object the panel is watching without touching the selection.
    var tokenColours = {};
    var lastWatch = '';
    var docStem = 'Sample Layout.ai#1';

    function respond(fnName, args) {
        callCounts[fnName] = (callCounts[fnName] || 0) + 1;
        switch (fnName) {
            case 'wcagPing':
                return {
                    ok: true, version: '1.13.0', appVersion: '30.7.0',
                    hasDocument: scenario !== 'nodoc',
                    tempFolder: '/tmp',
                    os: 'Macintosh OS 26.5.2/64'
                };

            case 'wcagSelectionSignature':
                /*
                  The real host stamps the colour of every token the panel says
                  it is measuring, so recolouring an object the panel is watching
                  moves the signature even when the selection has not changed.
                  Reproduce that: append each watched token's current colour.
                */
                /*
                  Stamp by POSITION, exactly as the host does — and mint a fresh
                  token name on every wcagSelection, exactly as the host does.

                  The fixture used to hold fixed names, which hid a permanent
                  feedback loop: the real host clears its registry and reissues
                  s1,s2 as s3,s4 on every read, so a signature containing token
                  NAMES always differed and the panel re-read the selection on
                  every poll — wiping any slider drag held longer than 700ms.
                  A mock that cannot reproduce that cannot catch it.
                */
                var watch = String(args[0] || '');
                var stamp = '';
                if (watch) {
                    var list = watch.split(',');
                    for (var w = 0; w < list.length; w++) {
                        var tok = list[w];
                        if (!tok) continue;
                        stamp += '|w' + w + ':' + (tokenColours[stableToken(tok)] || 'base');
                    }
                }
                lastWatch = watch;
                /*
                  The real host puts the DOCUMENT first: "name#count|n1|...".
                  The panel splits on '|' and watches that first field, so a
                  change of document re-reads the document info. Modelling every
                  scenario with the same stem made that unreachable here.
                */
                return { ok: true, sig: docStem + '|' + SCENARIOS[scenario].signature +
                                        ':' + sigCounter + stamp };

            case 'wcagSelection':
                return reissueTokens(JSON.parse(JSON.stringify(SCENARIOS[scenario].selection)));

            case 'wcagDocInfo':
                if (scenario === 'nodoc') return { ok: false, error: 'No document open.' };
                // The name follows setDocument(), the way the real one follows
                // whichever file is in front.
                return {
                    ok: true,
                    name: docStem.replace(/#\d+$/, ''),
                    colorSpace: colorSpace
                };

            case 'wcagApply':
                if (failApply) return { ok: false, error: 'That object is no longer available.' };
                var list = String(args[0]).split(',');
                /*
                  `side` as well as the token. Token names change on every
                  wcagSelection now, so a test asserting on 's2' is asserting on
                  an implementation detail; the side is the intent.
                */
                applied.push({ token: list[0], tokens: list, hex: args[1],
                               from: args[2], side: sideOf(list) });
                /*
                  Actually change the document, the way Illustrator does.

                  Recording the call without mutating the fixture made every
                  apply a no-op on the next poll: the panel wrote a colour, the
                  poll read the ORIGINAL back, and a test could not tell a
                  working apply from one that silently did nothing.
                */
                applyToFixture(list, String(args[1]), args[2] ? String(args[2]) : '');
                return { ok: true, applied: args[1], objects: list.length, subpaths: list.length, skipped: null, errors: 0 };

            case 'wcagHoldSelection':
                heldSelection = true;
                return { ok: true, count: 1, textRange: false };

            case 'wcagReleaseSelection':
                releases++;
                return { ok: true, restored: heldSelection ? 1 : 0 };

            default:
                return { ok: false, error: 'Unknown host function: ' + fnName };
        }
    }

    return {
        install: function (win) {
            win.__adobe_cep__ = {
                evalScript: function (script, cb) {
                    var m = /^(\w+)\(([\s\S]*)\)$/.exec(script);
                    if (!m) { cb('EvalScript error.'); return; }
                    var args = [];
                    if (m[2].trim().length) {
                        try { args = JSON.parse('[' + m[2] + ']'); } catch (e) { args = [m[2]]; }
                    }
                    var result = respond(m[1], args);
                    setTimeout(function () { cb(JSON.stringify(result)); }, 0);
                },
                getHostEnvironment: function () {
                    return JSON.stringify({
                        appSkinInfo: {
                            panelBackgroundColor: { color: { red: 50, green: 50, blue: 50 } }
                        }
                    });
                }
            };
            /*
              Fake the CEP filesystem and process bridges. screenBlocked mimics
              macOS refusing the screenshot: the tool "succeeds" but no file
              appears, which is exactly how a missing Screen Recording
              permission presents itself.
            */
            win.cep = {
                // CEP puts the base64 constant HERE, not on cep.fs. Reading it from
                // cep.fs yielded undefined and broke every capture path.
                encoding: { Base64: 'Base64', UTF8: 'UTF-8' },
                fs: {
                    ENCODING_BASE64: 'Base64',
                    /*
                      Path-aware on purpose: blocking the screen grab must not
                      also break Illustrator's own render, or the two failures
                      become impossible to tell apart.

                      Only honours the correct base64 constant, so passing
                      undefined fails exactly as it did in Illustrator.
                    */
                    /*
                      The loupe's sidecar is plain text and is written BEFORE
                      the capture, so a blocked screen grab leaves the sidecar
                      present and the PNG missing. That asymmetry is real, and
                      it is what lets the panel tell "macOS refused" apart from
                      "the helper never ran" — so the mock reproduces it exactly.
                    */
                    readFile: function (path, encoding) {
                        var name = String(path);

                        if (/umbra-pointer\.txt$/.test(name)) {
                            if (pointerServerBroken) return { err: 1, data: null };
                            return { err: 0, data: pointerReading() };
                        }
                        if (/\.err$/.test(name)) return { err: 1, data: null };
                        if (/\.pos$/.test(name)) {
                            if (helperMissing) return { err: 1, data: null };
                            return { err: 0, data: loupePos };
                        }

                        if ((screenBlocked || helperMissing) &&
                            /umbra-screen|umbra-loupe/.test(name)) {
                            return { err: 1, data: null };
                        }
                        if (encoding !== 'Base64') return { err: 2, data: null };
                        return { err: 0, data: PNG_B64 };
                    },
                    writeFile: function (path, data) {
                        written[String(path)] = String(data);
                        return { err: 0 };
                    },
                    stat: function (path) {
                        var name = String(path);
                        if (/\.pos$/.test(name)) {
                            return helperMissing ? { err: 1 } : { err: 0, data: { size: 32 } };
                        }
                        if ((screenBlocked || helperMissing) &&
                            /umbra-screen|umbra-loupe/.test(name)) {
                            return { err: 1 };
                        }
                        return { err: 0, data: { size: 128 } };
                    },
                    deleteFile: function () { return { err: 0 }; }
                },
                process: {
                    createProcess: function () {
                        processCalls.push(Array.prototype.slice.call(arguments));
                        if (processMissing) return { err: 1 };
                        return { err: 0, data: 4242 };
                    },
                    isRunning: function () { return { err: 0, data: false }; },
                    terminate: function () { return { err: 0 }; }
                }
            };
        },
        setScenario: function (s) { scenario = s; sigCounter++; },
        getScenario: function () { return scenario; },
        applied: function () { return applied; },
        setApplyFailure: function (v) { failApply = v; },
        setScreenBlocked: function (v) { screenBlocked = v; },
        setHelperMissing: function (v) { helperMissing = v; },
        setProcessMissing: function (v) { processMissing = v; },
        processCalls: function () { return processCalls; },
        written: function () { return written; },
        setLoupePosition: function (line) { loupePos = line; },
        setPointerLine: function (line) { pointerLine = line; },
        setPointerServerBroken: function (v) { pointerServerBroken = v; },
        selectionReleases: function () { return releases; },
        // How many times the panel asked the host for something. Lets a test
        // prove that a callback actually ran, not merely that a flag was set.
        calls: function (name) { return callCounts[name] || 0; },
        // What the panel last told the host it was measuring.
        watched: function () { return lastWatch; },
        // Bring a different document to the front, as switching windows does.
        setDocument: function (name) { docStem = name + '#1'; sigCounter++; },
        setColorSpace: function (space) { colorSpace = space; },
        /*
          Recolour an object in the document WITHOUT touching the selection —
          exactly what happens when someone edits a fill in Illustrator's own
          Color panel while the text stays selected.
        */
        recolour: function (side, rgb) {
            var sel = SCENARIOS[scenario].selection;
            var layer = sel[side];
            if (!layer) return;
            layer.rgb = rgb.slice();
            tokenColours[layer.token] = rgb.join(',');
        },
        /*
          In the host, effectiveAlpha IS the product of the chain — they cannot
          disagree. The mock keeps that contract so a test cannot set up a state
          the real thing could never produce.
        */
        setAppearance: function (side, chain) {
            var layer = SCENARIOS[scenario].selection[side];
            layer.appearance = chain;
            var alpha = 1;
            for (var i = 0; i < chain.length; i++) alpha = alpha * (chain[i].opacity / 100);
            layer.alpha = alpha;
            for (var j = 0; j < chain.length; j++) {
                if (chain[j].blend !== 'normal') { layer.blend = chain[j].blend; break; }
            }
        },
        setFramePng: function (b64) { PNG_B64 = b64; },
        /*
          A gradient FILL at partial opacity — a scrim over a photo, which is the
          canonical real case. The panel used to replace the object's opacity with
          the stop's instead of multiplying them, reporting 21.00 for artwork that
          renders at 3.95.
        */
        setGradientOpacity: function (alpha) {
            var bg = SCENARIOS.gradient.selection.background;
            bg.alpha = alpha;
            bg.alphaOverBackground = alpha;
            sigCounter++;
        },
        setGradientStops: function (stops) {
            SCENARIOS.gradient.selection.background.stops = stops;
            sigCounter++;
        },
        // Stops the host could not read: past its cap, or a colour that would
        // not resolve. The panel has to say its range may understate it.
        setStopsMissed: function (n) {
            SCENARIOS.gradient.selection.background.stopsMissed = n;
            sigCounter++;
        },
        // A gradient with unreadable stops — an older host, or a gradient whose
        // stop colours failed to resolve. Must still refuse rather than guess.
        stripGradientStops: function () {
            SCENARIOS.gradient.selection.background.stops = null;
            sigCounter++;
        }
    };
}

if (typeof module === 'object' && module.exports) {
    module.exports = { makeHost: makeHost };
}
