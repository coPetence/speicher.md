import type { Document } from 'yaml';

import { brandValueKind } from '../../../config/brand';
import { dottedPath, loadDocument, serialise } from './document';
import { allFields } from './model';
import { buildSections } from './sections';

/** Shown in place of a stored literal secret. */
export const REDACTED = '** not shown **';

/**
 * Shown instead of Brand Images because the base64 or bytes are ususally quite long
 */
export const ELIDED = '** the logo, not shown **';

export function displayYaml(yaml: string): string {
  let doc;
  try {
    doc = loadDocument(yaml);
  } catch {
    // Unparseable: there are no fields to find, and the page says so instead.
    return yaml;
  }

  let redacted = false;
  for (const field of allFields(buildSections(doc))) {
    const hidden =
      (field.kind === 'secret' && field.secretHidden) ||
      (field.kind === 'file' && pathIsInlineImage(doc, field.path));
    if (!hidden) continue;
    doc.setIn(dottedPath(field.path), field.kind === 'file' ? ELIDED : REDACTED);
    redacted = true;
  }

  return redacted ? serialise(doc) : yaml;
}

function pathIsInlineImage(doc: Document, path: string): boolean {
  const stored = doc.getIn(dottedPath(path));
  return typeof stored === 'string' && brandValueKind(stored) === 'data';
}
