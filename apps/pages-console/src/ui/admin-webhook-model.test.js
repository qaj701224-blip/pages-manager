import assert from 'node:assert/strict';
import test from 'node:test';

import { getTemplateVariableWarnings, readTemplateVariablePaths } from './admin-webhook-model.js';

const events = [
  {
    type: 'site.deployed',
    label: '部署成功',
    requiredTemplateVariables: ['event.id', 'site.slug'],
    optionalTemplateVariables: ['team.name'],
  },
  {
    type: 'site.disabled',
    label: '站点停用',
    requiredTemplateVariables: ['event.id', 'site.slug', 'change.currentValue'],
    optionalTemplateVariables: ['team.name'],
  },
];

test('template variable reader follows nested JSON strings and deduplicates paths', () => {
  assert.deepEqual(readTemplateVariablePaths(JSON.stringify({ text: '{{event.id}} {{event.id}}', nested: ['{{site.slug}}'] })), [
    'event.id',
    'site.slug',
  ]);
});

test('template warnings identify optional variables per selected event', () => {
  assert.deepEqual(
    getTemplateVariableWarnings('{"text":"{{event.id}} {{team.name}}"}', ['site.deployed', 'site.disabled'], events),
    [
      {
        path: 'team.name',
        events: [
          { type: 'site.deployed', label: '部署成功' },
          { type: 'site.disabled', label: '站点停用' },
        ],
      },
    ]
  );
});

test('template warnings mark variables absent from an event descriptor', () => {
  assert.deepEqual(
    getTemplateVariableWarnings('{"value":"{{change.currentValue}}"}', ['site.deployed', 'site.disabled'], events),
    [
      {
        path: 'change.currentValue',
        events: [{ type: 'site.deployed', label: '部署成功' }],
      },
    ]
  );
});

test('invalid template JSON produces no availability warnings', () => {
  assert.deepEqual(getTemplateVariableWarnings('{', ['site.deployed'], events), []);
});
