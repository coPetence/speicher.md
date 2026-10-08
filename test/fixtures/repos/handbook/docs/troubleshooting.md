---
description: Common problems, and what they usually mean.
indexable: false
icon: circle-alert
---

# Troubleshooting

`indexable: false` governs **AI retrieval only**. This page is still browsable over
HTTP, still returned by keyword search, and still served by the MCP `read` and
`list` tools — excluding it from `read` would break the assertion that the
permitted path set is identical on both surfaces.

It sorts after the numbered files, alphabetically, because it has no prefix.

<script>alert('this must never survive ingest')</script>
<a href="javascript:alert(1)">nor this</a>
