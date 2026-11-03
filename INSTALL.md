# Installing Umbra Contrast Checker

Two ways in. Almost everyone wants the first one.

---

## The .zxp, for everyone

1. Download the file for your computer from the
   [latest release](../../releases/latest).
   `UmbraContrastChecker-macOS.zxp` on a Mac,
   `UmbraContrastChecker-Windows.zxp` on Windows. Each one is signed on its own
   platform, so take the one that matches.
2. Get a free ZXP installer if you do not already have one.
   [ZXP Installer](https://aescripts.com/learn/zxp-installer/) from aescripts
   and [Anastasiy's Extension Manager](https://install.anastasiy.com/) both run
   on macOS and Windows.
3. Drag the `.zxp` onto the installer, or use its install button and pick the
   file.
4. Restart Illustrator.
5. Open **Window**, then **Extensions**, then **Umbra Contrast Checker**.

That is the whole thing. The `.zxp` is signed, so you do not have to enable
Illustrator's debug mode or move any files by hand.

Some installers show a note about an unverified publisher. That is expected. The
extension is signed with our own certificate rather than through Adobe Exchange,
which is a listing channel, not a safety rating.

macOS asks for one permission the first time you use the eyedropper. See
**First run** below.

To update, do the same with the newer file. It replaces the version you have.

### No installer?

A `.zxp` is a zip file with its signature inside, so you can put it in place by
hand and it still loads without debug mode.

1. Quit Illustrator.
2. Rename the file so it ends in `.zip` instead of `.zxp`, and unzip it.
3. Rename the unzipped folder `Umbra Contrast Checker` and move it into the
   extensions folder shown under **The folder, for development** below. Create
   the `extensions` folder if it is not there. `CSXS`, `client`, `host` and
   `META-INF` should sit directly inside `Umbra Contrast Checker`.
4. Open Illustrator.

Skip the debug mode step in that section. It is only for the unsigned source.

---

## The folder, for development

Skip this unless you are working on the panel itself.

Illustrator loads unpackaged extensions from one specific place:

```
macOS    ~/Library/Application Support/Adobe/CEP/extensions/
Windows  C:\Users\<you>\AppData\Roaming\Adobe\CEP\extensions\
```

Copy the project folder there, keeping the name `Umbra Contrast Checker`, so
that `CSXS`, `client` and `host` sit **directly** inside it. A nested
`Umbra Contrast Checker/Umbra Contrast Checker/CSXS` will not appear in the
menu.

An unpackaged extension is unsigned, so Illustrator will not load it until debug
mode is on.

macOS:

```bash
for v in 10 11 12; do defaults write com.adobe.CSXS.$v PlayerDebugMode 1; done
killall cfprefsd
```

Setting all three covers whichever CEP version your Illustrator uses. The
`killall cfprefsd` matters on recent macOS, because without it the preference
may not stick.

Windows: open `regedit` and, for each of
`HKEY_CURRENT_USER\Software\Adobe\CSXS.12`, `CSXS.11` and `CSXS.10`, add a
**string** value named `PlayerDebugMode` set to `1`.

Restart Illustrator either way.

---

## First run

1. Open a document.
2. Click a piece of text with the black arrow (Selection tool, **V**).
3. The ratio appears within about a second.

**Photos, patterns and placed images have no colour the panel can read**, so it shows no ratio
at all rather than guessing. That is what the eyedropper is for. Gradients are read, and graded
along their whole length.

### Using the eyedropper

The eyedropper opens a **loupe** above the tools: it shows the pixels immediately around your pointer, magnified,
with a crosshair on the one you would pick, and the hex plus the live contrast ratio underneath.
It works like a system colour picker. Hover around a photo or a gradient and you can see where
the text would start passing, before committing to anything.

1. Click the **eyedropper** (or **Text** / **Bg** to choose which colour you are setting).
   The preview picks up a blue edge to show it is tracking.
2. **Move the mouse** anywhere on screen. Over the artboard, over another application, it
   doesn't matter. The loupe follows, and the hex of the crosshair pixel is shown beside it.
3. **Click, or press Enter** (or Space), to lock that pixel. Either works.

   A click also reaches Illustrator. The panel cannot intercept it, because CEP has no way to
   put a transparent window over the screen the way a native picker does. So it repairs the
   damage instead: it asks Illustrator to put the selection back exactly as it was, and
   selection changes are not undo steps, so nothing is left behind. **With a drawing tool
   active the click really does draw**, and nothing can undo that for you. Switch to the
   Selection tool, or use Enter.
4. The frame **freezes** at that moment. If the crosshair was a pixel off, just **click the
   pixel you wanted** inside the frozen loupe.
5. **Esc** cancels, or clears the sample.

Clicks on the panel's own controls are not picks. The gear, the level switch, Auto and the
Text/Bg buttons do what they always do, even while the loupe is armed.

If nothing seems to happen when you press Enter, click once on the panel first. It needs
keyboard focus, and clicking inside Illustrator's canvas takes that away.

One case the panel deliberately leaves alone: if you had a **text cursor** blinking inside a
text frame rather than objects selected, it cannot put that back afterwards, so it does not try.

The first time you use the eyedropper, macOS will ask for **Screen Recording** permission for
Illustrator. Grant it in System Settings → Privacy & Security → Screen Recording, then click the
eyedropper again. This is a one-time step, and it is what lets the panel see your artwork as
displayed, gradients and all.

The crosshair, the hex and the ratio track your pointer smoothly. The captured pixels refresh a
few times a second underneath them (each capture is a screenshot, and that is what it costs),
but each one covers far more area than the window shows, so ordinary movements are served from
the frame already in hand rather than waiting on a new one.

Two consequences worth knowing. If you move a long way in one go, the crosshair dims for a
moment while the capture catches up. And if you press Enter during that moment, it waits and
then takes the pixel you were over **when you pressed**, not wherever the pointer has drifted
to since. If that pixel never comes back into view it says so rather than guessing.

When the pointer stops moving the loupe slows down on its own, and a tracking session stops
after 45 seconds so an eyedropper you armed and forgot about is not still capturing your screen
an hour later.

The chip beside the eyedropper is a mode switch, always labelled **Auto**. Lit, both colours
come from the artwork itself, colour-managed. Dimmed, at least one of them is a colour you
picked by hand. Hover it to see what was picked, and click it to hand both colours back to the
artwork. **Esc** does the same thing. The
**Text** and **Bg** buttons each carry a dot showing whether that slot is holding a picked
colour.

While a colour is picked by hand, the panel will not write a suggested fix to that side. There
is no object behind a screen pixel to write it to, and it used to recolour whichever shape it
had detected underneath instead. Fixes for the *other* side still work; release the pick with
Auto to change this one.

### The target level

The header is the target level: **AA** and **AAA** side by side, the one in use filled blue.
Click the other to switch. It is in the header rather than in the gear because it is what
every number in the panel means, and the results table tints that level's column to match. The verdict, the swatch colours and
the suggested fixes are all graded against it. The same control is in the
gear popover under **Target level**; they are two views of one setting.

**Medium** decides what counts as large text. WCAG's sizes are CSS points, so on **Screen**
large text starts at 24px, or 18.66px bold; in **Print** it is 18pt, or 14pt bold. **Auto**
uses Screen for RGB documents and Print for CMYK. The verdict line shows which one it used:
`18px body text` on screen, `18pt large text` in print.

When a selection looks like outlined type, a group of same-coloured paths with holes in them,
the panel asks whether to grade it as body or large text. That answer is for the one selection
and is never saved.

Target level, **Medium**, **Treat text as** and **Measure rendered colour** are remembered
between sessions.

The header stays quiet while everything works. It shows **Applying…** while a fix is being
written to your artwork, **Not applied** if a write fails, and **Not connected** if the panel
loses touch with Illustrator.

The footnote at the bottom names the standard and the success criteria your target level
applies. Click it for the thresholds and a link to the specification.

---

## If nothing appears

**The panel is not in the Extensions menu at all.**

If you installed the `.zxp`, check that it actually landed. Your installer lists
what it has installed, and the files end up in the extensions folder shown
above. Reinstalling over the top is safe.

If you installed the folder by hand, it is almost always the path or debug mode.
Confirm that `Umbra Contrast Checker/CSXS/manifest.xml` exists exactly where you
put it, then check the setting took:

```bash
defaults read com.adobe.CSXS.12 PlayerDebugMode
```

It should print `1`. An error means the write did not land, so run the debug
mode step again including `killall cfprefsd`.

**The panel installed but shows a blank white box.**

The signature did not verify. This usually means the `.zxp` for the other
platform was installed: the macOS file on Windows, or the reverse. Download the
one for your computer and install it over the top.

**The panel opens but says "no host".**

It loaded but cannot reach Illustrator's scripting engine. Close the panel, quit and reopen
Illustrator, and open it again. If that does not clear it, reinstall.

**The panel opens but the ratio stays blank.**

Check that something is actually selected, and that it has a solid fill. Gradients are read
too, but patterns and placed images are not: use the eyedropper for those.

---

## Still stuck

Open an issue. Include the panel version from the bottom of the gear menu, your Illustrator
version, your OS, and what the artwork was. If Illustrator crashed, attach the newest Adobe
Illustrator `.ips` file from `~/Library/Logs/DiagnosticReports`. A gradient behind text and a flat fill behind text are different code paths, and
knowing which one you were on saves the first two replies.

If the panel measured something wrong, that is the bug worth reporting fastest. A wrong number
in an accessibility tool is worse than no number, and it is the one class of defect this project
treats as urgent.

Umbra Contrast Checker is developed by [Artchemy Labs](https://artchemylabs.com). If it saved
you an afternoon, you can [support it on Ko-fi](https://ko-fi.com/artchemylabs).
