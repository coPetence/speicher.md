import { ConfigService } from '../../config/config.service';
import { Frontmatter, SpeicherConfig } from '../../config/types';
import { ResolvedConfig, fold } from '../cascade';
import { FindingList } from '../findings';

export type GrantContext = Parameters<typeof fold>[2]['grantContext'];

export interface RepoRoot {
  workingTree: string;
  config: ConfigService;
  ingestRoot: string;
  ingestAbs: string;
  /** File name the root config was read from (`.speicher.yaml` or `.speicher.yml`) */
  configName: string;
  rootConfig: SpeicherConfig;
  resolved: ResolvedConfig;
  maintainerPrincipals: string[];
  grantContext: GrantContext;
  maxAssetBytes: number;
  findings: FindingList;
  lineOf: (key: string) => number | null;
}

export interface ScannedDir {
  sourcePath: string;
  /** Repo-relative path of the directory's config file, for reporting findings */
  configSource: string;
  resolved: ResolvedConfig;
  sortOrder: number | null;
}

export interface ScannedFile {
  sourcePath: string;
  slugPath: string;
  parentPath: string;
  isIndex: boolean;
  sortOrder: number | null;
  raw: string;
  body: string;
  frontmatter: Frontmatter;
  resolved: ResolvedConfig;
  folderTitle: string;
}

export interface ScanState {
  readonly root: RepoRoot;
  dirs: Map<string, ScannedDir>;
  files: ScannedFile[];
  failedSubtrees: string[];
  nextExpiry: Date | null;
}
