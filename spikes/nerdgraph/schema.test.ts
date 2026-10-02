// SPDX-License-Identifier: Apache-2.0
// Run: node --test spikes/nerdgraph/schema.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { autoArgs, type FullType, printType, Schema } from './schema.ts';

const nn = (t: object) => ({ kind: 'NON_NULL', name: null, ofType: t });
const named = (kind: string, name: string) => ({ kind, name });
const list = (t: object) => ({ kind: 'LIST', name: null, ofType: t });

const types: FullType[] = [
  {
    kind: 'OBJECT',
    name: 'Actor',
    fields: [
      {
        name: 'account',
        args: [{ name: 'id', type: nn(named('SCALAR', 'Int')) }],
        type: named('OBJECT', 'Account'),
      },
      { name: 'errorsInbox', args: [], type: named('OBJECT', 'ErrorsInbox') },
    ],
    inputFields: null,
  },
  {
    kind: 'OBJECT',
    name: 'Account',
    fields: [
      { name: 'id', args: [], type: nn(named('SCALAR', 'Int')) },
      { name: 'name', args: [], type: named('SCALAR', 'String') },
      {
        name: 'nrql',
        args: [{ name: 'query', type: nn(named('SCALAR', 'Nrql')) }],
        type: named('OBJECT', 'NrdbResultContainer'),
      },
    ],
    inputFields: null,
  },
  {
    kind: 'OBJECT',
    name: 'NrdbResultContainer',
    fields: [{ name: 'results', args: [], type: named('SCALAR', 'NrdbResult') }],
    inputFields: null,
  },
  {
    kind: 'OBJECT',
    name: 'ErrorsInbox',
    fields: [
      {
        name: 'errorGroups',
        args: [
          { name: 'filter', type: named('INPUT_OBJECT', 'EgFilter') },
          { name: 'cursor', type: named('SCALAR', 'String') },
        ],
        type: named('OBJECT', 'NrdbResultContainer'),
      },
    ],
    inputFields: null,
  },
  {
    kind: 'INPUT_OBJECT',
    name: 'EgFilter',
    fields: null,
    inputFields: [
      { name: 'entityGuids', type: list(nn(named('SCALAR', 'EntityGuid'))) },
      { name: 'timeWindow', type: named('INPUT_OBJECT', 'TimeWindow') },
    ],
  },
  {
    kind: 'INPUT_OBJECT',
    name: 'TimeWindow',
    fields: null,
    inputFields: [
      { name: 'startTime', type: named('SCALAR', 'EpochMilliseconds') },
      { name: 'endTime', type: named('SCALAR', 'EpochMilliseconds') },
    ],
  },
  { kind: 'SCALAR', name: 'Int', fields: null, inputFields: null },
  { kind: 'SCALAR', name: 'String', fields: null, inputFields: null },
  { kind: 'SCALAR', name: 'Nrql', fields: null, inputFields: null },
  { kind: 'SCALAR', name: 'NrdbResult', fields: null, inputFields: null },
];

test('printType and argType', () => {
  const s = new Schema(types);
  assert.equal(s.argType('Actor', 'account', 'id'), 'Int!');
  assert.equal(s.argType('Actor', 'account.nrql', 'query'), 'Nrql!');
  assert.equal(printType(list(nn(named('SCALAR', 'EntityGuid'))) as never), '[EntityGuid!]');
});

test('selection skips fields with required args and recurses into objects', () => {
  const s = new Schema(types);
  assert.equal(s.selection('Account', 1), '__typename id name');
  assert.equal(s.selection('ErrorsInbox', 1), '__typename errorGroups { __typename results }');
});

test('autoArgs fills nested filter inputs from context', () => {
  const s = new Schema(types);
  const f = s.field('ErrorsInbox', 'errorGroups');
  assert.ok(f);
  const a = autoArgs(s, f, { accountId: 1, entityGuid: 'G', startTimeMs: 10, endTimeMs: 20 }, 'eg');
  assert.equal(a.argText, '(filter: $eg_filter)');
  assert.deepEqual(a.varDefs, ['$eg_filter: EgFilter']);
  assert.deepEqual(a.values, {
    eg_filter: { entityGuids: ['G'], timeWindow: { startTime: 10, endTime: 20 } },
  });
});
