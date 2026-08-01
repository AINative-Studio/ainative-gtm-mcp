// #5444: add gads_set_campaign_status (enable capability the server lacked;
//        the google-ads MCP's update_campaign_status threw "_pb").
// #5445: gads_add_negative_placement must accept mobile-app placements
//        (mobileApplication criterion) and surface real errors, not "[object Object]".
import { test } from 'node:test';
import assert from 'node:assert';
import {
  googleAdsTools,
  gadsErrorMessage,
  isMobileAppPlacement,
  toAppId,
} from '../build/tools/google-ads.js';

const byName = Object.fromEntries(googleAdsTools.map((t) => [t.name, t]));

// ── #5444: enable/pause tool ────────────────────────────────────────────────
test('gads_set_campaign_status is registered with enable+pause', () => {
  const t = byName['gads_set_campaign_status'];
  assert.ok(t, 'gads_set_campaign_status must exist');
  assert.equal(typeof t.execute, 'function');
  assert.doesNotThrow(() => t.inputSchema.parse({ campaignId: '1', status: 'ENABLED' }));
  assert.doesNotThrow(() => t.inputSchema.parse({ campaignId: '1', status: 'PAUSED' }));
  assert.throws(() => t.inputSchema.parse({ campaignId: '1', status: 'BOGUS' }), /./);
  assert.throws(() => t.inputSchema.parse({ status: 'ENABLED' }), /campaignId/i);
});

// ── #5444/#5445: real error messages, never "_pb" / "[object Object]" ────────
test('gadsErrorMessage never returns _pb or [object Object]', () => {
  // a protobuf-ish failure whose .message is the useless "_pb"
  assert.equal(gadsErrorMessage({ message: '_pb', errors: [{ message: 'Campaign is removed.' }] }),
    'Campaign is removed.');
  // GoogleAdsFailure shape
  assert.equal(gadsErrorMessage({ errors: [{ message: 'Invalid app id format.' }] }),
    'Invalid app id format.');
  // plain object with no message → must not be "[object Object]"
  const s = gadsErrorMessage({ code: 3, detail: 'bad' });
  assert.notEqual(s, '[object Object]');
  assert.match(s, /bad|code/);
  assert.equal(gadsErrorMessage('just a string'), 'just a string');
  assert.equal(gadsErrorMessage(null), 'Unknown Google Ads error');
});

// ── #5445: mobile-app vs website detection ──────────────────────────────────
test('isMobileAppPlacement distinguishes apps from websites', () => {
  // apps (from the issue)
  assert.equal(isMobileAppPlacement('com.syct.chatbot.assistant'), true);
  assert.equal(isMobileAppPlacement('com.chatbot.ai.smart.talk.assistant'), true);
  assert.equal(isMobileAppPlacement('2-com.syct.chatbot.assistant'), true);
  assert.equal(isMobileAppPlacement('284882215'), true);   // iOS numeric store id
  assert.equal(isMobileAppPlacement('1-284882215'), true);
  // websites (must NOT be treated as apps)
  assert.equal(isMobileAppPlacement('qureka.com'), false);
  assert.equal(isMobileAppPlacement('omegleweb.io'), false);
  assert.equal(isMobileAppPlacement('https://qureka.com/path'), false);
  // multi-dot WEBSITE host (TLD last) must NOT be misread as an app
  assert.equal(isMobileAppPlacement('sub.example.co.uk'), false);
  assert.equal(isMobileAppPlacement('news.ycombinator.com'), false);
});

test('toAppId normalizes to the mobileApplication appId format', () => {
  assert.equal(toAppId('com.syct.chatbot.assistant'), '2-com.syct.chatbot.assistant');
  assert.equal(toAppId('2-com.syct.chatbot.assistant'), '2-com.syct.chatbot.assistant'); // idempotent
  assert.equal(toAppId('284882215'), '1-284882215');
  assert.equal(toAppId('1-284882215'), '1-284882215');
});

test('gads_add_negative_placement still validates its schema', () => {
  const s = byName['gads_add_negative_placement'].inputSchema;
  assert.throws(() => s.parse({ campaignId: '1' }), /placementUrl/i);
  assert.doesNotThrow(() => s.parse({ campaignId: '1', placementUrl: 'com.foo.bar' }));
});
