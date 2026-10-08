import { dottedPath, loadDocument, serialise } from './document';
import { allFields } from './model';
import { buildSections } from './sections';

/** Shown in place of a stored literal secret. */
export const REDACTED = '** not shown **';

/**
 * Shown in place of a logo.
 *
 * Not secrecy — it is a picture of the instance's own name, and the header prints
 * it. It is *length*: 64 KB of base64 on one line would bury the document this view
 * exists to make readable, in the one place an operator goes to check what a save
 * will store.
 */
export const ELIDED = '** the logo, not shown **';

/**
 * The document as it can safely be displayed.
 *
 * The page offers a read-only view of the file the settings produce, which is worth
 * having — it is what gets stored, diffed and rolled back, and seeing it is the
 * difference between trusting the form and hoping. But the document holds secrets
 * for anyone who wrote one in literally rather than referencing the environment,
 * and the form goes to some trouble not to render those. Printing the same value
 * two elements further down the page would undo all of it.
 *
 * Every field the form treats as a hidden secret is replaced here, and nowhere
 * else: what is *saved* is always the real document. An environment reference is
 * left alone, because it is the name of a secret rather than one.
 */
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
      (field.kind === 'file' && field.stored !== '');
    if (!hidden) continue;
    doc.setIn(dottedPath(field.path), field.kind === 'file' ? ELIDED : REDACTED);
    redacted = true;
  }

  return redacted ? serialise(doc) : yaml;
}
