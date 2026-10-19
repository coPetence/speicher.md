import type { PickListField } from '../config-form/config-fields';
import { allFields } from '../config-form/model';
import type { ConfigSectionPayload } from './payloads';
import { PICK_LIST_SOURCES } from './pick-list-sources';

export async function stampPickListOptions(
  tenantId: string,
  payload: ConfigSectionPayload,
): Promise<void> {
  if (!payload.section) return;
  const fields = allFields([payload.section]).filter(
    (field): field is PickListField => field.kind === 'pick-list',
  );

  for (const field of fields) {
    const provider = PICK_LIST_SOURCES[field.source];
    if (!provider) {
      throw new Error(`The pick list ${field.path} names the unknown source "${field.source}".`);
    }
    const known = new Map((await provider.items(tenantId)).map((item) => [item.value, item]));
    const listed = new Set(field.values.map((value) => provider.keyOf(value)));
    field.options = [...known.values()].filter((item) => !listed.has(item.value));
    field.entries = field.values.map((value) => {
      const item = known.get(provider.keyOf(value));
      return { value, note: item ? item.note : provider.unknown, offered: item !== undefined };
    });
  }
}
