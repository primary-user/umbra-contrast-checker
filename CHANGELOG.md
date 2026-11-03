# Changelog

## 1.12.0

- **Text with more than one colour is graded at its weakest part.** A frame
  with a grey caption and one dark word used to be graded on whichever came
  first. Every colour, size and weight in the frame is now checked against its
  own threshold, the verdict is the part closest to failing, and a notice says
  the text is mixed. A fix recolours only that part and leaves the rest alone.
- **Mixed sizes count too.** A 24px headline and a 12px line in one frame need
  3:1 and 4.5:1. The 12px line is no longer passed on the headline's size.
- **Filled text boxes are found as the background.** Area type with a fill on
  its box is measured against that fill.
- **Draw Inside shapes and filled clipping paths are found.** Their fill is
  painted behind what they hold, and the panel now reads it, while a photo
  placed inside the shape still counts as nearer.
- **Shapes with holes and Pathfinder results are found.** Compound paths were
  read as having no fill at all.
- **A text frame larger than its card is measured against the card.** A shape
  now counts when it sits behind most of the text, not only when it encloses
  the whole frame. Selecting the text and the card together works the same way.
- **Cropped artwork only counts where it shows.** A shape cut down by a mask
  is no longer treated as the background beside the mask.
- **The eyedropper lands on the right pixel at Windows display scaling.** At
  125% or 150% it captured somewhere other than under the pointer.
- **Every Retina pixel can be picked.** The pointer was rounded to whole
  points, which left every other row and column out of reach.
- **A quick trackpad tap picks.** Taps shorter than the panel's sampling were
  missed and went straight to Illustrator.
- **The warning about unreadable gradient stops stays on screen.** It was
  cleared a moment after it appeared.

## 1.11.0

The first public release.

- **Gradients are graded along their whole length.** Text can pass against both
  ends of a gradient and still disappear in the middle. The panel now checks the
  full ramp and reports the worst point, so that text fails as it should.
- **Screen or print decides what counts as large text.** A new Medium setting,
  under the gear, uses 24px or 18.66px bold on screen and 18pt or 14pt bold in
  print. Auto picks Screen for RGB documents and Print for CMYK. The verdict shows
  which rule it used, for example "18px body text".
- **Outlined type gets asked about.** When a selection looks like outlined text,
  the panel asks whether to grade it as body or large text. The answer applies to
  that selection only.
- **Fewer buttons.** The Render button, Diagnose and the document scan are gone.
  The eyedropper covers what Render did.
- **Version and links in the gear menu.** The panel version, Artchemy Labs and
  Ko-fi sit at the bottom of the gear menu.

## Earlier versions

1.0.0 through 1.10.0 were private builds and were not released publicly.
