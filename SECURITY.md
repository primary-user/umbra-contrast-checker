# Security

## Reporting a vulnerability

Use GitHub's private vulnerability reporting on this repository. Go to the
**Security** tab and choose **Report a vulnerability**. That keeps the report
private until there is a fix.

Please do not open a public issue for anything that could be exploited.

Expect an acknowledgement within a week. If the report is valid you will be
credited in the release notes unless you ask not to be.

## What this extension actually does

Worth knowing before you audit it, and worth knowing before you install it on a
managed machine.

**It reads the screen.** The eyedropper has no pixel API to call, because
Illustrator exposes none, so it shells out to `screencapture` on macOS and
`CopyFromScreen` on Windows. Each capture is written to your temp folder as
`umbra-loupe.png` and read back, beside the small helper scripts that take it
(`umbra-loupe`, `umbra-grab` and `umbra-pointer`). macOS gates this behind
Screen Recording permission, granted to Illustrator, once.

**It runs a small local helper while the eyedropper is armed.** A pointer helper
reports the cursor position about thirty times a second to a file in the temp
folder. It starts when you arm the eyedropper and stops when you disarm it, and
a tracking session ends itself after 45 seconds. The panel sweeps for orphaned
helpers at boot.

**It writes to your artwork.** Applying a fix sets fills on the objects sharing
the measured colour. Every write is a single undo step.

**It makes no network requests.** The panel loads nothing from the network, and
the hygiene suite fails if a `<script src>` ever points at a remote host. The
only outbound traffic is your browser opening a link you clicked in Settings.

**It stores settings locally.** Target level, Medium, size override and rendered
colour measurement go to the panel's own CEP scoped storage.
Nothing is sent anywhere.

## No debug port in a release

The panel can expose itself to Chrome DevTools on port 8099 through a `.debug`
file in the extension root. That file is not committed, `.gitignore` covers it,
and `tools/package.sh` refuses to build if one reaches the staging folder. A
shipped extension has no business carrying a debug port.

If you build your own `.zxp` from source, check that no `.debug` is in it.

## Signed releases, and what that does and does not mean

Releases are signed, which is what lets the `.zxp` install without turning on
Illustrator's `PlayerDebugMode`. That setting lowers a bar for every extension on
the machine, not only this one, so avoiding it is worth something.

Every release is built and signed on GitHub's machines by
`.github/workflows/release.yml`, from the commit the release points at, and the
run is public, so you can see what went into the files. `SHA256SUMS.txt` beside
them lets you check that a download arrived intact.

The certificate is self-signed rather than issued through Adobe Exchange. Some
installers describe that as an unverified publisher. The signature proves the
files inside have not changed since the `.zxp` was signed. It does not prove who
signed it, and it does not mean Adobe reviewed the code. Download releases only
from this repository's Releases page.

Installing the unpackaged folder instead, as a developer would, does require
`PlayerDebugMode`. Prefer the signed `.zxp` on any machine you do not control.
