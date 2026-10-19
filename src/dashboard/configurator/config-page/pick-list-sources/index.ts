import type { PickListNote } from '../../config-form/config-fields';
import { repositories } from './repositories';

export interface PickListItem {
  value: string;
  label: string;
  note: PickListNote;
}

export interface PickListProvider {
  items(tenantId: string): Promise<PickListItem[]>;
  keyOf(value: string): string;
  unknown: PickListNote;
}

export const PICK_LIST_SOURCES: Record<string, PickListProvider | undefined> = {
  repositories,
};
