import type { AmountField } from './amount';
import type { BooleanField } from './boolean';
import type { CheckboxesField } from './checkboxes';
import type { ChoiceItem } from './choice';
import type { ColorField } from './color';
import type { CopyValueItem } from './copy-value';
import type { EmbeddingModelField } from './embedding-model';
import type { EntraTenantField } from './entra-tenant';
import type { FileField } from './file';
import type { GithubAppManifestItem } from './github-app-manifest';
import type { KnownHostsField } from './known-hosts';
import type { LinesField } from './lines';
import type { MembershipField } from './membership';
import type { MultilineField } from './multiline';
import type { NumberField } from './number';
import type { SecretField } from './secret';
import type { SelectField } from './select';
import type { TemplateField } from './template';
import type { TextField } from './text';
import type { UrlField } from './url';

export type Field =
  | TextField
  | UrlField
  | EmbeddingModelField
  | ColorField
  | EntraTenantField
  | NumberField
  | SecretField
  | BooleanField
  | MembershipField
  | SelectField
  | TemplateField
  | CheckboxesField
  | MultilineField
  | KnownHostsField
  | LinesField
  | FileField
  | AmountField;

export type FieldKind = Field['kind'];

// What a card holds: fields, and the items that store nothing themselves
export type CardItem = Field | ChoiceItem | CopyValueItem | GithubAppManifestItem;

// The field of one kind, e.g. `FieldOf<'secret'>` is `SecretField`
type WithKind<F, K> = F extends { kind: infer Kinds } ? (K extends Kinds ? F : never) : never;
export type FieldOf<K extends FieldKind> = WithKind<Field, K>;

export * from './amount';
export { at } from './base';
export type { FieldBase, Obj } from './base';
export * from './boolean';
export * from './checkboxes';
export * from './choice';
export * from './color';
export * from './copy-value';
export * from './embedding-model';
export * from './entra-tenant';
export * from './file';
export * from './github-app-manifest';
export * from './known-hosts';
export * from './lines';
export * from './membership';
export * from './multiline';
export * from './number';
export * from './secret';
export * from './select';
export * from './template';
export * from './text';
export * from './url';
