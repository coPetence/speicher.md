import { FindingList } from '../findings';
import { PageLinks } from './link-resolution';
import { ScannedFile } from './state';

export function reportLinkFindings(
  findings: FindingList,
  file: ScannedFile,
  links: PageLinks,
  rendered: { brokenLinks: string[]; blockedImages: string[] },
): void {
  const explained = new Set([...links.badAddress.keys(), ...links.crossRepoAssets]);
  for (const target of new Set([...links.broken, ...rendered.brokenLinks])) {
    if (explained.has(target)) continue;
    findings.warn({
      code: 'broken-link',
      source: file.sourcePath,
      message: `broken internal link "${target}"`,
    });
  }
  for (const url of rendered.blockedImages) {
    findings.warn({
      code: 'broken-link',
      source: file.sourcePath,
      message: `external image "${url}" was blocked. commit the image to the repo instead.`,
    });
  }
  for (const [target, reason] of links.badAddress) {
    findings.warn({
      code: 'cross-repo-unresolved',
      source: file.sourcePath,
      message: `cross-repository link "${target}" does not resolve: ${reason}`,
    });
  }
  for (const target of new Set(links.crossRepoAssets)) {
    findings.warn({
      code: 'cross-repo-asset',
      source: file.sourcePath,
      message: `"${target}" embeds a file from another repository, which is not served. Commit the file here, or link to the page.`,
    });
  }
  for (const target of new Set(links.embeds)) {
    findings.warn({
      code: 'wikilink-embed',
      source: file.sourcePath,
      message:
        `"${target}" embeds a page. Transclusion is not availiable yet, so it renders as a ` +
        'link to that page.',
    });
  }
  for (const [name, candidates] of links.ambiguous) {
    findings.warn({
      code: 'ambiguous-wikilink',
      source: file.sourcePath,
      message:
        `"[[${name}]]" names ${candidates.length} files in this repository, and ` +
        `resolves to ${candidates[0]}. Write a path to say which you meant.`,
      adminMessage: `[[${name}]] in ${file.sourcePath} matches: ${candidates.join(', ')}`,
    });
  }
  for (const [target, losing] of links.narrower) {
    findings.warn({
      code: 'link-narrower-target',
      source: file.sourcePath,
      message:
        `"${target}" is readable by fewer people than this page, so the link will 404 ` +
        `for ${losing.length} of the principal(s) who can read this one.`,
      adminMessage:
        `"${target}" from ${file.sourcePath}: readable by fewer principals than the ` +
        `linking page. Losing access: ${losing.join(', ')}`,
    });
  }
}
