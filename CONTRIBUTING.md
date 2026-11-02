# Contributing

Thanks for looking. This is a small, opinionated codebase, and most of the
opinions exist because something went wrong once. This file is the short version
of what a change has to keep true.

## Licence, first

The source is public so anyone can audit it. That is not the same as open
source. Artchemy Labs LLC owns the project, and [LICENSE](LICENSE) grants use,
study, and internal modification, but not redistribution.

Forking to read the code or to build a change is expressly allowed. Publishing
that fork as a product is not.

Section 4 of the licence covers contributions. In short, opening a pull request
grants us permission to ship what you wrote as part of the project, including in
commercial releases, and confirms the work is yours to give. You keep your
copyright. If that is not something you want to do, open an issue instead. A
good bug report is worth more than most patches anyway.

[docs/internals.md](docs/internals.md) has the architecture, the test notes and
the release process.

## Get it running

No build step and no dependencies. Copy the folder into Illustrator's CEP
extensions directory, turn on debug mode, restart. Full walkthrough in
[INSTALL.md](INSTALL.md).

For panel work you often do not need Illustrator at all. `test/run-panel.js`
loads the real markup and the real controller into jsdom against a mock host,
and `test/run-render.js` runs the same thing in real Chromium.

## Run the suites

```bash
cd test
npm install
npm test
```

Five suites, each printing its own count and exiting non zero on failure.

| Suite | What it covers |
|---|---|
| `run-hygiene.js` | Cross file integrity, dead code, and that nothing personal or local ships in the repo. |
| `run-color.js` | The colour maths against published WCAG and CIE reference values. No DOM. |
| `run-guards.js` | Host layer guards, Illustrator's enum names, and a 20,000 case fuzz. |
| `run-panel.js` | The real panel driven against a mock Illustrator, under jsdom. |
| `run-render.js` | The real panel in real Chromium. Skips cleanly without Playwright. |

CI runs all five on every push and pull request.

## The one architectural rule

**`host/index.jsx` reports facts and performs writes. It does no colour
science.** Every ratio, blend, composite and suggestion is computed in
`client/js/color.js`, which is pure functions with no DOM and no host.

That is why the maths can be tested in Node without Illustrator anywhere near
it, and why a future UXP port is a bridge swap rather than a rewrite. A change
that moves colour logic into the host will be asked to move it back.

## What a change has to keep true

**Never show a number the tool did not measure.** Gradients, patterns and placed
images have no single colour, so the ratio, the matrix and the suggestions go
blank and the panel names the side it could not read. This rule has been broken
six different ways across four releases, and every one of them ended in a
confident green tick on artwork nobody had checked. If your change can produce a
ratio from a fallback value, it is the bug, not the feature.

**The panel passes its own check.** Every piece of text clears 4.5:1 and every
icon clears 3:1, against the surface actually behind it, at rest and under the
pointer. `run-render.js` measures the rendered panel and fails if a palette
change slips. If you add a control with a hover state, add it to `HOVERABLE` in
that suite, because the hover pass walks a named list rather than the whole DOM.

**Nothing navigates the panel away.** A CEP panel is a chrome less webview with
no back button, so an `<a href>` replaces the extension with a web page. Use a
button and `BRIDGE.openExternal`. The hygiene suite fails on any `<a href>` in
the markup.

**Keyboard parity.** Every control is in the tab order, the options popover traps
Tab and restores focus on close, verdicts are announced through the live region,
and pass or fail is never carried by colour alone.

**One undo step per user action.** CEP cannot group undo steps, so anything that
writes on every frame leaves fifty entries between the designer and the colour
they started from. Preview in the panel, write once on release.

## Style

Match what is already there. Plain ES5 in `client/`, because CEP's runtime is
old and the panel loads through `<script>` tags with no bundler. ExtendScript in
`host/` is older still.

Comments here explain **why**, usually by naming the failure that made the code
look the way it does. A comment restating what the next line obviously does is
noise. A comment recording that `ImageColorSpace.Grayscale` throws on a name it
does not know is what stops someone reverting the guard.

## Pull requests

Say what broke, how you reproduced it, and what test now holds it down. A fix
without a test tends to come back, and this repository has the changelog to
prove it.

Small and focused beats large and comprehensive. If a change touches the colour
engine, the host bridge and the UI at once, it is usually three changes.

## Conduct

Be decent. Assume the other person is trying to make the tool better. Reports
about the project or about someone's behaviour in it go to the maintainers
through a private security advisory on the repository, which is the one private
channel GitHub gives us.
