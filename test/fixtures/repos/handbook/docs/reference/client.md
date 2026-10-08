---
title: The client
icon: terminal
---

# The client

Generated API documentation, in the dialect the generators actually emit. Go's
`godoc`-derived output puts an empty named anchor before every symbol, and the
cross-references in the same document point at those names rather than at heading
slugs.

Both dialects have to land. A fragment that matches nothing does not scroll and does
not error, so half the cross-references in a reference manual can go nowhere without
anyone noticing.

Jump to [Client.New](#Client.New), [Client.ListSeq](#Client.ListSeq), or
[the errors it returns](#errors-it-returns).

<a name="Client.New"></a>

## Client.New

Constructs a client. The anchor above is an empty `<a name="…">` element: the
sanitiser has to keep the element *and* carry the name over to an `id`, because the
element has no other content to survive on.

<a name="Client.ListSeq"></a>

## Client.ListSeq

Lists sequentially. The dotted name is the second half of the problem — it is a
valid `id` and an invalid CSS identifier, which is why lookups here normalise rather
than interpolating a selector.

## Errors it returns

An ordinary heading with an ordinary generated slug, so that both anchor styles are
exercised in one document.
