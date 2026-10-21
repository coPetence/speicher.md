# MCP tools

Speicher runs an MCP server at `https://<your-host>/mcp`, so AI assistants can search and read your documentation. Clients send JSON-RPC requests to it over HTTP and sign in with OAuth. Every tool sees only the pages the signed-in person can read. On an instance with public repositories, clients can also connect without signing in and see only the public pages.

All tools are read-only and return plain text.

<!-- generated: mcp-tools -->
<!-- prettier-ignore-start -->
## search

**Search documentation** · read-only

Full-text search of documentation pages. Results include page path, title and a matching passage; returns `No results.` when nothing matches.

| Key | Type | Default | Required | Description |
| --- | --- | --- | --- | --- |
| `query` | string |  | yes | The text to search for. |
| `limit` | integer | `10` |  | Between 1 and 50. |
| `path_prefix` | string |  |  | Limit search to pages under this path, e.g. `/javascript/sdk`. Returns `No results.` if the path does not exist. |

## read

**Read a page** · read-only

Read a documentation page by path and return its full content as markdown. Returns an error if the path does not resolve to a page.

| Key | Type | Default | Required | Description |
| --- | --- | --- | --- | --- |
| `path` | string |  | yes | The path of the documentation page to read, e.g. `/javascript/sdk/overview`. |

## list

**List documentation** · read-only

List documentation pages and repositories at a path. Without a path, lists all visible repositories.

| Key | Type | Default | Required | Description |
| --- | --- | --- | --- | --- |
| `path` | string |  |  | Path within the documentation tree to list. Omit or set to `/` to list all repositories. |
<!-- prettier-ignore-end -->
<!-- /generated -->
