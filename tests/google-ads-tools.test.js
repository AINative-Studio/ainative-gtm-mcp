// Unit tests for the ainative-gtm google-ads tools — validates tool definitions
// and input schemas without hitting the live Google Ads API. Refs #5244
import { test } from 'node:test';
import assert from 'node:assert';
import { googleAdsTools } from '../build/tools/google-ads.js';

const byName = Object.fromEntries(googleAdsTools.map((t) => [t.name, t]));

test('new tools are registered', () => {
  for (const n of [
    'gads_remove_campaign_criterion',
    'gads_add_negative_placement',
    'gads_set_conversion_goal_inclusion',
  ]) {
    assert.ok(byName[n], `tool ${n} should be registered`);
    assert.equal(typeof byName[n].execute, 'function', `${n}.execute must be a function`);
    assert.ok(byName[n].description?.length > 20, `${n} needs a real description`);
  }
});

test('gads_remove_campaign_criterion schema requires campaignId + criterionId', () => {
  const s = byName['gads_remove_campaign_criterion'].inputSchema;
  assert.throws(() => s.parse({ criterionId: '2356' }), /campaignId/i);
  assert.doesNotThrow(() => s.parse({ campaignId: '1', criterionId: '2356' }));
});

test('gads_add_negative_placement schema requires campaignId + placementUrl', () => {
  const s = byName['gads_add_negative_placement'].inputSchema;
  assert.throws(() => s.parse({ campaignId: '1' }), /placementUrl/i);
  assert.doesNotThrow(() => s.parse({ campaignId: '1', placementUrl: 'qureka.com' }));
});

test('gads_set_conversion_goal_inclusion schema requires conversionActionId + biddable', () => {
  const s = byName['gads_set_conversion_goal_inclusion'].inputSchema;
  assert.throws(() => s.parse({ conversionActionId: '7662155462' }), /biddable/i);
  assert.doesNotThrow(() => s.parse({ conversionActionId: '7662155462', biddable: false }));
});

test('recommendation subscription tools are registered', () => {
  for (const n of ['gads_list_recommendation_subscriptions', 'gads_set_recommendation_subscription']) {
    assert.ok(byName[n], `tool ${n} should be registered`);
    assert.equal(typeof byName[n].execute, 'function');
  }
});

test('gads_set_recommendation_subscription requires enabled', () => {
  const s = byName['gads_set_recommendation_subscription'].inputSchema;
  assert.throws(() => s.parse({ all: true }), /enabled/i);
  assert.doesNotThrow(() => s.parse({ enabled: false, all: true }));
  assert.doesNotThrow(() => s.parse({ enabled: true, resourceName: 'customers/1/recommendationSubscriptions/KEYWORD' }));
});
