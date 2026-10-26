---
icon: file-text
---

# Markdown syntax

Speicher reads CommonMark with the usual GitHub additions, plus callouts, wikilinks, footnotes and a set of MDX components. Pages render to plain HTML, so everything here works without JavaScript.

By default, Speicher reads every `.md` and `.mdx` file in the repository except `README.md` files. To change that, set [`sync`](01-speicher-yaml.md#choosing-files-with-sync) in `.speicher.yaml`.

## Pages and folders

- Every Markdown file becomes a page, and every folder becomes a section in the navigation.
- A number prefix of one to three digits sets the order and is left out of the URL: `01-install.md` is served as `/install`. A four-digit number such as `2024-review.md` is not a prefix, so the page keeps it in its URL and sorts by title.
- `index.md` (or `index.mdx`) is the folder's own page. A file named like a folder next to it, such as `guide.md` beside `guide/`, works the same way.
- A page without a prefix is sorted by its title, after the numbered ones.

### Page title

The title comes from the first of these that exists:

1. `title` in the frontmatter
2. the first `# Heading` of the page
3. the file name, without prefix and extension

The first `# Heading` is shown as the page title, so Speicher removes it from the page body. Start your sections with `##`.

## Frontmatter

A page can start with a YAML block between `---` lines:

```yaml
---
title: Deploying to production
description: How a release reaches the servers.
icon: rocket
tags: [operations, release]
redirect_from: [/handbook/ops/deploy]
draft: false
---
```

- `description` is shown in search results.
- `icon` is the name of a [Lucide icon](https://lucide.dev/icons), shown next to the page in the navigation. An unknown name is ignored with a warning.
- `tags` link pages on the same topic. They have no effect on who can read the page.
- `redirect_from` lists old addresses that should redirect here, for example after moving a page. Write the full path as it appears in the URL, including the repository, such as `/handbook/ops/deploy` or `/acme/handbook/ops/deploy`.
- `draft: true` leaves the file out completely.
- Keys Speicher doesn't know are ignored, and the sync warns about them.

All keys are listed under [Frontmatter](../06-reference/05-frontmatter.md). Frontmatter cannot change who can read a page; that is what [`.speicher.yaml`](02-access.md) is for.

:::caution
If the frontmatter is not valid YAML, Speicher rejects the file and reports the error on the **Sync status** page. The rest of its folder is not updated in that sync.
:::

## Headings and anchors

Every heading gets an anchor, so you can link to `#install` on a page:

| Heading               | Anchor            |
| --------------------- | ----------------- |
| `## Install`          | `#install`        |
| `## Über uns`         | `#ueber-uns`      |
| `## Setup & Upgrade`  | `#setup--upgrade` |
| a second `## Install` | `#install-1`      |

The anchor is the heading in lowercase, with German umlauts written out, punctuation removed and spaces turned into hyphens. To choose an anchor yourself, write the heading as HTML: `<h2 id="install-steps">Install</h2>`.

## Links

Link to another page by its file path, relative to the current file, including the extension:

```md
[Installation](./02-install.md)
[Upgrading](../operations/upgrade.md#before-you-start)
[Guide](./guide/index.md)
[Handbook home](/index.md)
```

- A path starting with `/` starts at the repository root.
- To link to a folder, link to its `index.md`.
- A link without the extension, such as `./02-install`, does not find the page.

Links to other files, such as a PDF, serve that file under the same access rules as the folder it is in. Links to websites open in a new tab.

A link to a file that doesn't exist is shown as a broken link, and the sync reports it as a warning. The sync also warns when a link points to a page that fewer people can read than the page the link is on.

### Links to other repositories

Start the address with `@`, followed by the repository and the page's path in that repository's URL:

```md
[dotenvx](@kb-dev-tools:dotenvx)
[Tolerances](@northwind-engineering/specs:tolerances)
[Docs on another source](@gitlab/acme/docs:getting-started)
```

Use one, two or three parts before the colon: the repository, the owner and repository, or the content source, owner and repository.

## Wikilinks

If you write in Obsidian, you can keep its link syntax:

```md
[[Setup Guide]]
[[guide/setup]]
[[setup|the setup page]]
[[setup#install]]
![[diagrams/architecture.png]]
```

Speicher looks for the target relative to the current file, then from the repository root, then by file name anywhere in the repository. The extension is optional. If several files have the same name, the link goes to the first one, and the sync warns you to write a path instead.

`![[image.png]]` shows the image. `![[Some page]]` cannot show a page inside another yet, so it becomes a link to that page.

## Images and files

```md
![Architecture overview](./img/architecture.png)
```

- Supported images are PNG, JPEG, GIF, WebP, AVIF, BMP, ICO and SVG.
- Images must be committed to the repository. Images from other websites are not shown, and the sync reports them.
- An image is served under the access rules of the folder it is in, not those of the page that shows it.
- Files above the instance's size limit (10 MB by default) are left out with a warning.

To set an image's size, write it as HTML: `<img src="./img/logo.png" alt="Logo" width="120">`.

## Code blocks

Name the language after the opening fence to highlight the code:

````md
```ts
const answer = 42;
```
````

Highlighted languages are Bash, C, C++, C#, CSS, Dart, Diff, Dockerfile, Elixir, Go, GraphQL, HTTP, INI, Java, JavaScript, JSON, Kotlin, Less, Lua, Makefile, Markdown, nginx, Objective-C, Perl, PHP, PowerShell, Protobuf, Python, R, Ruby, Rust, Scala, SCSS, Shell, SQL, Swift, TypeScript, VB.NET, WebAssembly, XML/HTML and YAML, including their common short names such as `ts`, `js`, `sh` and `yml`. A block in any other language, or a block over 100 KB, is shown without highlighting.

## Callouts

```md
:::note
This page is updated with every release.
:::

:::tip[Faster syncs]
Install the GitHub App to sync on every push.
:::

:::caution Read this first
This deletes the stored content.
:::
```

The types are `note`, `info`, `tip`, `important`, `warning`, `caution` and `danger`. `caution` looks the same as `warning`. Give a title in brackets or after a space. A `:::` block with any other name is shown as plain text.

GitHub's alert syntax works too:

```md
> [!NOTE]
> Speicher reads this as a note.
```

Here the types are `NOTE`, `TIP`, `IMPORTANT`, `WARNING` and `CAUTION`. Following GitHub, `CAUTION` looks the same as `danger`.

## Tables, task lists and footnotes

```md
| Setting | Default |
| :------ | ------: |
| Port    |    3000 |

- [x] Write the page
- [ ] Review it

Speicher reads Markdown.[^1]

[^1]: CommonMark, with the GitHub additions.
```

- Column alignment from the separator row is kept.
- Task lists show their state but cannot be ticked on the page.
- Footnotes are collected at the end of the page, with links back to where they are used.
- `~~strikethrough~~` and bare web addresses, which become links, work as on GitHub.

## HTML

You can mix HTML into Markdown. Speicher keeps text formatting and structure, such as `<details>`/`<summary>`, `<kbd>`, `<mark>`, `<sub>`, `<sup>`, `<abbr>`, `<dl>`, tables and `<img>`.

It removes everything that could run code or change the page's layout: `<script>`, `<style>`, `<iframe>`, `<object>`, forms, `style` attributes, event handlers such as `onclick`, and `javascript:` links. Classes are removed too, except the ones Speicher uses itself.

## MDX components

In `.mdx` files you can use the following components. The names and attributes are the same as in Starlight, and `Tabs`/`TabItem` as in Docusaurus.

| Component    | Attributes                                                        | Shows                                                           |
| ------------ | ----------------------------------------------------------------- | --------------------------------------------------------------- |
| `Tabs`       | `syncKey` (optional)                                              | a group of tabs; groups with the same `syncKey` switch together |
| `TabItem`    | `label`                                                           | one tab                                                         |
| `Steps`      |                                                                   | a numbered list as a sequence of steps                          |
| `FileTree`   |                                                                   | a nested list as a file tree                                    |
| `CardGrid`   |                                                                   | a grid of the cards inside it                                   |
| `Card`       | `title`                                                           | a card with Markdown content                                    |
| `LinkCard`   | `title`, `href`, `description` (optional)                         | a card that links somewhere                                     |
| `Aside`      | `type` (`note`, `tip`, `caution`, `danger`, …), `title`           | a callout, like `:::note`                                       |
| `Badge`      | `text`, `variant` (`note`, `tip`, `caution`, `danger`, `success`) | a small label, also inside a sentence                           |
| `LinkButton` | `href`                                                            | a link styled as a button                                       |
| `Code`       | `code`, `lang`                                                    | a code block                                                    |

````mdx
<Tabs syncKey="package-manager">
<TabItem label="npm">

```sh
npm install speicher-client
```

</TabItem>
<TabItem label="pnpm">

```sh
pnpm add speicher-client
```

</TabItem>
</Tabs>

<CardGrid>
<LinkCard title="Install" href="./01-install.mdx" description="Get it running" />
<Card title="Good to know">

Content of a card is **Markdown**.

</Card>
</CardGrid>

New in this release: <Badge text="Beta" variant="tip" />
````

Leave a blank line between a component's tags and Markdown content inside it, as in the example.

What Speicher does with the rest of MDX:

- `import` and `export` lines at the top of the file are ignored.
- An unknown component, such as a custom `<Chart>`, is left out, but the content between its tags is shown. The sync warns about it.
- JavaScript expressions such as `{props.version}` cannot run and are left out with a warning. Comments written as `{/* … */}` are left out silently.
- `Icon` is ignored, because it is decoration.
- Indented text is not a code block in `.mdx` files. Use a fenced block instead.

## Coming from Docusaurus or Starlight

You can point Speicher at an existing Docusaurus or Starlight `docs/` folder with `ingest_root` and keep writing as before:

- `sidebar_position` (Docusaurus) and `sidebar.order` (Starlight) in the frontmatter set the order of pages. They are only used in folders where no file has a number prefix. If a folder mixes both, the prefixes win and the sync warns.
- `:::note`-style admonitions and Starlight's components work as described above.
- Other frontmatter keys, such as `sidebar_label` or `slug`, are ignored with a warning, so your files don't need changes. The rest of Starlight's `sidebar` block is ignored without a warning.
