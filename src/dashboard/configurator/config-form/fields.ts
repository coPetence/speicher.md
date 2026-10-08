/**
 * The config form's public face
 *
 * Every consumer imports from here; the form itself is five modules under it —
 * `model.ts` is the vocabulary, `field.ts` turns a path into a control,
 * `members.ts` says what a URL segment addresses, `sections/registry.ts` which
 * sections exist, and `sections/` builds them
 */

export * from './field';
export * from './members';
export * from './model';
export * from './sections';
export * from './sections/registry';
