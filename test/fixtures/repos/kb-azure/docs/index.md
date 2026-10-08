---
description: Shared key vaults for dotenvx private keys.
---

# Shared env secret key vaults

We maintain two Azure key vaults for dotenvx private keys. The keys encrypt and
decrypt env files using the [dotenvx tool](@kb-dev-tools:dotenvx) — the address
form with the namespace left off, which is the instance's default one.

The same page by wikilink: [[@kb-dev-tools:dotenvx|the dotenvx tool]].

Tolerances are in another namespace, so that address writes it out:
[[@northwind-engineering/specs:tolerances|Northwind tolerances]].

## Links inside this repository

- By name, the way a vault links: [[vault]]
- By path: [[guides/vault]]
- By relative path, with an alias: [[./reference/vault|the reference]]
- With an anchor: [[guides/vault#rotation|rotating a key]]

![[images/diagram.png]]

An embed of a page, which is not transclusion: ![[guides/vault]]

An address naming this very page, which is not a relation to itself:
[[@copetence/kb-azure:|these vaults]].

An address this instance cannot read: [broken](@not/a/valid/address/here:x)
