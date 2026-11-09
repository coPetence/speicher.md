import { ConfigService, RepoRef } from '../../config/config.service';
import type { CommitTree } from '../../forge/git';
import { FindingList } from '../findings';
import { DirectoryLookup } from '../grants';
import {
  IngestedAsset,
  IngestedDocument,
  IngestedEdge,
  IngestedFolder,
  IngestedTerm,
} from '../ingested';
import { AssetRegistry } from './assets';
import { resolveFolderCovers, resolveRepoCover } from './covers';
import { buildFolders } from './folders';
import { applyImportedOrdering } from './ordering';
import { renderPages } from './render';
import { loadRoot } from './root';
import { scanRepo } from './scan';

export interface WalkResult {
  documents: IngestedDocument[];
  folders: IngestedFolder[];
  assets: IngestedAsset[];
  edges: IngestedEdge[];
  terms: IngestedTerm[];
  findings: FindingList;
  failedSubtrees: string[];
  repo: {
    ingestRoot: string;
    displayTitle: string | null;
    maintainerPrincipals: string[];
    coverPath: string | null;
  };
  nextExpiry: Date | null;
}

export interface RepoLookup {
  resolve(segments: string[]): Promise<{ repoId: string; slugPath: string } | null>;
}

export interface WalkOptions {
  workingTree: string;
  config: ConfigService;
  repo: RepoRef;
  directory?: DirectoryLookup;
  repos?: RepoLookup;
  now?: Date;
  expiryWarningMs?: number;
  maxAssetBytes?: number;
  commit?: CommitTree;
}

export async function walkRepo(options: WalkOptions): Promise<WalkResult> {
  const findings = new FindingList();
  const root = await loadRoot(options, findings);

  if (root === null) return emptyResult(findings, ['']);

  const scan = await scanRepo(root);

  applyImportedOrdering(scan);

  const assets = new AssetRegistry(scan, options.commit);
  const covers = await resolveFolderCovers(scan, assets);
  const content = await renderPages(scan, assets, covers, options);
  const folders = buildFolders(scan, content.documents, covers);
  const repoCover = await resolveRepoCover(root, assets);

  return {
    documents: content.documents,
    folders,
    assets: assets.collected(),
    edges: content.edges,
    terms: content.terms,
    findings,
    failedSubtrees: scan.failedSubtrees,
    repo: {
      ingestRoot: root.ingestRoot,
      displayTitle: root.rootConfig.display?.title ?? null,
      maintainerPrincipals: root.maintainerPrincipals,
      coverPath: repoCover,
    },
    nextExpiry: scan.nextExpiry,
  };
}

function emptyResult(findings: FindingList, failedSubtrees: string[]): WalkResult {
  return {
    documents: [],
    folders: [],
    assets: [],
    edges: [],
    terms: [],
    findings,
    failedSubtrees,
    repo: { ingestRoot: '', displayTitle: null, maintainerPrincipals: [], coverPath: null },
    nextExpiry: null,
  };
}
