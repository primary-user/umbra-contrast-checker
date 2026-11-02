# Changelog

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
