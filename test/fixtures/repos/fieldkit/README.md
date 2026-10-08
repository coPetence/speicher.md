# fieldkit

Documentation for Fieldkit, a product that does not exist. Written for this project as
a test corpus; nothing here is copied from anybody's documentation.

It replaces a vendored copy of a real Starlight site, and it inherits that copy's job:
to look like documentation written for another tool, not for Speicher. So the rule for
editing it is the reverse of the rule for `handbook`:

- **Add content the way a docs team would write it** — a new SDK page, a reworded
  guide, a link to the published site's URL. Foreign frontmatter, component tags and
  sloppy Markdown are features.
- **Never adjust it to make a test pass.** If ingest handles something here badly,
  that is the finding. Fix the code, or record the gap in `fieldkit.spec.ts` the way
  `KNOWN GAP` is recorded.
- **Never add a Speicher convention to it.** No numeric filename prefixes, no `icon`,
  no `redirect_from`, no nested `.speicher.yaml`. Anything that needs a shape arranged
  on purpose belongs in `handbook`.

`test/unit/fixture-shapes.spec.ts` asserts the shapes this corpus exists to carry, so
a tidy-up that removes one fails rather than quietly turning a threshold in
`fieldkit.spec.ts` into one that passes for the wrong reason.

This file and `.speicher.yaml` sit outside `docs/`, which is the `ingest_root`, so
neither is ingested.
