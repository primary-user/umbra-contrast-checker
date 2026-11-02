/*
  Umbra Contrast Checker — CEP bridge
  Copyright (c) 2026 Artchemy Labs LLC. All rights reserved.
  Use of this file is governed by the licence in LICENSE at the root of this
  project. Not for redistribution.

  Adobe ships CSInterface.js as a convenience wrapper, but it is a large file we
  would have to redistribute with its own notice. Everything this panel needs is
  three calls on the native interface CEP injects, so we talk to it directly.

  If CSInterface.js is ever dropped in alongside this file it will be preferred
  automatically, so swapping back costs nothing.
*/

(function (root) {
    'use strict';

    var native = null;

    function bridge() {
        if (native) return native;
        if (typeof window !== 'undefined' && window.__adobe_cep__) {
            native = window.__adobe_cep__;
            return native;
        }
        return null;
    }

    function available() {
        return bridge() !== null;
    }

    /*
      Run ExtendScript in Illustrator's own context.

      This is the whole reason a CEP panel works where a ScriptUI palette did
      not: evalScript executes inside the host application, so the document is
      always reachable. There is no focus problem to work around.
    */
    function evalScript(script, callback) {
        var api = bridge();
        if (!api) {
            if (callback) callback(null, new Error('Not running inside a CEP host.'));
            return;
        }
        try {
            api.evalScript(script, function (result) {
                if (callback) callback(result, null);
            });
        } catch (e) {
            if (callback) callback(null, e);
        }
    }

    /*
      One call at a time.

      evalScript runs synchronously on Illustrator's main thread. Firing a new
      one while the previous is still working — easy to do with a poll timer plus
      a user click — stacks work onto that thread and is a plausible route to a
      hang or a crash. Queue instead.
    */
    var queue = [];
    var inFlight = false;

    /*
      A timeout must not pretend the call finished.

      Releasing inFlight the moment the timer fires let the next job start while
      Illustrator was still busy with the previous one — which is precisely the
      concurrent evalScript this queue exists to prevent, and it happened exactly
      when the host was already struggling. Answer the caller so the UI is not
      stuck, but keep the slot held until the real response lands, and give the
      host a cooling-off period before the next call.
    */
    var STALL_COOLDOWN_MS = 1500;

    /*
      How long to wait after giving up on a call entirely.

      The abandon timer exists so one unanswered call cannot wedge the panel for
      ever. But releasing the slot does not mean Illustrator finished: by
      definition it never answered. Firing the next call immediately therefore
      broke the one invariant this queue exists to hold, and did it precisely
      when the host was already in trouble, so orphaned calls piled up in
      Illustrator's own script queue and all ran back to back the moment it
      recovered. Wait properly instead.
    */
    var ABANDON_COOLDOWN_MS = 5000;

    function pump() {
        if (inFlight || !queue.length) return;
        var job = queue.shift();
        inFlight = true;

        var answered = false;
        var released = false;

        function answer(result) {
            if (answered) return;
            answered = true;
            try { job.callback(result); } catch (e) {}
        }

        function release(delay) {
            if (released) return;
            released = true;
            inFlight = false;
            setTimeout(pump, delay || 0);
        }

        var limit = job.timeout || 20000;

        var timer = setTimeout(function () {
            answer({ ok: false, error: 'Illustrator did not respond in time.' });
            // Deliberately NOT released here — the host still owns the thread.
        }, limit);

        /*
          Backstop. If evalScript never calls back at all — not late, never — the
          slot above would be held for the life of the panel and nothing would
          run again. Give up on it eventually so the panel recovers instead of
          going quietly dead.
        */
        var abandon = setTimeout(function () {
            release(ABANDON_COOLDOWN_MS);
        }, limit + 30000);

        runCall(job.fnName, job.args, function (result) {
            clearTimeout(timer);
            clearTimeout(abandon);
            var wasLate = answered;
            answer(result);
            release(wasLate ? STALL_COOLDOWN_MS : 0);
        });
    }

    function call(fnName, args, callback) {
        // Never let the queue grow without bound if the host stalls.
        if (queue.length > 12) {
            callback({ ok: false, error: 'Too many pending requests.' });
            return;
        }
        queue.push({ fnName: fnName, args: args, callback: callback || function () {} });
        pump();
    }

    // Call a host function that returns JSON, and hand back a parsed object.
    function runCall(fnName, args, callback) {
        var parts = [];
        args = args || [];

        for (var i = 0; i < args.length; i++) {
            var a = args[i];
            if (a === null || a === undefined) parts.push('null');
            else if (typeof a === 'number') parts.push(String(a));
            else if (typeof a === 'boolean') parts.push(a ? 'true' : 'false');
            else parts.push(JSON.stringify(String(a)));
        }

        var script = fnName + '(' + parts.join(',') + ')';

        evalScript(script, function (raw, err) {
            if (err) { callback({ ok: false, error: err.message }); return; }
            if (raw === 'EvalScript error.') {
                callback({ ok: false, error: 'The host script failed. Check host/index.jsx loaded.' });
                return;
            }
            if (!raw) { callback({ ok: false, error: 'No response from Illustrator.' }); return; }

            var parsed;
            try {
                parsed = JSON.parse(raw);
            } catch (e) {
                callback({ ok: false, error: 'Unreadable response: ' + String(raw).substring(0, 120) });
                return;
            }
            callback(parsed);
        });
    }

    /*
      Read a file as base64, so the PNG can become a data URL — that keeps the
      canvas same-origin and therefore readable by getImageData.

      This was silently broken: the base64 constant lives on cep.encoding, NOT on
      cep.fs, so passing cep.fs.ENCODING_BASE64 handed readFile `undefined` and it
      fell back to text. Both capture paths failed on it, which looked like two
      separate bugs. Try every spelling, and report the error code rather than
      returning a bare null.
    */
    var lastReadError = '';

    function readFileBase64(path) {
        lastReadError = '';

        if (typeof window === 'undefined' || !window.cep || !window.cep.fs) {
            lastReadError = 'no cep.fs bridge';
            return null;
        }

        var encodings = [];
        try {
            if (window.cep.encoding && window.cep.encoding.Base64) {
                encodings.push(window.cep.encoding.Base64);
            }
        } catch (e) {}
        if (window.cep.fs.ENCODING_BASE64) encodings.push(window.cep.fs.ENCODING_BASE64);
        encodings.push('Base64');
        encodings.push('base64');

        var codes = [];
        for (var i = 0; i < encodings.length; i++) {
            try {
                var res = window.cep.fs.readFile(path, encodings[i]);
                if (res && res.err === 0 && res.data) return res.data;
                codes.push(String(encodings[i]) + '→err ' + (res ? res.err : '?'));
            } catch (e2) {
                codes.push(String(encodings[i]) + '→' + e2.message);
            }
        }

        lastReadError = codes.join(', ');
        return null;
    }

    function lastFileReadError() {
        return lastReadError;
    }

    // Fallback for display: the manifest allows file access, and the panel itself
    // is loaded from file://, so a direct file URL usually renders. Sampling may
    // still need the base64 route if the canvas ends up tainted.
    function fileUrl(path) {
        var normalised = String(path).replace(/\\/g, '/');
        if (normalised.charAt(0) !== '/') normalised = '/' + normalised;
        // encodeURI leaves # and ? alone, and either one truncates the path:
        // everything after a # is read as a fragment, not part of the filename.
        return 'file://' + encodeURI(normalised)
            .replace(/#/g, '%23')
            .replace(/\?/g, '%3F');
    }


    /*
      SCREEN EYEDROPPER
      =================

      Illustrator's own rasteriser (imageCapture) keeps refusing to render on some
      documents, and its errors are opaque. The screen is a second, independent
      source of truth — and arguably the more honest one, since WCAG is about what
      a reader actually sees.

      CEP can start a native process, and both platforms ship a screenshot tool:
      screencapture on macOS, .NET's CopyFromScreen via PowerShell on Windows.
      Neither needs Illustrator's cooperation, so gradients, placed photos, live
      effects and blend modes all come through exactly as displayed.

      Two costs, both worth stating plainly:
        - macOS requires Screen Recording permission for Illustrator. One-time,
          granted in System Settings, and the failure is detectable.
        - Screen pixels come from the display pipeline, so on a wide-gamut display
          they are in the display's space rather than the document's sRGB. Good
          enough for artwork we otherwise cannot measure at all; not a reason to
          stop using the colour-managed path for plain solid fills.
    */

    /*
      Platform.

      navigator.platform is unreliable — it came back empty under test, which
      silently routed a Mac down the PowerShell branch. The host knows for
      certain ($.os), so the panel sets this from wcagPing and navigator is only
      a last resort.
    */
    var platformOverride = null;

    function setPlatform(osString) {
        if (!osString) return;
        var next = /mac/i.test(osString) ? 'mac' : 'win';
        if (next !== platformOverride) forgetLoupeScript();
        platformOverride = next;
    }

    function isMac() {
        if (platformOverride) return platformOverride === 'mac';
        try {
            var hint = (navigator.platform || '') + ' ' + (navigator.userAgent || '');
            if (/win/i.test(hint)) return false;
            if (/mac/i.test(hint)) return true;
        } catch (e) {}
        return true;   // CEP on Illustrator is Mac or Windows; Mac is the safer default
    }

    function runProcess(exePath, args, callback, options) {
        options = options || {};
        var pollMs = options.pollMs || 50;
        var ceilingMs = options.ceilingMs || 6000;

        var proc;
        try {
            proc = window.cep && window.cep.process;
            if (!proc || !proc.createProcess) {
                callback(false, 'This build of Illustrator does not expose a process bridge.');
                return;
            }
        } catch (e) {
            callback(false, 'Process bridge unavailable: ' + e.message);
            return;
        }

        var started;
        try {
            started = proc.createProcess.apply(proc, [exePath].concat(args));
        } catch (e2) {
            callback(false, 'Could not start ' + exePath + ': ' + e2.message);
            return;
        }

        if (!started || started.err !== 0) {
            callback(false, 'Could not start ' + exePath + ' (error ' +
                (started ? started.err : '?') + ').');
            return;
        }

        // Poll for exit rather than relying on a callback that some CEP versions
        // never fire.
        var pid = started.data;
        var ticks = 0;
        var maxTicks = Math.max(1, Math.ceil(ceilingMs / pollMs));

        var timer = setInterval(function () {
            ticks++;
            var running = true;
            try {
                var r = proc.isRunning(pid);
                running = !(r && r.data === false);
            } catch (e3) {
                running = false;
            }

            if (!running || ticks >= maxTicks) {
                clearInterval(timer);
                var timedOut = ticks >= maxTicks && running;

                if (timedOut) {
                    // Leaving a runaway child behind would pile up one stalled
                    // process per frame the loupe tried to draw.
                    try { if (proc.terminate) proc.terminate(pid); } catch (e4) {}
                }

                callback(!timedOut, timedOut ? 'The screen grab did not finish in time.' : '');
            }
        }, pollMs);
    }

    /*
      LOUPE
      =====

      A magnified view of the pixels around the pointer, the way a system colour
      picker works. Two things have to happen together, and neither is reachable
      from panel JavaScript: find out where the pointer is on the desktop, and
      grab a small square of screen around it.

      Both platforms can do it from a shell, so the panel writes a tiny helper
      script once per session and runs it per frame. Doing the whole frame in one
      process matters — a separate "where is the mouse" call would double the
      spawn cost, which is what dominates the frame time.

      The script also writes a sidecar line recording where it actually captured.
      Near a screen edge the region gets clamped, so the pointer is no longer at
      the centre of the image, and the panel needs to know that to mark the right
      pixel.
    */

    /*
      Two coordinate systems meet in this script and they disagree.

      NSEvent.mouseLocation is bottom-left origin, measured from the primary
      screen. screencapture -R is top-left origin over the whole desktop. The
      flip is `primaryHeight - y`.

      The desktop is also not a rectangle starting at (0, 0): a second display
      placed left of or above the primary gives genuinely negative coordinates.
      So the helper reports the union of every screen's frame and the region is
      clamped to that, not to zero — clamping to zero would drag the loupe back
      onto the primary display the moment the pointer crossed onto another one.
    */
    var MAC_LOUPE_SCRIPT =
        '#!/bin/sh\n' +
        '# Umbra Contrast Checker. One loupe frame, written by the panel.\n' +
        '# Args: $1 output PNG path, $2 region size in points.\n' +
        'OUT="$1"\n' +
        'SIZE="$2"\n' +
        '[ -z "$SIZE" ] && SIZE=48\n' +
        '\n' +
        '# "cursorX cursorY deskLeft deskTop deskRight deskBottom", top-left origin.\n' +
        'POS=`/usr/bin/osascript -l JavaScript -e \'ObjC.import("AppKit");' +
        ' var p = $.NSEvent.mouseLocation;' +
        ' var s = $.NSScreen.screens;' +
        ' var primaryH = s.objectAtIndex(0).frame.size.height;' +
        ' var minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;' +
        ' for (var i = 0; i < s.count; i++) {' +
        ' var f = s.objectAtIndex(i).frame;' +
        ' if (f.origin.x < minX) minX = f.origin.x;' +
        ' if (f.origin.y < minY) minY = f.origin.y;' +
        ' if (f.origin.x + f.size.width > maxX) maxX = f.origin.x + f.size.width;' +
        ' if (f.origin.y + f.size.height > maxY) maxY = f.origin.y + f.size.height;' +
        ' }' +
        ' [Math.round(p.x), Math.round(primaryH - p.y), Math.round(minX),' +
        ' Math.round(primaryH - maxY), Math.round(maxX),' +
        ' Math.round(primaryH - minY)].join(" ");\' 2>/dev/null`\n' +
        '[ -z "$POS" ] && exit 3\n' +
        '\n' +
        'set -- $POS\n' +
        'X="$1"; Y="$2"; L="$3"; T="$4"; R="$5"; B="$6"\n' +
        '[ -z "$B" ] && exit 3\n' +
        '\n' +
        'HALF=`expr "$SIZE" / 2`\n' +
        'RX=`expr "$X" - "$HALF"`\n' +
        'RY=`expr "$Y" - "$HALF"`\n' +
        'MAXX=`expr "$R" - "$SIZE"`\n' +
        'MAXY=`expr "$B" - "$SIZE"`\n' +
        '[ "$RX" -gt "$MAXX" ] && RX="$MAXX"\n' +
        '[ "$RY" -gt "$MAXY" ] && RY="$MAXY"\n' +
        '[ "$RX" -lt "$L" ] && RX="$L"\n' +
        '[ "$RY" -lt "$T" ] && RY="$T"\n' +
        '\n' +
        '# Written before the capture, and both moved into place, so the panel\n' +
        '# never reads a half-written file.\n' +
        'echo "$X $Y $RX $RY $SIZE" > "$OUT.pos.tmp"\n' +
        'mv -f "$OUT.pos.tmp" "$OUT.pos"\n' +
        'if /usr/sbin/screencapture -x -t png -R"$RX,$RY,$SIZE,$SIZE" "$OUT.tmp"; then\n' +
        '  mv -f "$OUT.tmp" "$OUT"\n' +
        'else\n' +
        '  echo "screencapture exited non-zero" > "$OUT.fail"\n' +
        '  exit 4\n' +
        'fi\n';

    var WIN_LOUPE_SCRIPT =
        '# Umbra Contrast Checker - one loupe frame. Written by the panel.\n' +
        'param([string]$Out, [int]$Size = 48)\n' +
        'Add-Type -AssemblyName System.Windows.Forms,System.Drawing\n' +
        '$p = [System.Windows.Forms.Cursor]::Position\n' +
        '$half = [int]($Size / 2)\n' +
        '$rx = $p.X - $half\n' +
        '$ry = $p.Y - $half\n' +
        '$vs = [System.Windows.Forms.SystemInformation]::VirtualScreen\n' +
        'if ($rx -lt $vs.Left) { $rx = $vs.Left }\n' +
        'if ($ry -lt $vs.Top) { $ry = $vs.Top }\n' +
        'if (($rx + $Size) -gt $vs.Right) { $rx = $vs.Right - $Size }\n' +
        'if (($ry + $Size) -gt $vs.Bottom) { $ry = $vs.Bottom - $Size }\n' +
        'Set-Content -Path "$Out.pos.tmp" -Value "$($p.X) $($p.Y) $rx $ry $Size"\n' +
        'Move-Item -Force "$Out.pos.tmp" "$Out.pos"\n' +
        '$bm = New-Object System.Drawing.Bitmap $Size, $Size\n' +
        '$g = [System.Drawing.Graphics]::FromImage($bm)\n' +
        '$g.CopyFromScreen($rx, $ry, 0, 0, $bm.Size)\n' +
        '$bm.Save("$Out.tmp", [System.Drawing.Imaging.ImageFormat]::Png)\n' +
        '$g.Dispose()\n' +
        '$bm.Dispose()\n' +
        'Move-Item -Force "$Out.tmp" "$Out"\n';

    /*
      THE POINTER SERVER — where the frame time actually went
      ------------------------------------------------------

      A measured frame cost 381ms, and most of that was not the screenshot. It
      was `osascript -l JavaScript` starting up and importing AppKit, which it
      did once per frame purely to answer "where is the pointer?".

      So ask once. This script starts when the eyedropper is armed and writes the
      pointer position to a file thirty times a second until told to stop. Each
      frame then costs a `screencapture` and nothing else, and — far more
      importantly — the panel can read the pointer position at will, without
      launching anything, which is what lets the crosshair track smoothly between
      captures instead of jumping once per frame.

      It stops three ways, because a process that outlives the panel would keep
      polling the pointer indefinitely: a stop file, a hard five-minute deadline,
      and terminate() on the pid.
    */
    var MAC_POINTER_SERVER =
        '// Umbra Contrast Checker. Pointer server, written by the panel.\n' +
        'function run(argv) {\n' +
        '    var out = argv[0];\n' +
        '    var stop = argv[1];\n' +
        '    try {\n' +
        '        ObjC.import("AppKit");\n' +
        '        var fm = $.NSFileManager.defaultManager;\n' +
        '        var deadline = Date.now() + 300000;\n' +
        '        var tick = 0;\n' +
        '        while (Date.now() < deadline) {\n' +
        '            if (fm.fileExistsAtPath(stop)) break;\n' +
        '            var p = $.NSEvent.mouseLocation;\n' +
        '            var screens = $.NSScreen.screens;\n' +
        '            var primaryH = screens.objectAtIndex(0).frame.size.height;\n' +
        '            var minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;\n' +
        '            var count = screens.count;\n' +
        '            for (var i = 0; i < count; i++) {\n' +
        '                var f = screens.objectAtIndex(i).frame;\n' +
        '                if (f.origin.x < minX) minX = f.origin.x;\n' +
        '                if (f.origin.y < minY) minY = f.origin.y;\n' +
        '                if (f.origin.x + f.size.width > maxX) maxX = f.origin.x + f.size.width;\n' +
        '                if (f.origin.y + f.size.height > maxY) maxY = f.origin.y + f.size.height;\n' +
        '            }\n' +
        '            var left = Math.floor(minX);\n' +
        '            var top = Math.floor(primaryH - maxY);\n' +
        '            var right = Math.floor(maxX);\n' +
        '            var bottom = Math.floor(primaryH - minY);\n' +
        '            // floor, not round: a pointer at the very bottom of the\n' +
        '            // screen rounds to one point PAST the desktop, which is a\n' +
        '            // coordinate no capture can ever contain.\n' +
        '            var px = Math.floor(p.x);\n' +
        '            var py = Math.floor(primaryH - p.y);\n' +
        '            if (px < left) px = left;\n' +
        '            if (py < top) py = top;\n' +
        '            if (px > right - 1) px = right - 1;\n' +
        '            if (py > bottom - 1) py = bottom - 1;\n' +
        '            // The tick is a heartbeat: it lets the panel tell a server\n' +
        '            // that is standing still from one that has died.\n' +
        '            tick = (tick + 1) % 1000000;\n' +
        '            // Mouse buttons, so a click can be the pick gesture. The\n' +
        '            // panel cannot see clicks outside its own window any other way.\n' +
        '            var buttons = 0;\n' +
        '            try { buttons = $.NSEvent.pressedMouseButtons; } catch (eB) { buttons = 0; }\n' +
        '            var line = [px, py, left, top, right, bottom, tick, buttons].join(" ");\n' +
        '            $(line).writeToFileAtomicallyEncodingError(out, true, 4, $());\n' +
        '            $.NSThread.sleepForTimeInterval(0.03);\n' +
        '        }\n' +
        '    } catch (e) {\n' +
        '        try { $(String(e)).writeToFileAtomicallyEncodingError(out + ".err", true, 4, $()); }\n' +
        '        catch (e2) {}\n' +
        '    }\n' +
        '}\n';

    var WIN_POINTER_SERVER =
        '# Umbra Contrast Checker - pointer server. Written by the panel.\n' +
        'param([string]$Out, [string]$Stop)\n' +
        'try {\n' +
        '  Add-Type -AssemblyName System.Windows.Forms\n' +
        '  $deadline = (Get-Date).AddMinutes(5)\n' +
        '  $tick = 0\n' +
        '  while ((Get-Date) -lt $deadline) {\n' +
        '    if (Test-Path $Stop) { break }\n' +
        '    $p = [System.Windows.Forms.Cursor]::Position\n' +
        '    $vs = [System.Windows.Forms.SystemInformation]::VirtualScreen\n' +
        '    $px = $p.X; $py = $p.Y\n' +
        '    if ($px -lt $vs.Left) { $px = $vs.Left }\n' +
        '    if ($py -lt $vs.Top) { $py = $vs.Top }\n' +
        '    if ($px -gt ($vs.Right - 1)) { $px = $vs.Right - 1 }\n' +
        '    if ($py -gt ($vs.Bottom - 1)) { $py = $vs.Bottom - 1 }\n' +
        '    $tick = ($tick + 1) % 1000000\n' +
        '    $buttons = 0\n' +
        '    if ([System.Windows.Forms.Control]::MouseButtons -ne [System.Windows.Forms.MouseButtons]::None) { $buttons = 1 }\n' +
        '    Set-Content -Path "$Out.tmp" -Value "$px $py $($vs.Left) $($vs.Top) $($vs.Right) $($vs.Bottom) $tick $buttons"\n' +
        '    Move-Item -Force "$Out.tmp" "$Out"\n' +
        '    Start-Sleep -Milliseconds 30\n' +
        '  }\n' +
        '} catch {\n' +
        '  Set-Content -Path "$Out.err" -Value $_.Exception.Message\n' +
        '}\n';

    /*
      A frame, once the pointer is already known. No osascript, no PowerShell —
      just the screenshot the loupe actually needs.
    */
    var MAC_GRAB_SCRIPT =
        '#!/bin/sh\n' +
        '# Umbra Contrast Checker. One loupe frame, pointer already known.\n' +
        '# Args: $1 output PNG path, $2 region size in points, $3 pointer file.\n' +
        'OUT="$1"\n' +
        'SIZE="$2"\n' +
        'PTR="$3"\n' +
        '[ -z "$SIZE" ] && SIZE=128\n' +
        'POS=`cat "$PTR" 2>/dev/null`\n' +
        '[ -z "$POS" ] && exit 3\n' +
        '\n' +
        'set -- $POS\n' +
        'X="$1"; Y="$2"; L="$3"; T="$4"; R="$5"; B="$6"\n' +
        '[ -z "$B" ] && exit 3\n' +
        '\n' +
        'HALF=`expr "$SIZE" / 2`\n' +
        'RX=`expr "$X" - "$HALF"`\n' +
        'RY=`expr "$Y" - "$HALF"`\n' +
        'MAXX=`expr "$R" - "$SIZE"`\n' +
        'MAXY=`expr "$B" - "$SIZE"`\n' +
        '[ "$RX" -gt "$MAXX" ] && RX="$MAXX"\n' +
        '[ "$RY" -gt "$MAXY" ] && RY="$MAXY"\n' +
        '[ "$RX" -lt "$L" ] && RX="$L"\n' +
        '[ "$RY" -lt "$T" ] && RY="$T"\n' +
        '\n' +
        'echo "$X $Y $RX $RY $SIZE" > "$OUT.pos.tmp"\n' +
        'mv -f "$OUT.pos.tmp" "$OUT.pos"\n' +
        '\n' +
        '# A non-zero exit means screencapture ran and refused. Say so, because\n' +
        '# the panel cannot read exit codes and would otherwise blame the one\n' +
        '# failure that looks identical from outside: a denied permission, which\n' +
        '# exits 0 and simply writes nothing.\n' +
        'if /usr/sbin/screencapture -x -t png -R"$RX,$RY,$SIZE,$SIZE" "$OUT.tmp"; then\n' +
        '  mv -f "$OUT.tmp" "$OUT"\n' +
        'else\n' +
        '  echo "screencapture exited non-zero for region $RX,$RY,$SIZE,$SIZE" > "$OUT.fail"\n' +
        '  exit 4\n' +
        'fi\n';

    var WIN_GRAB_SCRIPT =
        '# Umbra Contrast Checker - one loupe frame, pointer already known.\n' +
        'param([string]$Out, [int]$Size = 128, [string]$Ptr)\n' +
        'Add-Type -AssemblyName System.Drawing\n' +
        '$pos = (Get-Content $Ptr -ErrorAction SilentlyContinue) -split "\\s+"\n' +
        'if ($pos.Count -lt 6) { exit 3 }\n' +
        '$x = [int]$pos[0]; $y = [int]$pos[1]\n' +
        '$l = [int]$pos[2]; $t = [int]$pos[3]; $r = [int]$pos[4]; $b = [int]$pos[5]\n' +
        '$half = [int]($Size / 2)\n' +
        '$rx = $x - $half\n' +
        '$ry = $y - $half\n' +
        'if ($rx -gt ($r - $Size)) { $rx = $r - $Size }\n' +
        'if ($ry -gt ($b - $Size)) { $ry = $b - $Size }\n' +
        'if ($rx -lt $l) { $rx = $l }\n' +
        'if ($ry -lt $t) { $ry = $t }\n' +
        'Set-Content -Path "$Out.pos.tmp" -Value "$x $y $rx $ry $Size"\n' +
        'Move-Item -Force "$Out.pos.tmp" "$Out.pos"\n' +
        '$bm = New-Object System.Drawing.Bitmap $Size, $Size\n' +
        '$g = [System.Drawing.Graphics]::FromImage($bm)\n' +
        '$g.CopyFromScreen($rx, $ry, 0, 0, $bm.Size)\n' +
        '$bm.Save("$Out.tmp", [System.Drawing.Imaging.ImageFormat]::Png)\n' +
        '$g.Dispose()\n' +
        '$bm.Dispose()\n' +
        'Move-Item -Force "$Out.tmp" "$Out"\n';

    var scriptPaths = {};
    var scriptKey = '';

    var pointer = {
        pid: null,
        path: '',
        stopPath: '',
        live: false
    };

    function writeFile(path, contents) {
        try {
            if (!window.cep || !window.cep.fs || !window.cep.fs.writeFile) return false;
            var res = window.cep.fs.writeFile(path, contents);
            return !!(res && res.err === 0);
        } catch (e) {
            return false;
        }
    }

    function readFileText(path) {
        try {
            if (!window.cep || !window.cep.fs) return null;
            var res = window.cep.fs.readFile(path);
            return (res && res.err === 0) ? String(res.data) : null;
        } catch (e) {
            return null;
        }
    }

    function pathJoin(folder, name) {
        return folder + (isMac() ? '/' : '\\') + name;
    }

    /*
      Scripts are written once and reused. Rewriting per frame would add a disk
      round trip to every capture for no benefit.

      The platform is only known for certain once the host answers, and the temp
      folder arrives with it — so both are part of the cache key, or a script
      written before that answer would be reused for the wrong OS.
    */
    function ensureScripts(folder) {
        var mac = isMac();
        var key = (mac ? 'mac|' : 'win|') + folder;
        if (scriptKey === key && scriptPaths.grab) return scriptPaths;

        var next = {
            loupe: pathJoin(folder, mac ? 'umbra-loupe.sh' : 'umbra-loupe.ps1'),
            grab: pathJoin(folder, mac ? 'umbra-grab.sh' : 'umbra-grab.ps1'),
            server: pathJoin(folder, mac ? 'umbra-pointer.js' : 'umbra-pointer.ps1')
        };

        var wrote =
            writeFile(next.loupe, mac ? MAC_LOUPE_SCRIPT : WIN_LOUPE_SCRIPT) &&
            writeFile(next.grab, mac ? MAC_GRAB_SCRIPT : WIN_GRAB_SCRIPT) &&
            writeFile(next.server, mac ? MAC_POINTER_SERVER : WIN_POINTER_SERVER);

        if (!wrote) return null;

        scriptPaths = next;
        scriptKey = key;
        return scriptPaths;
    }

    function forgetLoupeScript() {
        scriptPaths = {};
        scriptKey = '';
    }

    // ---- pointer server ---------------------------------------------------

    function pointerPath(folder) { return pathJoin(folder, 'umbra-pointer.txt'); }
    function pointerStopPath(folder) { return pathJoin(folder, 'umbra-pointer.stop'); }

    function startPointerServer(folder) {
        if (pointer.live) return true;

        var scripts = ensureScripts(folder);
        if (!scripts) return false;

        pointer.path = pointerPath(folder);
        pointer.stopPath = pointerStopPath(folder);

        /*
          Clear the decks first. A stop file left behind by a crashed session
          would make the new server exit on its first tick, and a stale position
          file would make the first frame aim at wherever the pointer was the
          last time the panel ran.
        */
        deleteFile(pointer.stopPath);
        deleteFile(pointer.path);
        deleteFile(pointer.path + '.err');

        var proc;
        try {
            proc = window.cep && window.cep.process;
            if (!proc || !proc.createProcess) return false;
        } catch (e) { return false; }

        // On Windows, try each PowerShell location rather than only the first:
        // the capture path already does, and an inconsistency here would mean
        // the fast route silently never engaged on an unusual install.
        var candidates = isMac()
            ? [['/usr/bin/osascript', '-l', 'JavaScript', scripts.server,
                pointer.path, pointer.stopPath]]
            : [];

        if (!isMac()) {
            for (var i = 0; i < POWERSHELL_PATHS.length; i++) {
                candidates.push([POWERSHELL_PATHS[i], '-NoProfile', '-ExecutionPolicy',
                    'Bypass', '-WindowStyle', 'Hidden', '-File', scripts.server,
                    '-Out', pointer.path, '-Stop', pointer.stopPath]);
            }
        }

        for (var c = 0; c < candidates.length; c++) {
            var started;
            try {
                started = proc.createProcess.apply(proc, candidates[c]);
            } catch (e2) { continue; }

            if (started && started.err === 0) {
                pointer.pid = started.data;
                pointer.live = true;
                return true;
            }
        }

        return false;
    }

    /*
      Kill anything left over from a previous life.

      A panel reload does not always run beforeunload, so a pointer server can
      outlive the page that started it. Writing the stop file makes any survivor
      exit on its next tick; removing it a moment later clears the way for the
      next arm. Both the write and the delayed delete matter — leaving the file
      in place would stop the NEXT server before it started.
    */
    function sweepOrphanServers(folder) {
        var stop = pointerStopPath(folder);
        writeFile(stop, 'stop');
        setTimeout(function () { deleteFile(stop); }, 600);
    }

    function stopPointerServer() {
        if (!pointer.live) return;

        // Belt and braces: the stop file is what a healthy server watches for,
        // terminate() is what catches one that has stopped watching.
        if (pointer.stopPath) writeFile(pointer.stopPath, 'stop');

        try {
            var proc = window.cep && window.cep.process;
            if (proc && proc.terminate && pointer.pid !== null) proc.terminate(pointer.pid);
        } catch (e) {}

        pointer.live = false;
        pointer.pid = null;
    }

    function pointerServerLive() {
        return pointer.live;
    }

    function pointerServerError() {
        if (!pointer.path) return '';
        return readFileText(pointer.path + '.err') || '';
    }

    // "x y deskLeft deskTop deskRight deskBottom tick buttons" — points, then
    // a heartbeat, then the pressed-button bitmask.
    function parsePointerLine(raw) {
        if (!raw) return null;

        var bits = String(raw).replace(/[\r\n]+/g, ' ').split(/\s+/);
        var nums = [];
        for (var i = 0; i < bits.length; i++) {
            if (bits[i] === '') continue;
            var n = parseInt(bits[i], 10);
            if (isNaN(n)) return null;
            nums.push(n);
        }
        if (nums.length < 6) return null;

        var left = nums[2], top = nums[3], right = nums[4], bottom = nums[5];
        var x = nums[0], y = nums[1];

        /*
          Belt and braces on the clamp the server already applies. A pointer
          reported one point past the desktop edge is a coordinate no capture can
          ever contain, so the crosshair would show a pixel while the lock kept
          refusing it — a deadlock the user cannot see the cause of.
        */
        if (x < left) x = left;
        if (y < top) y = top;
        if (x > right - 1) x = right - 1;
        if (y > bottom - 1) y = bottom - 1;

        return {
            x: x, y: y,
            left: left, top: top, right: right, bottom: bottom,
            tick: nums.length > 6 ? nums[6] : -1,
            buttons: nums.length > 7 ? nums[7] : 0
        };
    }

    /*
      Cheap enough to call many times a second: one small text read, no process,
      no host round trip. This is what makes the crosshair track smoothly between
      captures rather than stepping once per frame.
    */
    function readPointer(folder) {
        var path = pointer.path || pointerPath(folder);
        return parsePointerLine(readFileText(path));
    }

    /*
      Capture one frame. `size` is the width of the captured square in points, so
      on a Retina display the PNG comes back at twice that in pixels — which is
      exactly the extra detail a loupe wants.
    */
    function loupeCapture(folder, outPath, size, callback) {
        var scripts = ensureScripts(folder);
        if (!scripts) {
            callback(false, 'Could not write the loupe helper into ' + folder + '.');
            return;
        }

        // Both files, every frame. A sidecar left over from the previous frame
        // would make a failed grab look like a blocked one, and would place the
        // crosshair using stale coordinates.
        deleteFile(outPath);
        deleteFile(outPath + '.pos');
        deleteFile(outPath + '.fail');

        // Tight poll and a short ceiling: this runs once per displayed frame, so
        // waiting an extra 50ms to notice the process ended is visible lag, and
        // a frame that has not arrived in three seconds is never useful.
        var pace = { pollMs: 20, ceilingMs: 3000 };

        /*
          Two routes to the same frame. With the pointer server running, the
          position is already on disk and the frame costs one screenshot; without
          it, the standalone script has to go and ask, which is most of the
          frame time. The second route is the fallback, not the plan.
        */
        var fast = pointer.live;
        var script = fast ? scripts.grab : scripts.loupe;

        if (isMac()) {
            var args = fast
                ? [script, outPath, String(size), pointer.path]
                : [script, outPath, String(size)];

            runProcess('/bin/sh', args, function (okay, problem) {
                finishLoupe(okay, problem, outPath, callback);
            }, pace);
            return;
        }

        var psArgs = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden',
                      '-File', script, '-Out', outPath, '-Size', String(size)];
        if (fast) psArgs = psArgs.concat(['-Ptr', pointer.path]);

        runPowershell(psArgs, function (okay, problem) {
            finishLoupe(okay, problem, outPath, callback);
        }, pace);
    }

    function finishLoupe(okay, problem, outPath, callback) {
        if (!okay) { callback(false, problem); return; }

        /*
          The sidecar tells the two failures apart.

          It is written BEFORE the capture, so if it is there the helper ran and
          found the pointer, and only the screen grab failed \u2014 which on macOS is
          almost always Screen Recording permission. If it is missing, the script
          never got that far: no helper on disk, no osascript, no AppKit. Sending
          someone to a Privacy setting that is already correct wastes their time
          and hides the real problem.
        */
        var ranOk = fileExists(outPath + '.pos');
        var refused = readFileText(outPath + '.fail');

        if (!fileExists(outPath)) {
            if (!ranOk) {
                forgetLoupeScript();     // rewrite it next time, in case it went missing
                callback(false, 'The eyedropper helper did not run.');
                return;
            }

            /*
              Three ways to have no image, and they need three different answers.

              The helper writes .fail when screencapture RAN and refused, which
              covers a bad region or a transient error. A denied Screen Recording
              permission looks different from outside: screencapture exits zero
              and simply writes nothing. Only that third case is a permission
              problem, and only it should send someone to System Settings.
            */
            if (refused) {
                callback(false, 'The screen grab failed: ' + refused);
                return;
            }

            callback(false, isMac()
                ? 'macOS blocked the screen grab. Give Illustrator permission under ' +
                  'System Settings \u2192 Privacy & Security \u2192 Screen Recording, ' +
                  'then try again.'
                : 'The screen grab produced no image.');
            return;
        }

        var base64 = readFileBase64(outPath);
        if (!base64) {
            callback(false, 'Could not read the loupe frame (' + lastFileReadError() + ').');
            return;
        }

        // "cursorX cursorY regionX regionY sizeInPoints", all in screen points.
        var region = null;
        var raw = readFileText(outPath + '.pos');
        if (raw) {
            var bits = String(raw).replace(/[\r\n]+/g, ' ').split(/\s+/);
            var nums = [];
            for (var i = 0; i < bits.length; i++) {
                if (bits[i] === '') continue;
                var n = parseInt(bits[i], 10);
                if (isNaN(n)) { nums = []; break; }
                nums.push(n);
            }
            if (nums.length >= 5) {
                region = {
                    cursorX: nums[0], cursorY: nums[1],
                    x: nums[2], y: nums[3], size: nums[4]
                };
            }
        }

        callback(true, '', base64, region);
    }

    /*
      A bare "powershell" relies on the child process inheriting a usable PATH,
      which is not guaranteed for a process spawned by the host application. Try
      the absolute location first and keep the bare name as a fallback, so an
      unusual Windows install still works.
    */
    var POWERSHELL_PATHS = [
        'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
        'powershell.exe',
        'powershell'
    ];

    function runPowershell(args, callback, options, attempt) {
        attempt = attempt || 0;
        if (attempt >= POWERSHELL_PATHS.length) {
            callback(false, 'PowerShell could not be started on this machine.');
            return;
        }

        runProcess(POWERSHELL_PATHS[attempt], args, function (okay, problem) {
            // Only a failure to START is worth retrying elsewhere; a process
            // that ran and failed will fail the same way from another path.
            if (!okay && /could not start/i.test(String(problem))) {
                runPowershell(args, callback, options, attempt + 1);
                return;
            }
            callback(okay, problem);
        }, options);
    }

    function fileExists(path) {
        try {
            if (!window.cep || !window.cep.fs) return false;
            var res = window.cep.fs.stat(path);
            return !!(res && res.err === 0);
        } catch (e) {
            return false;
        }
    }

    function deleteFile(path) {
        try {
            if (window.cep && window.cep.fs && window.cep.fs.deleteFile) {
                window.cep.fs.deleteFile(path);
            }
        } catch (e) {}
    }

    function hostEnvironment() {
        var api = bridge();
        if (!api) return null;
        try {
            return JSON.parse(api.getHostEnvironment());
        } catch (e) {
            return null;
        }
    }

    // CEP exposes the host's UI theme so the panel can match Illustrator.
    function uiBackgroundColor() {
        var env = hostEnvironment();
        try {
            var c = env.appSkinInfo.panelBackgroundColor.color;
            return { r: Math.round(c.red), g: Math.round(c.green), b: Math.round(c.blue) };
        } catch (e) {
            return { r: 50, g: 50, b: 50 };
        }
    }

    /*
      Open a URL in the user's real browser.

      NOT an <a href>. A CEP panel is a chrome-less webview, so a normal link
      navigates the PANEL to that page — the extension is simply gone, replaced
      by a web page, with no back button and no way out but reloading it. CEP
      hands out a host call for exactly this.
    */
    function openExternal(url) {
        try {
            if (window.cep && window.cep.util && window.cep.util.openURLInDefaultBrowser) {
                window.cep.util.openURLInDefaultBrowser(url);
                return true;
            }
        } catch (e) {}
        return false;
    }

    /*
      Subscribe to a host application event.

      Illustrator sends CEP panels no selection-changed event, which is the whole
      reason this panel polls. It does send the standard CSXS lifecycle events,
      and those are what let the poll stop when nobody is looking at it and stop
      for good when the application is closing.

      Every subscription here is optional by design. Illustrator's support for
      individual CSXS events is not documented per event and varies by build, so
      a listener that never fires has to be survivable. It is: the panel's own
      backoff limits the damage on its own, and these events only make it better.
      That is why a failure is swallowed rather than reported.
    */
    function onHostEvent(type, handler) {
        var api = bridge();
        if (!api || !api.addEventListener) return false;
        try {
            api.addEventListener(type, handler);
            return true;
        } catch (e) {
            return false;
        }
    }

    root.CEP = {
        available: available,
        onHostEvent: onHostEvent,
        evalScript: evalScript,
        call: call,
        readFileBase64: readFileBase64,
        readFileText: readFileText,
        writeFile: writeFile,
        lastFileReadError: lastFileReadError,
        fileUrl: fileUrl,
        loupeCapture: loupeCapture,
        forgetLoupeScript: forgetLoupeScript,
        startPointerServer: startPointerServer,
        stopPointerServer: stopPointerServer,
        pointerServerLive: pointerServerLive,
        sweepOrphanServers: sweepOrphanServers,
        pointerServerError: pointerServerError,
        readPointer: readPointer,
        fileExists: fileExists,
        deleteFile: deleteFile,
        openExternal: openExternal,
        isMac: isMac,
        setPlatform: setPlatform,
        hostEnvironment: hostEnvironment,
        uiBackgroundColor: uiBackgroundColor
    };

}(typeof self !== 'undefined' ? self : this));
