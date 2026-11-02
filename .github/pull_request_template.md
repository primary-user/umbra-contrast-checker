## What broke

What the panel did wrong, or what it could not do. Real numbers beat
descriptions. "Reported 21.00:1 for artwork rendering 3.95" says more than
"gradient handling was off".

## What changed

## How it is held down

Which suite, which assertion. A fix without a test tends to come back.

- [ ] `npm test` passes, all five suites
- [ ] Colour logic stayed in `client/js/color.js`, not in the host
- [ ] Nothing can now produce a ratio from a fallback value
- [ ] Any new control with a hover state is in `HOVERABLE` in `test/run-render.js`
- [ ] Any new outbound link is a button through `BRIDGE.openExternal`, not an `<a href>`
- [ ] CHANGELOG.md updated if this is user visible
