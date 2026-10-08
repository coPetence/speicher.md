/**
 * Asset storage, and semantic retrieval
 *
 * Two sections that each describe somewhere this instance talks to, and each
 * say whether it answers. The driver and the Azure identity both reshape the
 * form, so the questions below them are only offered once the document says
 * which one is in force
 */

import { isProduction } from '../../../../common/env';

import { scalarString } from '../document';
import { SECRET_HELP, at, field } from '../field';
import type { Obj } from '../field';
import type { Field, Option } from '../model';
import { sectionHead } from './registry';
import type { SectionSource } from './registry';

const AZURE_AUTH: Option[] = [
  { value: 'key', label: 'Account key' },
  { value: 'connection_string', label: 'Connection string' },
  { value: 'managed_identity', label: 'Managed identity (host)' },
  { value: 'workload_identity', label: 'Workload identity (AKS)' },
  { value: 'default', label: 'SDK default chain (development)' },
];

const AZURE_AUTH_DEFAULT = 'key';

function azureAuthOptions(stored: string): Option[] {
  return AZURE_AUTH.filter(
    (option) => option.value !== 'default' || stored === 'default' || !isProduction(),
  );
}

const ASSET_DRIVERS: Option[] = [
  { value: 'filesystem', label: 'Filesystem volume' },
  { value: 's3', label: 'S3-compatible' },
  { value: 'azure', label: 'Azure Blob Storage' },
];

export function storageSection(root: Obj): SectionSource {
  const driver = scalarString(at(root, ['assets', 'driver'])) || 'filesystem';
  const fields: Field[] = [
    field(root, ['assets', 'driver'], 'assets.driver', 'Asset storage', 'select', {
      options: ASSET_DRIVERS,
      fallback: 'filesystem',
      // Changing the driver rebuilds the entire form section
      reshapes: true,
      help: 'Specifies the storage medium for attachements. Metadata and access rules stay in the database on the instance. Attachments will only be fetched when the access check is successfull',
    }),
  ];

  if (driver === 's3') {
    fields.push(
      field(root, ['assets', 'bucket'], 'assets.bucket', 'Bucket', 'text'),
      field(root, ['assets', 'endpoint'], 'assets.endpoint', 'Endpoint', 'text', {
        help: 'For non-AWS providers such as Hetzner Object Storage or MinIO.',
      }),
      field(root, ['assets', 'region'], 'assets.region', 'Region', 'text'),
      field(root, ['assets', 'access_key_id'], 'assets.access_key_id', 'Access key id', 'text'),
      field(
        root,
        ['assets', 'secret_access_key'],
        'assets.secret_access_key',
        'Secret access key',
        'secret',
        {
          help: SECRET_HELP,
        },
      ),
    );
  } else if (driver === 'azure') {
    const auth = scalarString(at(root, ['assets', 'auth'])) || AZURE_AUTH_DEFAULT;
    fields.push(
      field(root, ['assets', 'account'], 'assets.account', 'Storage account', 'text'),
      field(root, ['assets', 'container'], 'assets.container', 'Container', 'text', {
        help:
          'This instance never creates it. A data-plane role cannot, so the ' +
          'container is made once, by whoever owns the account.',
      }),
      field(root, ['assets', 'auth'], 'assets.auth', 'How to authenticate', 'select', {
        options: azureAuthOptions(scalarString(at(root, ['assets', 'auth']))),
        fallback: AZURE_AUTH_DEFAULT,
        // Changing the auth method rebuilds the form
        reshapes: true,
        help:
          'The identity of a **host** and the federated token of an **AKS pod** are ' +
          'different mechanisms, so this names which rather than trying both — the ' +
          'wrong one fails as a timeout, which reads like a network fault.',
      }),
    );

    if (auth === 'connection_string') {
      fields.push(
        field(
          root,
          ['assets', 'connection_string'],
          'assets.connection_string',
          'Connection string',
          'secret',
          {
            help: SECRET_HELP,
          },
        ),
      );
    } else if (auth === 'key') {
      fields.push(
        field(root, ['assets', 'account_key'], 'assets.account_key', 'Account key', 'secret', {
          help:
            'A shared secret granting the whole account. A managed identity grants ' +
            'a role on one container instead, and cannot be copied out of the ' +
            'process. ' +
            SECRET_HELP,
        }),
      );
    } else {
      fields.push(
        field(root, ['assets', 'client_id'], 'assets.client_id', 'Identity client id', 'text', {
          help:
            'The user-assigned identity. Blank uses the system-assigned one — and ' +
            'under workload identity, whatever the cluster injected.',
        }),
      );
      if (auth === 'workload_identity') {
        fields.push(
          field(
            root,
            ['assets', 'tenant_id'],
            'assets.tenant_id',
            'Directory (tenant) id',
            'text',
            {
              help: "Only needed when the pod's environment does not already say.",
            },
          ),
        );
      }
    }

    fields.push(
      field(root, ['assets', 'endpoint'], 'assets.endpoint', 'Blob endpoint', 'text', {
        help:
          'Only for a sovereign cloud or a local emulator. The account URL, not the ' +
          "container's — the container is appended.",
      }),
    );
  } else {
    fields.push(
      field(root, ['assets', 'path'], 'assets.path', 'Volume path', 'text', {
        placeholder: './var/assets',
        help: 'A single replica, or a volume every replica can write.',
      }),
    );
  }

  fields.push(
    field(root, ['assets', 'max_asset_bytes'], 'assets.max_asset_bytes', 'Largest asset', 'bytes', {
      fallback: 10000000,
      help: 'Anything larger is reported to the author as a finding, and not stored.',
    }),
    field(
      root,
      ['assets', 'presign_over_bytes'],
      'assets.presign_over_bytes',
      'Pre-sign above',
      'bytes',
      {
        help: 'Zero proxies everything. Above this size the store is asked for a short-lived URL.',
      },
    ),
    field(
      root,
      ['assets', 'presign_ttl'],
      'assets.presign_ttl',
      'Pre-signed URL lifetime',
      'duration',
      {
        fallback: '60s',
      },
    ),
  );

  return {
    ...sectionHead('storage'),
    blurb:
      'Manage where images and attachments are stored. Find out more in our ' +
      '[documentation](https://docs.speicher.md/operate/storage)',
    fields,
    cards: [],
    addOps: [],
  };
}

export function embeddingSection(root: Obj): SectionSource {
  return {
    ...sectionHead('embedding'),
    blurb:
      'Optional, and not yet wired to a retriever. Any OpenAI-compatible ' +
      '/v1/embeddings endpoint. No completion model is ever called — agents write ' +
      'answers, this returns the chunks a caller is allowed to see.',
    fields: [
      field(root, ['embedding', 'base_url'], 'embedding.base_url', 'Endpoint', 'text', {
        placeholder: 'https://api.openai.com/v1',
      }),
      field(root, ['embedding', 'api_key'], 'embedding.api_key', 'API key', 'secret', {
        help: SECRET_HELP,
      }),
      field(root, ['embedding', 'model'], 'embedding.model', 'Model', 'text', {
        widthInto: 'embedding.dimensions',
      }),
      field(root, ['embedding', 'dimensions'], 'embedding.dimensions', 'Dimensions', 'number', {
        help:
          'Must match the pgvector column width. Checked by a probe at startup. Filled in ' +
          'from the endpoint when the model is entered, while this box is empty.',
      }),
      field(root, ['embedding', 'batch_size'], 'embedding.batch_size', 'Batch size', 'number', {
        fallback: 96,
      }),
      field(
        root,
        ['embedding', 'max_concurrency'],
        'embedding.max_concurrency',
        'Concurrent requests',
        'number',
        {
          fallback: 4,
        },
      ),
      field(
        root,
        ['embedding', 'send_dimensions'],
        'embedding.send_dimensions',
        'Send the dimensions parameter',
        'boolean',
        {
          fallback: true,
          help: 'Matryoshka-capable models accept it; others reject the request.',
        },
      ),
    ],
    cards: [],
    addOps: [],
  };
}
