# Changelog

## 1.11.0

Three fixes to what the panel calls a pass, two features removed, and nothing
added that runs unless you ask for it.

**Gradients are graded along their length, not at their stops.** Grading the
stops is only right when the text is lighter, or darker, than every stop. When
the text's luminance falls between two of them the ramp passes through the
text's own colour somewhere in between, and the text vanishes there. #767676 on
a white to black ramp read 4.54:1 against its stops, an AA pass, and is 1.00:1 a
little past halfway. The middle can be worse even without a crossing:
Illustrator mixes gradients in gamma-encoded RGB, so a red to green ramp is
darker in the middle than at either end, and black text that read 5.25:1 at the
stops is 3.94:1 at worst. That is an AA pass turned into the failure it is.

The panel now samples every segment between stops and treats neighbouring
samples as connected, so a crossing is caught exactly rather than nearly. The
samples are on a budget of 256 across the whole gradient, and each one's
luminance is computed once, because the sliders regrade every candidate colour
against this list on every drag event. Stops are walked in ramp order, read from
`rampPoint`, so a gradient whose stops were dragged past each other is still
walked in the order it is painted.

This also changed what the panel suggests. On a white to near black ramp it used
to offer a mid grey as the 3:1 fix, which clears both ends and vanishes in the
middle. It now says no single text colour clears the whole gradient, and no
longer tells you to change the background, which for a gradient is the one fill
the panel cannot write. That message had simply never been reachable over a
gradient before.

**18px web type is body text.** WCAG's large text is 18pt, or 14pt bold, in CSS
points, which its own guidance converts at 1pt to 1.333px: 24px and 18.66px.
Illustrator web documents count one pixel as one point, so 18px type in an RGB
layout is 13.5pt, which is body text needing 4.5:1. The panel graded it as large
and held it to 3:1. A new **Medium** setting decides: Screen uses 24 and 18.66
bold, Print uses 18 and 14 bold, and Auto picks Screen for RGB documents and
Print for CMYK. The verdict shows which rule it used through the unit, `18px
body text` or `18pt large text`, and redraws when the document's colour space
arrives after the first reading.

**Outlined type gets asked about.** Outlined text is paths, so it was graded as a
graphic at 3:1, while WCAG grades images of text as text unless they are a logo.
The panel cannot tell a headline from an icon set, so when a selection is shaped
like outlined type, a group holding compound paths and three or more shapes in
one colour, it asks, and offers body or large text in one tap. Outlined type is
usually display type, so guessing body would be wrong as often as right. The
answer holds for that selection only: it resets on the next one and is never
saved, so one headline cannot quietly regrade every icon after it.

**The Render button is gone.** It asked Illustrator to rasterise the selection
through `doc.imageCapture`, which drives the same rasteriser as Save For Web and
was the least stable API the host touched, with failures that are often native
and so invisible to any try block. Nobody using the panel could tell what it
did. The eyedropper does the same job from the screen. Removed with it:
`wcagSnapshot`, `wcagSnapshotView`, `captureRect`, `wcagCleanupSnapshots`, the
snapshot files in the temp folder, and the cleanup call on the way out.

**Diagnose is gone.** Its own comment called it scaffolding for the shakedown
period, to come out once the panel had settled. The 1.9.0 crash was diagnosed
from the macOS crash report, not from it. The panel version, which only Diagnose
used to show, is now at the bottom of the gear menu, read from the host so it
names the code that is actually running. The bug report form asks for that, the
artwork's groups and blend modes, and the `.ips` file if Illustrator crashed.

The panel suite used Diagnose as its only window onto the eyedropper's internals.
That window is now a read-only probe the panel exposes only when the test harness
sets a flag before it loads. Nothing in Illustrator sets the flag, so a real
install exposes nothing. Every assertion that read the report reads the probe,
and the one that proved a held frame is dropped on a change of selection was
moved from the Render button to an eyedropper lock, because the rule belongs to
the held frame and not to how it was captured.

Also removed, because the removals left them with no callers: the queue's stall
counters and their accessors, `imageSpaceName`, `fail`, and the desktop folder
the host used to report for saving reports nobody writes any more. The bug report
form, the README, INSTALL and the internals notes no longer mention any of it.

## 1.10.0

**The scan is gone.** It walked every text frame in the document on demand,
kept a second registry of page item handles alive between calls so its rows
stayed clickable, and carried its own artboard picker, filter, list renderer and
selection writer. Nobody using the panel day to day reached for it. Removing it
takes 34,077 bytes, 8.4 percent, off what ships in the `.zxp`, and two evalScript
entry points off the host: `wcagScan` and `wcagSelectTokens`, along with
`chooseArtboard` and `artboardHolding`, which only the scan called.

**One registry of stored handles instead of two.** The second existed so scan
tokens would survive the selection being re-read under them. Every stored handle
is a thing that can outlive the art it points at, which is the mistake that
crashed 1.9.0, so the right number of them is the smallest one that works. The
document-scoped check from 1.9.1 is unchanged.

**`wcagDocInfo` no longer walks the artboards.** It reported every artboard so
the scan could build a menu. The panel only needs the document name and colour
space now, so that is all it reads.

**The crash safety guards could not fail the build, and now they can.** The
section of `test/run-guards.js` added in 1.9.1 was appended after the line that
prints the total and sets the exit code. Its checks ran and printed, but the
verdict had already been reached, so a broken crash fix could fail every one of
them while the suite reported success and exited zero. The summary now runs
last. Each crash guard was then proven by mutation: deleting the document check
in `lookupItem` turns the suite red with exit code 1, which it would not have
done before.

**One of those guards was also wrong.** It checked that the document test came
before the handle probe by comparing two string positions, and a string that is
missing has position minus one, which is less than everything. So it passed with
the document check deleted entirely. It now requires both to exist.

**Group opacity is now tested through the main view.** The 3.08 versus 4.86
versus 9.25 case, black text in a 65 percent group, was only ever exercised
through a scan row. Deleting the scan tests would have deleted the only panel
test of whether the main view hands a shared group to the colour engine at all.
It is a main view scenario now, and a mutant that drops the shared group reads
5.31 with a tick, which the test catches.

**The README described outlined text wrongly.** It said outlined text could not
be scanned. The thing worth knowing is different: outlined type is paths, so the
panel grades it as a graphic at 3:1 unless you set Treat text as, while WCAG
grades images of text as text. The caveat now says that.

## 1.9.1

**Illustrator crashed, and this release exists to stop it.** A crash report from
30.7 on macOS 26.6 put it beyond argument: `EXC_BAD_ACCESS`, `SIGBUS`, faulting
at `0x1000000018`, which is a wild pointer plus a 24 byte field offset in
reserved address space. The faulting frame was
`ScScript::LiveObjectProperty::get`, ExtendScript reading a property off a live
Illustrator object. Seventy seven seconds after launch. Not out of memory: 2.2 GB
allocated at the time.

The read was `item.opacity` in `appendWatched`, and the item was a page item
wrapper the host had stored on a previous call. Illustrator frees a document's
art database when the document closes, and rolls deleted art out of it when the
undo history moves on, and in neither case does it tell the wrappers still
pointing into it. The read was inside a `try`. It made no difference. A
segmentation fault is not a JavaScript exception, and no `catch` in this language
will ever see one.

The rest of the stack said the other half. The call arrived through
`PlugPlugOwl` and `performSelectorOnMainThread`, dispatched by `__CFRunLoopRun`
inside a nested event loop that Illustrator was pumping while it handled a mouse
click. The panel's poll landed in the middle of the user clicking something.

**Stored handles are now scoped to the document they came from.** Both registries
record their document as a plain string when they are written, and every lookup
compares strings before it touches anything. String comparison cannot fault. A
mismatch replaces the whole registry with a fresh object, which drops every
reference without reading one. Dropping a handle is always safe; reading one is
only safe inside the call that obtained it.

**And the handles go entirely whenever the panel has not been watching.** The
document key closes the ordinary cases, but not one: close a file and reopen the
same file from the same path and the key matches again over handles from the
previous open. The panel now drops every stored handle when it comes back from
hidden, before anything can ask for one. A token that has gone resolves to null,
and both callers already say "reselect and try again" rather than guessing.

**The poll no longer dereferences anything.** `appendWatched` is gone. The
signature reads only what `doc.selection` hands back inside that same call, where
every wrapper is freshly resolved and cannot outlive the call that made it.

**The feature it powered survives.** Recolouring a background that is not
selected still refreshes the reading, now on a slow heartbeat that re-reads the
whole selection rather than by holding handles. It takes a couple of seconds
instead of being instant, and it never fires on top of a drag in progress. That
is the entire user-visible cost of the fix.

**The panel stands down when nobody is looking at it.** 1.9.0 polled every 700ms
from load until the page was destroyed, with no stop path anywhere in the file:
not when the panel was hidden, not when no document was open, not when
Illustrator was quitting. That is about 5,100 evalScript calls an hour dispatched
onto the main thread whatever it happened to be doing. The rate now steps down
after six quiet polls and again after thirty, stops when the panel is hidden,
stops for good when the host says it is quitting, and rests rather than retrying
when Illustrator fails to answer.

**The freezes were a separate bug with the same cause: too much work, too often.**
`candidateShapes` walked `doc.pageItems` with no cap of any kind. That collection
is recursive, so a page of outlined type is thousands of entries before any real
artwork is counted, and indexed access into a live Illustrator collection is
O(i), so the loop was quadratic twice over. It ran on every selection change.

- Bounds now come from `geometricBounds`. `visibleBounds` made Illustrator
  resolve every live effect, stroke, brush and drop shadow in the file before it
  could answer, and it was the only bounds read in the host. It is also the wrong
  answer: a card with a 20pt shadow is not a larger card, and grading text
  against a shape only its shadow reaches was a real mismeasurement.
- The sweep has a ceiling, and `items.length` is read once instead of on every
  iteration.
- `wcagSelection` reads each fill once. Four passes each called `fillOf` on the
  same items and `refuseReason` called it a fifth time, and on a CMYK document
  every one of those is a colour engine round trip. Select All over a thousand
  objects was paying for four to five thousand conversions per selection change.
- `wcagScan` caps iterations, not just rows. A row cap bounds the output, not the
  work, so twenty thousand text frames none of which were on the scanned artboard
  meant twenty thousand quadratic iterations returning an empty list. The
  artboard test now runs before the container walk rather than after it.

**Selecting failing rows is one selection write, not five hundred.** Setting
`.selected` object by object fired a selection changed notification per object,
each of which fed straight back into the panel's own poll.

**Photos can be backdrops again.** Four candidate tests shared one `try` whose
`catch` discarded the item. `RasterItem` and `PlacedItem` carry neither `guides`
nor `filled`, so on any build where a missing property throws, every photo in the
document fell out of the candidate list on the first test, and the branch that
reports an image as an opaque stop was unreachable. White text over a photo was
measured against the white card behind the photo. Each test now stands alone.

**`imageCapture` gets three attempts instead of five.** Two of the five only
changed the resolution, tried nothing the third had not, and were as likely to
take Illustrator down as to succeed. A capture is also no longer called
successful because a file exists: a failed attempt could leave a zero byte PNG
behind, which satisfied the old test.

**Giving up on a call no longer starts the next one immediately.** The abandon
timer released the queue slot and dispatched again into a host that by definition
had not answered, which broke the one invariant the queue exists to hold at
exactly the moment the host was already struggling.

**A loupe frame that never decodes no longer hangs the session.** The next frame
was scheduled from the decode callback and nowhere else, so if neither `onload`
nor `onerror` fired, the 45 second hard stop never ran and the crosshair tracker
kept reading a file every 40ms for the life of the panel.

**Switching pick slots no longer leaks a selection hold.** Clicking Bg while Fg
was armed took a second hold without releasing the first, leaving the host
holding live page item references indefinitely, including across a document
close. Same exposure as the crash, reached a different way.

**Snapshot PNGs are swept before each capture** rather than only on
`beforeunload`, which does not run when the CEF process is killed and does not
run when Illustrator crashes.

Not fixed, because it cannot be: Illustrator exposes no undo grouping to
ExtendScript. There is no `suspendHistory` and no `beginUndoGroup`. Direct DOM
writes mostly do not register individually, and the thing that reliably splits
them into separate entries is `app.redraw()`, which this panel already refuses to
call.

## 1.9.0

**Every outbound link in the panel failed its own contrast check on hover.**
`.link-btn:hover` uses the accent tint, and that tint was chosen against the
panel chrome. The Settings popover is a lighter surface, where the same colour
measures 4.46:1, under the 4.5 the panel demands of your artwork. The static
sweep passed it because the resting colour is a different one, and the hover
sweep never looked: it walks a named list of controls and no link was on the
list. All three are on it now, and the tint moved the smallest distance that
clears 4.5 on the lightest surface it lands on.

**Credit and support links in Settings.** Who built the panel, the site and
Ko-fi, at the bottom of the popover and nowhere near the main view. Buttons
rather than links, opened through CEP's browser opener, for the same reason the
specification link is one: an `<a href>` in a chrome-less webview replaces the
panel with a web page and leaves no way back. The hygiene suite now fails on any
`<a href>` in the markup rather than only inside the popover.

The repository is public-facing. `INSTALL.md` is an install guide again rather
than an install guide with a changelog bolted underneath it, the pre-release
working name is gone from every file and the hygiene suite fails if it returns,
the licence names Artchemy Labs LLC, and there are contribution notes, security
notes, issue templates and a CI workflow that runs all five suites.

**The licence changed, before anyone had it.** MIT let anyone redistribute and
sell this, which was never the intent.

It is now the Umbra Contrast Checker Source-Available License 1.0. The source
stays public, because a tool that asks you to trust a number should let you see
how the number was reached. The licence grants free use for anything, including
commercial and paid client work, on any number of machines, plus reading,
auditing, internal modification, and forking to study the code or send a change
back. It withholds distribution, resale, bundling into anything you charge for,
publishing a build or a renamed version, and marketplace listings.

It opens with a plain-language summary, because the people who use this are
designers rather than lawyers and a licence nobody reads protects nobody.

Every source file carries the copyright notice, and the hygiene suite fails if
one loses it or if the MIT text creeps back.

**Installing is one drag now.** `tools/package.sh` builds and signs a
distributable `.zxp`. A signed extension installs through any ZXP installer
without the user touching `PlayerDebugMode`, which was the worst part of the old
instructions. The script stages a clean copy, strips the files that break
signature verification, refuses to build if a symlink or a debug port slipped
in, and always passes a timestamp, because a `.zxp` signed without one stops
installing the day the certificate expires.

`.debug` is no longer committed. It exposed the panel to Chrome DevTools on port
8099, which is useful locally and wrong in anything shipped. It is gitignored,
the packaging script refuses to build with one present, the hygiene suite fails
if one is committed, and `docs/internals.md` has the file to recreate when you
want it.

**The README is a product README.** Architecture, the eyedropper mechanism, the
test suite notes, the release process and the measured suggestion-engine numbers
moved to `docs/internals.md`. `INSTALL.md` leads with the `.zxp` and keeps the
folder install as a development path.

**House style, enforced.** No em dashes or en dashes in anything a person reads
as prose. Every documentation file, every issue template, every tooltip and
every sentence the panel puts on screen was rewritten without them. Code is
exempt, so comments and fenced examples are untouched. The hygiene suite checks
the documentation, the issue templates, and the panel's tooltips and accessible
names on every run.

One knock-on. The empty-value glyph was a long dash, so it changed too. The
ratio, the swatch hexes and the empty matrix cells now show a middle dot, and
the `:1` after the ratio is hidden while there is no number, because `:1` beside
a placeholder reads as a rendering fault rather than as nothing measured yet.

## 1.8.0

An adversarial sweep, which found three bugs bad enough to be worth stating
plainly.

**The panel was re-reading the whole selection twenty times a minute, and it
wiped every slider drag.** `appendWatched` stamped freshly-minted token NAMES
into the selection signature, and `wcagSelection` clears its registry and
reissues those names on every call, so the signature differed every single time.
`loadSelection` therefore fired on every poll forever, walking every page item
each time: precisely the cost the cheap fingerprint exists to avoid.

The user-visible damage was worse than the waste. Each reload called
`clearSampleState`, which nulls the slider draft, so a drag held longer than
700ms had its thumb snapped back and its edit silently dropped. Pausing mid-drag
to read the ratio is the normal gesture. Stamped positionally now; the mock
reissues token names exactly as the host does, so this cannot hide again.

**A gradient's own opacity was discarded, reporting 21.00 for artwork rendering
3.95.** Each stop's alpha was ASSIGNED to `alphaOverBackground` rather than
multiplied with the layer's, so a black gradient scrim at 50% over white paper
measured as solid black: a green pass, where the same artwork described as a
solid correctly failed. A gradient scrim over a photo is the canonical case.

**Semi-transparent artwork was a complete dead end where every control was a
silent no-op.** Black text at 50% on white paper renders `#808080`, and no
authored fill can render darker through 50%. The side is genuinely unfixable.
The panel showed a green passing zone across half the brightness track, three
"snap to" marks, and a hidden rung ladder; clicking the advertised 7:1 mark
snapped the thumb back and wrote nothing. The one sentence explaining why was
written into `#fix-note`, which lived INSIDE the block that hides itself, so it
was never once displayed. The zones, marks and rungs are now reachability-aware
(they only offer colours the object can actually render), and the outcome line
lives outside the collapsible block, which also means a successful edit no longer
hides the sentence naming what it changed.

Also fixed:

- An Illustrator render could be rasterised into the 26px collapsed strip and
  CSS-stretched over 124px, so one screen pixel spanned five canvas rows and a
  click to sample landed on a pixel nobody could see. The height transition is
  gone (it defeated the synchronous-expand contract) and a render in flight now
  keeps the pane open.
- Sliders were live on sides the panel had just refused to measure: one drag on a
  stroke-only path sent a fill, and the host does not refuse an unfilled path,
  so a shape silently acquired a flat fill it never had.
- Every ordinary scan row was labelled "on a gradient, 4.41 to 4.41".
- A held render survived a change of selection, still inviting a click that
  committed the previous selection's pixel with no notice.
- The background swatch put the literal word "gradient" on the clipboard.
- Gradient stops past the 24 cap, or whose colour will not resolve, are now
  disclosed rather than silently dropped from a range presented as complete.

## 1.7.0

**The verdict comes first.** It used to begin 420px down a 660px panel, below
the loupe, the swatches and the sliders, so anyone docking this narrower than
full height never saw the number without scrolling. It now starts at 133px.

Measured, before and after:

| Section | Was | Now |
|---|---|---|
| loupe + tools | 190px at 61 | 72px at 61 |
| **verdict** | 77px at **420** | 77px at **133** |
| swatches + sliders | split around the verdict | one block at 276 |
| whole panel | 558px | **440px** |

**The colour tools are one section.** Swatches, sliders and the fix rungs were
three parts of a single job, separated by the answer sitting in the middle of
them. They are now contiguous: each swatch directly above its own hue,
saturation and brightness column, with the rungs full-width beneath both.

**The preview pane collapses when nothing is being sampled.** At full height it
was 124px of empty grey displaying one sentence, and it sat above everything,
which is most of why the verdict was so far down. Idle it is a 26px strip; it
expands the moment the eyedropper is armed, before the first frame is drawn, so
the canvas is never sized against the collapsed height.

**Everything that qualifies the number sits with the number.** The CMYK caveat,
"measured against white paper", the gradient range and the grouped-artwork note
now follow the verdict rather than appearing above the tools.

## 1.6.0

**Colour sliders under each swatch.** Hue, saturation and brightness for the text
and for the background, working the way Illustrator's own colour panel does. The
panel tracks the drag live; the artwork changes once, when you let go.

That split is deliberate. CEP cannot group undo steps, so a slider writing on
every frame would leave fifty entries between you and the colour you started
from, meaning Cmd+Z fifty times to undo one drag. One write on release costs a
moment of lag and keeps undo meaning what it means everywhere else in
Illustrator.

**The compliance thresholds are drawn on the brightness track.** 3:1, 4.5:1 and
7:1 as marks, with the passing stretch painted green, so you can see where a
colour starts passing before you touch it, and click a mark to move the least
distance that clears it. A slider alone is hunting; a slider that shows the line
is designing.

**Sampling a colour no longer blocks fixing the artwork.** Eyedrop both sides to
see the problem and there was then no way to change anything at all, because both
counted as "picked by hand", even though the object was selected the whole time.
Any side whose object the panel knows is now editable; when the displayed colour
came from a screen pixel rather than from that object, the confirmation says so
instead of refusing the edit.

**Text on a gradient is measurable.** The host now reports every gradient stop,
and the panel grades the WORST of them, showing the range: *1.00 to 19.02 across
the gradient*. Averaging would have been a false pass waiting to happen. White
text on a white-to-black ramp averages to mid-grey and would "pass" while being
invisible at the light end. Suggestions are judged against every stop, so a
colour that fixes one end and fails the other is never offered. The swatch paints
the ramp rather than one stop's hex. A gradient whose stops cannot be read still
refuses, as before.

**The fix swatches now appear only when the slider cannot help.** Measured over
3,504 failing colour pairs: the brightness slider alone reaches AA for 78.6% of
them, the swatches add 4.1% the slider cannot reach at that hue because
saturation has to move, and for the remaining 17.3% nothing on that side works
and the other colour has to change. So four times in five the row was duplicating
what the slider marks already offer, in 34px of a 240px panel. It now appears
when it is the only route through, under the heading "No brightness passes", and
its presence is itself information.

Also: the Fixes block hides entirely when the artwork already passes, rather than
showing a header over an empty row; releasing a slider no longer flashes the old
colour for a poll before the new one lands.

## 1.5.0

**Stated conformance.** A line under the header, always visible: *WCAG 2.2 AA ·
SC 1.4.3 · 1.4.6 · 1.4.11*. The thresholds, the large-text definition and the
note that 2.2 conformance also covers 2.1 and 2.0 are in Settings, collapsed, with
a link to the specification rather than a transcription of it. WCAG 2.2 has been
the W3C Recommendation since 12 December 2024 and the contrast criteria are
unchanged from 2.1 and 2.0, so a requirement written against any of the three is
satisfied by this reading.

**Recolouring the background now updates the ratio.** The selection fingerprint
stamped only the *selected* items, and the background is found by geometry, not
selected. Editing the card behind the text in Illustrator's own Color panel moved
nothing, so the panel went on presenting a pre-edit ratio as a live reading. The
panel now tells the host which objects it is measuring and those are stamped too,
by direct registry lookup.

**Scans are thrown away when you close them.** Collapsing the section only hid it;
the rows stayed in state, so reopening on a different artboard, or a different
document, showed a list describing artwork that was no longer in front, with
every row still clickable and still selecting objects somewhere else. The list is
now cleared on close, on a change of document, and on a change of scope.

**Fix swatches are a WCAG ladder, not five shades of one target.** They used to
aim at whichever single threshold the current level and size implied, so a 1.3:1
pair got five near-identical suggestions around 3:1 and no way to ask for 4.5 or 7
without opening Settings first. Now there is one swatch per rung (3:1, 4.5:1,
7:1), each the nearest colour that reaches it, labelled with what it satisfies.
From 1.46:1 you can go straight to 7.11:1 in one click. Rungs already cleared are
marked done; rungs no shade of that colour can reach are shown greyed with the
reason, rather than dropped as though the tool had nothing left to offer.

**Text and Bg are eyedroppers, in one press.** They always started the loupe,
except while a frozen frame was held, where they set the slot and returned, so the
button appeared to do nothing and people pressed the eyedropper next. Both now
arm immediately, and both carry an eyedropper glyph so the gesture is visible
rather than learned.

Also: the specification link goes through CEP's browser opener, because an `<a
href>` in a chrome-less webview replaces the panel with a web page and leaves no
way back; `summary` elements are included in the options popover's focus trap.

## 1.4.0

Two independent adversarial reviews, one of correctness and one of the interface.
Everything below is a defect that was found, reproduced with real numbers, and
pinned with a test.

**Six ways the panel reported a pass for artwork that fails.** A contrast tool
that guesses is worse than no tool, so these are the ones that mattered most:

- A container both colours sit inside was composited twice. Black text on
  `#808080` in a group at 65% renders `#595959` on `#ACACAC`, which is 3.08:1, a
  failure. The panel said 4.86 and passed it. Cancelling the group entirely gave
  9.25, which was no better an answer; the group is now applied to the pair,
  once, over whatever sits behind it.
- The same container's blend mode was charged twice for the same reason.
  `#555555` on `#A0A0A0` inside a Multiply group renders exactly as authored
  (2.85:1) and was reported as 4.69 with a green tick. Eight of thirteen blend
  modes produced a false pass; the worst read 21.00 for artwork rendering 1.00.
- A gradient behind scanned text arrived as `rgb: null`, and the scan fell
  through to white paper. Black text on a gradient hero came back as a
  confident 21.00 ✓. Unmeasurable rows now show `?`, survive the "Problems only"
  filter, and are counted separately from the passes.
- A placed image had no fill to read, so it was treated as transparent and the
  backdrop search stepped straight through it onto the white card behind:
  12.63:1 "passes AAA" for artwork rendering about 1.42.
- The verdict was graded against the level the ratio *reached* rather than the
  level you chose. With AAA selected, 5.62:1 body text showed a green number,
  the words "passes AA", a ✕ in the AAA cell beside it and five suggested fixes
  underneath. The artboard scan had the same bug, and reported "all pass".
- One colour picked by hand with nothing selected was measured against white
  paper by default. It now refuses and names the half that is missing.

**Applying a fix could make the artwork worse.** The inverse solve ignored the
shared container and used a backdrop the object is not drawn on: on the case
above it offered "#404040 · 4.56:1", wrote `#060606`, and produced 2.90:1,
worse than the 3.08 it started from. It now inverts the same model the reading
uses, and refuses when no fill can reach the target. A fix derived from a
hand-sampled pixel is no longer written to the artwork at all; that used to
recolour whatever shape the host had detected underneath.

**The panel now passes its own accessibility check, not just its contrast one.**
The single focus style in the stylesheet drew an accent ring *inside* the colour
swatch, on top of the artwork (1.69:1 on a teal one, against the 3:1 SC 1.4.11
asks for), and no other control had one at all. There is now one indicator for
everything, in white with a dark halo, measured from real screenshots. Also
fixed: Tab could walk out of the options popover to the controls behind its own
scrim (and arm the screen-capturing eyedropper from behind a dialog you cannot
see past); closing the popover dropped focus to `<body>`; the scan list, the
whole triage workflow, was mouse-only; pass and fail in that list were told
apart by colour alone; the verdict was never announced, while the loupe readout
was a live region firing twenty-six times a second; ten controls were under the
24×24 target minimum.

**Settings are remembered.** Target level, size override, rendered-colour
measurement and the scan filter survive a reload, which in Illustrator means a
restart. The target level also moved into the header, because it is what every
verdict on screen means and it was visible only inside a popover.

**Esc now does what it said.** The hint read "Esc clears" and Esc did not clear:
the picked colours stayed and only the Auto chip released them, which nothing on
screen mentioned. Esc now closes a held frame, then hands the colours back.

Also: the apply confirmation used to be destroyed by the panel's own refresh
about 300ms after it appeared, including the line naming the fill actually
written to a transparent object; "Copy report" gave no feedback at all, because
it wrote to an element covered by the report itself; document info was read once
at boot, so Illustrator restoring panels before documents left an artboard menu
belonging to a file that was no longer open; suggested fixes are shown as the
contrast ramp they are documented to be; the "Fixes" header no longer sits over
an empty box in every blank state; the CMYK caveat moved out of the popover to
sit beside the numbers it qualifies; the artboard scope no longer reads
"Artboard 2: Artboard 2"; a held selection is released when a loupe session ends
any way at all, and is never restored into a different document.

## 1.3.0

**The preview showed nothing, and it was CSS.** `.snapshot-empty { display: flex }`
beat the browser's own `[hidden] { display: none }` (author styles win over
user-agent styles regardless of specificity), so the "Reading the screen…"
overlay could never be dismissed. The loupe had been drawing correctly
underneath it the whole time. A new browser-based test suite exists because
jsdom, which has no cascade engine, could never have caught it.

**The eyedropper became quick.** A frame cost 381ms, mostly `osascript` starting
up once per frame to answer "where is the pointer?". A pointer server now answers
once and keeps answering; the capture region grew past what the pane displays so
small movements pan inside the frame already held; and the crosshair tracks at
25fps independently of capture.

**Click to pick.** A real click anywhere on screen locks the colour. Illustrator's
selection is restored afterwards, so the click leaves no trace, except with a
drawing tool active, which the docs say plainly.

**Grouped artwork explains itself.** Black text in a group at 50% opacity renders
as grey; the panel now names the container and the reason instead of reporting an
unexplained number. Blend modes are inherited from containers, which they never
were before.

**The panel passes its own contrast check.** Eight pairs in its own chrome were
below 4.5:1, including white on the accent blue. Fixed with the extension's own
suggestion engine, and a test now measures the rendered panel.

Also: Auto became a real mode switch; fix swatches show the ratio they achieve;
grayscale conversion no longer falls back to a route that under-reported black
by five points of contrast; the loupe zoomed out; Health check, Swap and Export
CSV were removed.

## 1.2.0

Loupe rework: pointer server, panning, deferred locks that take the pixel you
asked for. Grayscale enum spelling and polarity. Ten defects from an adversarial
review, three of which produced silently wrong colours.

## 1.1.0

The preview became a loupe rather than a background render. Saturation blend mode
was silently ignored (`SATURATIONBLEND`, not `SATURATION`). Grey swatches were
unmeasurable (`Grayscale`, not `GrayScale`). Sampling read interpolated pixels
from a scaled canvas. Invisible artwork was being measured. Printed ratios could
round upward past a threshold.

**Six crash fixes.** The first build could take Illustrator down, which means
native code faulted rather than JavaScript throwing, so the search was for heavy
native calls and anything able to recurse without a floor:

- A `NaN` bound sailed through every range check (`NaN <= 0` is `false`, and so
  is `NaN > 300`), and `resolution = NaN` went straight into the rasteriser.
  Every value in that path is checked with an explicit `isNum()` now, capture
  area is capped at 2 megapixels, and anything over 20,000pt is refused.
- `imageCapture`, the heaviest native call here, was firing unguarded on every
  selection change. It is debounced, queued behind every other host call, and
  behind a breaker that disables it after two consecutive failures.
- `readColour()` recursed into spot colours and `flatten()` into nested groups,
  both with no depth limit. A spot swatch based on another spot colour blew the
  ExtendScript stack. Both are depth-capped.
- `app.redraw()` was removed. Forcing a redraw from inside `evalScript` is a
  known instability source, and Illustrator repaints on its own after a fill
  change.
- `evalScript` runs synchronously inside Illustrator, and a poll timer plus a
  click could put several calls on its main thread at once. The bridge runs one
  call at a time now, with a queue, a 20-second timeout and a depth cap.
- No host entry point had a top-level catch, so an ExtendScript error reached
  the panel as the string `EvalScript error.` Every entry point is wrapped in
  `guarded()`, which returns a readable error naming the function and line.

`test/run-guards.js` holds all of it down, including a 20,000-iteration fuzz over
hostile bounds proving no bad capture request can be produced.

## 1.0.0

First working build: selection measurement, backdrop search by geometry,
compositing through opacity and blend modes, artboard scan, suggested fixes
written back to the artwork.
