import { createPrivateKey } from 'node:crypto';

import type { Request, Response } from 'express';
import multer, { MulterError } from 'multer';

import type { BrandImage } from '../../../config/brand';
import {
  BRAND_IMAGES,
  MAX_BRAND_IMAGE_BYTES,
  describeBytes,
  parseBrandImage,
  sniffMediaType,
} from '../../../config/brand';
import { normalizePem } from '../../../github/tokens';

import type { Field } from './config-fields';

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
  limits: { fileSize: MAX_BRAND_IMAGE_BYTES, files: 6, fieldNameSize: 256 },
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
        refusal: `That file is larger than ${describeBytes(MAX_BRAND_IMAGE_BYTES)}. Use a smaller image instead.`,
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

export type InternImage = (image: BrandImage) => Promise<string>;

/**
 * Handles the uploaded files
 * Stores brand images in database
 */
export async function fillUploads(
  fields: Field[],
  uploads: Uploads,
  body: Record<string, unknown>,
  intern: InternImage,
): Promise<string | null> {
  for (const [name, bytes] of uploads.parts) {
    const derived = name.startsWith(UPLOAD_PREFIX);
    const path = derived ? name.slice(UPLOAD_PREFIX.length) : name;
    const field = fields.find((each) => each.path === path);
    if (!field) continue;

    if (!derived) {
      if (field.kind !== 'file') continue;
      const mediaType = sniffMediaType(bytes);
      if (!mediaType) {
        return 'That file is not a JPEG, a PNG, a WebP or an SVG';
      }
      const accepted = field.accept === '' ? [] : field.accept.split(',');
      if (accepted.length > 0 && !accepted.includes(mediaType)) {
        return (
          `That file is ${nameOfType(mediaType)}, and the ${field.label.toLowerCase()} may be ` +
          `${listTypes(accepted)}.`
        );
      }

      const value = `data:${mediaType};base64,${bytes.toString('base64')}`;
      const spec = BRAND_IMAGES.find((each) => each.key === field.path);
      if (!spec) {
        body[field.path] = value;
        continue;
      }

      const { image, problem } = parseBrandImage(value, spec);
      if (!image) return problem;

      body[field.path] = await intern(image);
      continue;
    }

    if (field.kind !== 'secret' || !field.upload) continue;
    const read =
      field.upload.content === 'ssh-private-key' ? readSshPrivateKey(bytes) : readPrivateKey(bytes);
    if (read.refusal !== null) return read.refusal;
    body[field.path] = read.value;
  }
  return null;
}

function nameOfType(mediaType: string): string {
  const names: Record<string, string> = {
    'image/jpeg': 'a JPEG',
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

const OPENSSH_KEY =
  /-----BEGIN OPENSSH PRIVATE KEY-----([\s\S]*?)-----END OPENSSH PRIVATE KEY-----/;

const SSH_PASSPHRASE_REFUSAL =
  'That key is protected by a passphrase, and speicher.md can only use keys without passphrases. To remove the passphrase, run `ssh-keygen -p -f <file>` and leave the new passphrase empty.';

/**
 * Reads a private SSH key, such as a deploy key created with `ssh-keygen`, refusing
 * a public key, a key protected by a passphrase and anything that is no key
 *
 * @param bytes the uploaded file
 */
function readSshPrivateKey(bytes: Buffer): { value: string; refusal: null } | { refusal: string } {
  const text = bytes.toString('utf8');

  if (isBinary(text)) {
    return {
      refusal:
        'The chosen file is not a private SSH key, because it is not a text file. Choose the private key file that `ssh-keygen` created, for example `speicher-deploy-key`.',
    };
  }

  if (/^\s*(ssh|ecdsa|sk)-\S+\s+AAAA/.test(text)) {
    return {
      refusal:
        'The chosen file is a public key, but the deploy key field needs the private key. Choose the file with the same name without `.pub`, for example `speicher-deploy-key` instead of `speicher-deploy-key.pub`.',
    };
  }

  // The OpenSSH format names the cipher that protects the key after a fixed magic
  // string; `none` means there is no passphrase
  const openssh = OPENSSH_KEY.exec(text);
  if (openssh) {
    const blob = Buffer.from(openssh[1].replace(/\s+/g, ''), 'base64');
    const magic = 'openssh-key-v1\0';
    if (
      blob.subarray(0, magic.length).toString('latin1') !== magic ||
      blob.length < magic.length + 4
    ) {
      return {
        refusal:
          'The chosen file starts like a private SSH key, but its content is damaged, so speicher.md cannot read it. Choose the original file that `ssh-keygen` created, or create a new key.',
      };
    }
    const length = blob.readUInt32BE(magic.length);
    const cipher = blob.subarray(magic.length + 4, magic.length + 4 + length).toString('latin1');
    if (cipher !== 'none') return { refusal: SSH_PASSPHRASE_REFUSAL };
    return { value: text, refusal: null };
  }

  // Older keys are PEM files, which ssh reads as well
  if (text.includes('ENCRYPTED')) return { refusal: SSH_PASSPHRASE_REFUSAL };
  try {
    createPrivateKey(normalizePem(text));
  } catch {
    return {
      refusal:
        'The chosen file is not a private SSH key. Choose the private key file that `ssh-keygen` created, for example `speicher-deploy-key`. Its first line is “-----BEGIN OPENSSH PRIVATE KEY-----”.',
    };
  }
  return { value: text, refusal: null };
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
