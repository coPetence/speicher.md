# Speicher

An access-controlled reader over documentation living in git repositories.

This page is readable by anybody, including a caller carrying no credential at
all. See [getting started](./getting-started.md).

![How a request resolves](./diagram.png)

An asset inherits the access of the folder it lives in, so this one is public for
the same reason the page is — and it is the case that makes a cacheable page worth
having, since an image no shared cache may hold costs a request per reader.
