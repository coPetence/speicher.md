/**
 * Quick setup: a kind of member that the add modal sets up in one go, without
 * the member's page. The modal posts to `quickSetupPath`
 *
 * The modal asks the few fields the setup needs, and the setup either hands the
 * browser over to an outside service (a GitHub App created from a manifest) or
 * saves the member straight away. Either way the browser lands on the member's
 * ready page, which lists what was done and what to do next
 */

import type { Option } from '../config-form/model';
import type { ManifestTarget } from '../config-page/github-app-manifest';

/** A field of a quick setup, submitted as `quick:<kind>:<name>` */
export type QuickField =
  | {
      kind: 'choice';
      name: string;
      label: string;
      help?: string;
      options: Option[];
      // A switch of a few short options side by side, a list of radio buttons for longer ones, or a dropdown
      layout: 'switch' | 'list' | 'dropdown';
    }
  | {
      kind: 'text';
      name: string;
      label: string;
      help?: string;
      placeholder?: string;
      shownWhen?: ShownWhen;
    };

// Shown only while the choice named `field` of the same setup has one of `values` picked
export interface ShownWhen {
  field: string;
  values: string[];
}

/** What the add modal shows for a kind that has a quick setup */
export interface QuickSetup {
  // The label of the modal's main button, e.g. `Continue on GitHub`
  submitLabel: string;
  // Whether the main button takes the browser to another site, which its icon then says
  leavesSite?: boolean;
  fields: QuickField[];
}

/** What a quick setup asks the controller to do */
export type QuickStart =
  | { kind: 'github-app'; target: ManifestTarget; owner: string; public: boolean }
  | { kind: 'save' }
  | { kind: 'refused'; message: string; field?: string };

/** One line of a ready page */
export interface ReadyStep {
  state: 'done' | 'next' | 'optional';
  // Markdown
  text: string;
  // A link the step leads to…
  href?: string;
  // …or a form the step posts, e.g. the start of another App's manifest flow
  action?: { url: string; fields: Record<string, string> };
  // The label of the link or button
  label?: string;
  // Whether a link through this instance ends on another site, which its icon then says
  external?: boolean;
  // A link inside the text, where it says `{link}`
  inline?: { text: string; href: string };
}

/** What a ready page is built from */
export interface ReadyContext {
  section: string;
  id: string;
  // The member as stored
  member: Record<string, unknown>;
  // The query the browser came back with, e.g. GitHub's `setup_action`
  query: Record<string, string>;
  // Reaches outside services, e.g. GitHub to look up a source's App
  fetchImpl: typeof fetch;
}

export interface QuickStarter {
  setup: QuickSetup;
  /**
   * start decides what to do with a submitted quick setup.
   *
   * @param id the short id of the new member
   * @param input the setup's fields, by their unqualified names
   */
  start(id: string, input: Record<string, string>): QuickStart;
  /** ready lists what was done and what to do next, for the member's ready page */
  ready(context: ReadyContext): Promise<ReadyResult> | ReadyResult;
}

/** What a ready modal lists, and where it leads on to when the setup goes on in another modal */
export interface ReadyResult {
  steps: ReadyStep[];
  onward?: { label: string; href: string };
}

/** The form name of a quick setup's field */
export function quickFieldName(kind: string, name: string): string {
  return `quick:${kind}:${name}`;
}

/** The path the add modal posts a quick setup to */
export function quickSetupPath(section: string): string {
  return `/-/config/${section}/-/create`;
}
