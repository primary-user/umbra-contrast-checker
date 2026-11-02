# Internals

Not for the public README. This is the shape of the code, why it is shaped that
way, and how to work on it.

---

## Layout

```
CSXS/manifest.xml         what Illustrator reads to find the panel
client/index.html         the panel's markup
client/css/               styling, tuned to Illustrator's dark UI
client/js/color.js        the colour engine, pure functions, no DOM, no host
client/js/cep.js          the bridge to Illustrator and to the OS
client/js/panel.js        the UI controller
host/index.jsx            ExtendScript that runs inside Illustrator
test/                     five suites: colour maths, host guards, panel, browser, hygiene
docs/                     this file, and the images the README shows
tools/package.sh          builds and signs the distributable .zxp
tools/get-zxpsigncmd.sh   fetches Adobe's signing tool for package.sh
.github/workflows/        tests on every push, and the release build
```

## The one architectural rule

**`host/index.jsx` reports facts and performs writes. It does no colour
science.** Every ratio, blend, composite and suggestion is computed in
`color.js`.

That is why the maths can be tested in Node without Illustrator anywhere near
it, and why a future UXP port is a bridge swap rather than a rewrite. A change
that moves colour logic into the host should be moved back.

## The eyedropper

Illustrator exposes no pixel API, so the loupe reads the screen. A small helper
script reports the pointer position thirty times a second while the eyedropper
is armed, and each frame is one `screencapture` on macOS or one `CopyFromScreen`
on Windows.

Each capture covers far more area than the pane displays, so ordinary pointer
movement is served by panning inside the frame already in hand. That is what
makes it feel live between captures, which arrive only a few times a second
because process launch dominates the frame time.

Screen pixels come from the display pipeline, so on a wide gamut monitor they
are in the display's colour space rather than the document's sRGB, and the panel
says so. There used to be a second route, a button that asked Illustrator to
render the selection through `imageCapture`. Nobody could tell what it did, and
`imageCapture` was the least stable API the host touched, so 1.11.0 removed it.

## Tests

```bash
cd test
npm install
npm test
```

| Suite | What it covers |
|---|---|
| `run-hygiene.js` | Cross-file integrity, dead code, house style, and that nothing personal or local ships in the repo. |
| `run-color.js` | The colour maths, against published WCAG and CIE reference values. No DOM. |
| `run-guards.js` | Host layer guards, Illustrator's enum names, the appearance chain arithmetic, and the crash safety rules for stored page item handles. |
| `run-panel.js` | The real panel driven against a mock Illustrator, under jsdom. |
| `run-render.js` | The real panel in real Chromium, answering the questions only a browser can answer. |

Each suite prints its own count and exits non-zero on failure. The totals are
deliberately not repeated here, where they would go stale.

`run-render.js` exists because jsdom has no cascade engine and no canvas, and a
bug that needed both shipped. `.snapshot-empty { display: flex }` beat the
browser's own `[hidden] { display: none }`, so the loupe drew perfectly
underneath an overlay that could never be dismissed.

It also asserts that **every piece of text and every icon in the panel clears
its own threshold**, 4.5:1 for text and 3:1 for icons, measured with every
popover open and again with the pointer over each control. A contrast checker
that fails its own check is not a credible one. The first palette failed in
eight places, and the hover states on the outbound links were failing as
recently as 1.9.0, invisible to any static sweep.

It skips cleanly if Playwright is not installed, so the other four still run.

## Live debugging with Chrome DevTools

The panel can expose itself to Chrome DevTools, but the file that does it is not
committed, because a shipped extension has no business carrying a debug port.

Create `.debug` in the extension root when you need it:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<ExtensionList>
  <Extension Id="com.umbracontrastchecker.panel.main">
    <HostList>
      <Host Name="ILST" Port="8099" />
    </HostList>
  </Extension>
</ExtensionList>
```

With Illustrator running and the panel open, visit `http://localhost:8099` in
Chrome and click through to the panel. Full console, network and element
inspector, because it is an ordinary web page.

`.gitignore` covers `.debug`, and `tools/package.sh` excludes it, so it cannot
reach a build by accident.

## Editing while it runs

Change any file in `client/`, then right click inside the panel and choose
**Reload**. No Illustrator restart needed.

Changing `host/index.jsx` does require restarting Illustrator, because the
ExtendScript is loaded once when the panel initialises.

## Releasing

1. Raise the version: `ExtensionBundleVersion` and the `<Extension Version>` in
   `CSXS/manifest.xml`, the `version` in `host/index.jsx`, and the one in
   `test/mock-host.js`. The hygiene suite fails if those disagree.
2. Add a `## <version>` section to the top of `CHANGELOG.md`. It becomes the
   release notes.
3. Push, then on the **Actions** tab choose **release** and click **Run
   workflow**. Pushing a tag such as `v1.12.0` does the same thing.

`.github/workflows/release.yml` refuses a version that is already released or
has no changelog section, runs the five suites, and then runs
`tools/package.sh` twice: on a Mac for the macOS file and on Windows for the
Windows one. It publishes them under fixed names,
`UmbraContrastChecker-macOS.zxp` and `UmbraContrastChecker-Windows.zxp`, with a
`SHA256SUMS.txt`, so `releases/latest/download/<name>` always fetches the
newest. The README's download buttons depend on those names.

To build one locally:

```bash
tools/get-zxpsigncmd.sh     # once: Adobe's signing tool, checked against a pinned hash
tools/package.sh            # writes dist/UmbraContrastChecker-<version>.zxp
```

`package.sh` stages a clean copy of `CSXS`, `client`, `host` and `LICENSE`,
strips the files that break signature verification, refuses to build if a
symlink or a `.debug` slipped in, signs with a timestamp, and reads the result
back with `ZXPSignCmd -verify` before calling it built.

Things about signing that cost real time if you learn them the hard way:

- **The timestamp is not optional.** Without `-tsa` the `.zxp` stops installing
  the moment the certificate expires, and every user hits a wall at once. The
  script tries three timestamp servers and writes nothing if all of them fail.
- **Sign on the platform your users run on.** Adobe's guidance is to build the
  Windows `.zxp` on Windows, which is why the workflow builds two.
- **Self-signed is fine, and so is a fresh one per build.** A self-signed
  certificate is what lets a `.zxp` install without debug mode. The script makes
  a throwaway one for each build and deletes it, unless `UMBRA_CERT` points at a
  `.p12`, or the repository has `UMBRA_CERT_P12` (the file, base64 encoded) and
  `UMBRA_CERT_PASSWORD` secrets for the workflow to use. Every certificate the
  script makes names Artchemy Labs LLC. Adobe Exchange is a listing channel with
  a review process, not a safety rating, and it is a separate decision.
- **ZXPSignCmd broke timestamped signing in April 2025.** Adobe fixed it the
  next month. `get-zxpsigncmd.sh` pins a build from after the fix. Adobe ships
  the Mac build for Intel only, so Apple silicon runs it through Rosetta.

## Suggestion engine, measured

Over 3,504 failing colour pairs, the brightness slider alone reaches AA for
78.6% of them. The rung swatches add 4.1% that the slider cannot reach at that
hue because saturation has to move. For the remaining 17.3% nothing on that side
works and the other colour has to change.

That is why the rung row appears only when the slider cannot get there. Four
times in five it was duplicating what the slider marks already offer, in 34px of
a 240px panel.

## The rule everything else serves

Gradients, patterns and placed images have no single colour, so the ratio, the
matrix and the suggestions all go blank and the panel names the side it could
not read.

This has been broken six different ways across four releases. Every one of them
ended in a confident green tick on artwork nobody had measured. Any change that
can produce a ratio from a fallback value is the bug, not the feature.
