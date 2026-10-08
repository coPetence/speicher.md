import { createPrivateKey } from 'node:crypto';

import type { Request, Response } from 'express';
import multer, { MulterError } from 'multer';

import { MAX_BRAND_LOGO_BYTES, describeBytes, sniffMediaType } from '../../../config/brand';
import { normalizePem } from '../../../forge/github/tokens';

import type { Field } from './model';

/**
 * Uploaded files for the config form
 *
 * Multipart fields become stored values: a brand image as a base64 `data:` URI,
 * the GitHub App key (field named with the `file:` prefix) as its PEM text
 *
 * The request is capped up front, but what is accepted is still sniffed,
 * because it is written into the stored configuration
 *
 * An unacceptable upload comes back as a `refusal` shown to the operator,
 * never as a thrown error, so the rest of their edits survive
 */

/** Prefix marking a field whose upload is stored as literal bytes, not a `data:` URI */
export const UPLOAD_PREFIX = 'file:';

/**
 * Parser that swallows every multipart field, since the form has no other
 * file inputs
 */
const parse = multer({
  /*
    fileSize is the largest cap any one field has, which is the logo's — a field
    with a smaller one of its own refuses on the way into the document, where the
    refusal can say which field and what its limit is. Six files let all three
    brand images and the keys share a post.
  */
  limits: { fileSize: MAX_BRAND_LOGO_BYTES, files: 6, fieldNameSize: 256 },
}).any();

/** Uploaded files from a config submission, and why reading them was refused */
export interface Uploads {
  parts: Map<string, Buffer>;
  refusal: string | null;
}

const NOTHING: Uploads = { parts: new Map(), refusal: null };

/**
 * Parses a config-form submission into one entry per picked file, unless the
 * request was not multipart
 */
export async function readUploads(req: Request, res: Response): Promise<Uploads> {
  if (!req.is('multipart/form-data')) return NOTHING;

  // multer reports completion through a callback, awaited so an error is a value
  const error = await new Promise<unknown>((resolve) => {
    parse(req, res, resolve);
  });

  if (error instanceof MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE') {
      return {
        parts: new Map(),
        refusal: `That file is larger than ${describeBytes(MAX_BRAND_LOGO_BYTES)}, which is the limit — every saved version of this configuration carries a copy of what is uploaded here.`,
      };
    }
    return { parts: new Map(), refusal: `The upload was refused: ${error.message}.` };
  }
  if (error) throw error;

  const parts = new Map<string, Buffer>();
  for (const file of (req.files as Express.Multer.File[] | undefined) ?? []) {
    // An untouched picker submits an empty part; skip it so it cannot clear a stored value
    if (file.size === 0 || file.originalname === '') continue;
    parts.set(file.fieldname, file.buffer);
  }
  return { parts, refusal: null };
}

/**
 * Writes each accepted part into `body` as the stored value for its field,
 * returning the first refusal encountered
 */
export function fillUploads(
  fields: Field[],
  uploads: Uploads,
  body: Record<string, unknown>,
): string | null {
  for (const [name, bytes] of uploads.parts) {
    // A field named with the prefix stores its file bytes; any other names the logo
    const derived = name.startsWith(UPLOAD_PREFIX);
    const path = derived ? name.slice(UPLOAD_PREFIX.length) : name;
    const field = fields.find((each) => each.path === path);
    if (!field) continue;

    if (!derived) {
      if (field.kind !== 'file') continue;
      // Sniff the bytes so a claim about the type can catch a file with a lying name
      const mediaType = sniffMediaType(bytes);
      if (!mediaType) {
        return 'That file is not a PNG, a WebP or an SVG';
      }
      // What this particular field accepts, which is not what every one of them does
      const accepted = field.accept === '' ? [] : field.accept.split(',');
      if (accepted.length > 0 && !accepted.includes(mediaType)) {
        return (
          `That file is ${nameOfType(mediaType)}, and the ${field.label.toLowerCase()} may be ` +
          `${listTypes(accepted)}.`
        );
      }
      body[field.path] = `data:${mediaType};base64,${bytes.toString('base64')}`;
      continue;
    }

    if (!field.upload) continue;
    const read = readPrivateKey(bytes);
    if (read.refusal !== null) return read.refusal;
    body[field.path] = read.value;
  }
  return null;
}

function nameOfType(mediaType: string): string {
  const names: Record<string, string> = {
    'image/png': 'a PNG',
    'image/webp': 'a WebP',
    'image/svg+xml': 'an SVG',
  };
  return names[mediaType] ?? mediaType;
}

/** "a PNG or an SVG" */
function listTypes(mediaTypes: string[]): string {
  const names = mediaTypes.map(nameOfType);
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`;
}

/** True when bytes hold a NUL or replacement character, which marks binary content */
function isBinary(text: string): boolean {
  return text.includes('\u0000') || text.includes('\uFFFD');
}

/** Reads a GitHub App's PEM private key, refusing anything not an unencrypted RSA key */
function readPrivateKey(bytes: Buffer): { value: string; refusal: null } | { refusal: string } {
  const text = bytes.toString('utf8');

  if (isBinary(text)) {
    return { refusal: 'That file is not text. A GitHub App’s key is a PEM file, which is.' };
  }

  if (text.includes('-----BEGIN ENCRYPTED PRIVATE KEY-----')) {
    return {
      refusal:
        'That key is protected by a passphrase, and there is nowhere here to put one. Decrypt it first.',
    };
  }

  let type: string | undefined;
  try {
    type = createPrivateKey(normalizePem(text)).asymmetricKeyType;
  } catch {
    return {
      refusal:
        'That file does not hold a private key. GitHub gives you one when you generate it, as a .pem beginning “-----BEGIN RSA PRIVATE KEY-----”.',
    };
  }
  if (type !== 'rsa') {
    return {
      refusal: `That is ${type ? `an ${type.toUpperCase()}` : 'another kind of'} key, and a GitHub App signs with RSA.`,
    };
  }

  return { value: text, refusal: null };
}
