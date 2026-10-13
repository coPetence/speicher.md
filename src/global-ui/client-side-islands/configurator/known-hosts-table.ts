/**
 * Redraws the known hosts field while the known_hosts lines or the repository URLs
 * of its source are edited, and shows its card only while a repository URL is an SSH URL
 */
import { sshRemoteUrl } from '../../../forge/remote-url';
import { missingHostKeysText, unreadableLinesText } from '../../known-hosts-notes';
import { setNoteText } from '../notes';
import { configForm } from './config-form-handle';

interface HostKey {
  host: string;
  type: string;
  fingerprint: string;
}

// A repository URL of a source, e.g. `forges.onprem.repos.0.url`; the first group is
// the source's path
const REPO_URL = /^(forges\.[^.]+)\.repos\.\d+\.url$/;

export function mountKnownHostsTables(): void {
  const form = configForm();
  if (!form) return;

  // Shows the card of the known hosts while a remote URL of its source is an SSH URL
  form.addEventListener('input', (event) => {
    const source = REPO_URL.exec((event.target as HTMLInputElement).name ?? '')?.[1];
    const area = source
      ? form.querySelector(`.spr-field-known-hosts textarea[name="${source}.known_hosts"]`)
      : null;
    const card = area?.closest<HTMLElement>('.spr-card');
    if (!card) return;
    card.hidden = ![...form.querySelectorAll<HTMLInputElement>('input[name$=".url"]')].some(
      (input) =>
        REPO_URL.exec(input.name)?.[1] === source &&
        knownHostsNameOf(sshRemoteUrl(input.value)) !== null,
    );
  });

  if (!globalThis.crypto?.subtle) return;

  const tableEdits = new WeakMap<Element, number>();
  const missingEdits = new WeakMap<Element, number>();
  const latest = (edits: WeakMap<Element, number>, field: Element): (() => boolean) => {
    const edit = (edits.get(field) ?? 0) + 1;
    edits.set(field, edit);
    return () => edits.get(field) === edit;
  };

  form.addEventListener('input', (event) => {
    const control = event.target as HTMLInputElement | HTMLTextAreaElement;
    const source = REPO_URL.exec(control.name ?? '')?.[1];
    const area =
      control.tagName === 'TEXTAREA' && control.closest('.spr-field-known-hosts')
        ? (control as HTMLTextAreaElement)
        : source
          ? form.querySelector<HTMLTextAreaElement>(
              `.spr-field-known-hosts textarea[name="${source}.known_hosts"]`,
            )
          : null;
    const field = area?.closest('.spr-field-known-hosts');
    if (!area || !field) return;

    if (area === control) {
      const current = latest(tableEdits, field);
      void readKnownHosts(area.value).then(({ keys, unreadable }) => {
        if (current()) draw(field, keys, unreadable);
      });
    }
    const current = latest(missingEdits, field);
    void serversWithoutHostKey(form, area).then((missing) => {
      if (current()) drawMissing(field, missing);
    });
  });
}

function drawMissing(field: Element, missing: string[]): void {
  const note = field.querySelector<HTMLElement>('[data-spr-missing-hosts]');
  if (!note) return;
  setNoteText(note, missingHostKeysText(missing));
  note.hidden = missing.length === 0;
}

// The servers of the source's `ssh://` repository URLs that the lines in `area` hold
// no key for, named as they appear in `known_hosts`. None when the lines are a reference to
// an environment variable
async function serversWithoutHostKey(
  form: HTMLFormElement,
  area: HTMLTextAreaElement,
): Promise<string[]> {
  if (area.value.includes('${')) return [];
  const source = area.name.replace(/\.known_hosts$/, '');
  const names = new Set<string>();
  for (const input of form.querySelectorAll<HTMLInputElement>('input[name$=".url"]')) {
    const name =
      REPO_URL.exec(input.name)?.[1] === source
        ? knownHostsNameOf(sshRemoteUrl(input.value))
        : null;
    if (name) names.add(name);
  }
  const missing: string[] = [];
  for (const name of names) {
    if (!(await knowsHost(area.value, name))) missing.push(name);
  }
  return missing;
}

// The server of an `ssh://` URL named as it appears in `known_hosts`: the host alone on port
// 22, else `[host]:port`. Null for any other URL
function knownHostsNameOf(url: string): string | null {
  const match = /^ssh:\/\/(?:[^@/]*@)?(\[[^\]]+\]|[^:/[\]]+)(?::(\d+))?(?:\/|$)/.exec(url.trim());
  if (!match) return null;
  const host = match[1].replace(/^\[|\]$/g, '');
  if (!/^[A-Za-z0-9][A-Za-z0-9.:-]*$/.test(host)) return null;
  const port = match[2] ? Number(match[2]) : 22;
  return port === 22 ? host : `[${host}]:${port}`;
}

// Whether `text` holds a readable, unrevoked key for the server `name`, the way
// `knowsHost` in src/forge/host-keys.ts decides it
async function knowsHost(text: string, name: string): Promise<boolean> {
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const parts = trimmed.split(/\s+/);
    if (parts[0] === '@revoked') continue;
    if (parts[0]?.startsWith('@')) parts.shift();
    const [hosts, type, key] = parts;
    if (!hosts || !type || !key || !decodeKey(type, key)) continue;
    let excluded = false;
    let named = false;
    for (const pattern of hosts.split(',')) {
      if (pattern.startsWith('!')) excluded ||= await matchesHost(pattern.slice(1), name);
      else named ||= await matchesHost(pattern, name);
    }
    if (named && !excluded) return true;
  }
  return false;
}

// Whether one entry of a line's server list names `name`: a hashed name
// `|1|<salt>|<hash>`, or a name or pattern compared without regard to case
async function matchesHost(pattern: string, name: string): Promise<boolean> {
  if (pattern.startsWith('!')) return false;
  if (pattern.startsWith('|1|')) {
    const [salt, hash] = pattern.slice('|1|'.length).split('|');
    if (!salt || !hash) return false;
    try {
      const secret = Uint8Array.from(atob(salt), (char) => char.charCodeAt(0));
      const hmac = { name: 'HMAC', hash: 'SHA-1' };
      const signer = await crypto.subtle.importKey('raw', secret, hmac, false, ['sign']);
      const signed = await crypto.subtle.sign('HMAC', signer, new TextEncoder().encode(name));
      return btoa(String.fromCharCode(...new Uint8Array(signed))) === hash;
    } catch {
      return false;
    }
  }
  const glob = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${glob}$`, 'i').test(name);
}

function draw(field: Element, keys: HostKey[], unreadable: number): void {
  const table = field.querySelector<HTMLTableElement>('.spr-host-keys');
  const empty = field.querySelector<HTMLElement>('.spr-host-keys-empty');
  const warning = field.querySelector<HTMLElement>('[data-spr-unreadable]');
  if (!table?.tBodies[0] || !empty || !warning) return;

  table.tBodies[0].replaceChildren(...keys.map(row));
  table.hidden = keys.length === 0;
  empty.hidden = keys.length > 0;

  setNoteText(warning, unreadableLinesText(unreadable));
  warning.hidden = unreadable === 0;
}

function row(key: HostKey): HTMLTableRowElement {
  const tr = document.createElement('tr');
  tr.append(cell(key.host, true), cell(key.type, false), cell(key.fingerprint, true));
  return tr;
}

function cell(text: string, asCode: boolean): HTMLTableCellElement {
  const td = document.createElement('td');
  if (asCode) {
    const code = document.createElement('code');
    code.textContent = text;
    td.append(code);
  } else {
    td.textContent = text;
  }
  return td;
}

async function readKnownHosts(text: string): Promise<{ keys: HostKey[]; unreadable: number }> {
  const keys: HostKey[] = [];
  let unreadable = 0;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const parts = trimmed.split(/\s+/);
    // A line may start with a marker such as `@cert-authority`
    if (parts[0]?.startsWith('@')) parts.shift();
    const [host, type, key] = parts;
    const blob = host && type && key ? decodeKey(type, key) : null;
    if (!host || !type || !blob) {
      unreadable += 1;
      continue;
    }
    keys.push({ host, type, fingerprint: await fingerprintOf(blob) });
  }
  return { keys, unreadable };
}

// The bytes of `base64Key` when it is a public key of `type`, else null. The
// decoded key starts with its type name, preceded by the name's length as a
// 4-byte number
function decodeKey(type: string, base64Key: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9+/]+=*$/.test(base64Key)) return null;
  let blob: Uint8Array<ArrayBuffer>;
  try {
    blob = Uint8Array.from(atob(base64Key), (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
  if (blob.length < 4) return null;
  const length = new DataView(blob.buffer).getUint32(0);
  const name = String.fromCharCode(...blob.subarray(4, 4 + length));
  return name === type ? blob : null;
}

// The fingerprint in the format `ssh-keygen -l` prints, e.g. `SHA256:+DiY3wv…`
async function fingerprintOf(blob: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', blob));
  return `SHA256:${btoa(String.fromCharCode(...digest)).replace(/=+$/, '')}`;
}
