---
title: Reference
icon: code
---

# Reference

A landing page spelled as a **file beside its folder** — `reference.md` next to
`reference/` — which is how most documentation generators spell a section page.
Rejecting it as a slug collision would make a large share of real repositories
un-ingestable, so it has to behave exactly as `reference/index.md` would: it becomes
the folder, it has no URL of its own beside it, and it gives the folder its title
and icon.

This case arrived from a real corpus rather than from anyone's imagination. It lives
here now because it is a *convention* — something this project decided to support —
and conventions belong in the fixture that is built on purpose.

:::caution[Deprecated]
A callout carrying the author's own title. The level is `caution`, which renders in
the warning accent; the label is whatever was written in the brackets, not the name
of the level. Both halves matter: dropping the title silently replaces the author's
words with ours.
:::
