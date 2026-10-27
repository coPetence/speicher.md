import { problem } from '../../src/common/config-problems';
import { loadDocument } from '../../src/dashboard/configurator/config-form/document';
import { allFields } from '../../src/dashboard/configurator/config-form/model';
import { sectionOf } from '../../src/dashboard/configurator/config-form/sections';
import type { ConfigSectionPayload } from '../../src/dashboard/configurator/config-page/payloads';
import {
  fieldPathOf,
  stampProblems,
} from '../../src/dashboard/configurator/config-page/problem-stamp';

const YAML = `
version: 1
auth:
  providers:
    entra:
      type: oidc
      issuer: https://login.example.test/v2.0
      client_id: abc
admins:
  users:
    - { provider: entra, email: ada@example.test }
    - { provider: entra, email: zoe@example.test }
`;

const UNKNOWN = problem('admins.unknown-provider', 'admins.users[1].provider', {
  text: 'Provider "nope" is not configured.',
  dashboard: 'Administrator zoe@example.test uses unknown provider "nope".',
});

function payloadOf(sectionId: string): ConfigSectionPayload {
  return { section: sectionOf(loadDocument(YAML), sectionId)! } as ConfigSectionPayload;
}

describe('a refused save, put where it gets fixed', () => {
  it('reads a problem path the way the form spells its fields', () => {
    expect(fieldPathOf('admins.users[1].provider')).toBe('admins.users.1.provider');
    expect(fieldPathOf('forges.git.repos[0].url')).toBe('forges.git.repos.0.url');
  });

  it("marks the field on the member's own page, in the dashboard's wording", () => {
    const payload = payloadOf('admins/1');
    stampProblems(payload, [UNKNOWN]);

    const marked = allFields([payload.section!]).filter((f) => f.problems?.length);
    expect(marked.map((f) => f.path)).toEqual(['admins.users.1.provider']);
    expect(marked[0].problems).toEqual([
      { code: 'admins.unknown-provider', text: UNKNOWN.dashboard },
    ]);
  });

  it('marks the row on the index, and only that row', () => {
    const payload = payloadOf('admins');
    stampProblems(payload, [UNKNOWN]);

    const rows = payload.section!.entries;
    expect(rows.map((row) => row.problems?.map((p) => p.code) ?? [])).toEqual([
      [],
      ['admins.unknown-provider'],
    ]);
  });

  it('leaves a problem about the whole instance to the list at the top', () => {
    const payload = payloadOf('admins');
    stampProblems(payload, [problem('admins.none', null, { text: 'No administrator.' })]);

    expect(allFields([payload.section!]).some((f) => f.problems)).toBe(false);
    expect(payload.section!.entries.some((row) => row.problems)).toBe(false);
  });
});
