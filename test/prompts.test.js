import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSystemPrompt, detectReplyLanguage } from '../src/agent/prompts.js';

test('detectReplyLanguage: Thai script → Thai', () => {
  assert.equal(detectReplyLanguage('นาข้าวแปลง 3 ต้องสูบน้ำไหม'), 'Thai');
});

test('detectReplyLanguage: English → English', () => {
  assert.equal(detectReplyLanguage('How is the sugarcane doing?'), 'English');
});

test('detectReplyLanguage: mixed Thai + English → Thai', () => {
  assert.equal(detectReplyLanguage('ระดับน้ำ paddy 3 เท่าไหร่'), 'Thai');
});

test('detectReplyLanguage: ambiguous input → null', () => {
  assert.equal(detectReplyLanguage('123 456'), null);
  assert.equal(detectReplyLanguage(''), null);
  assert.equal(detectReplyLanguage(null), null);
});

test('detectReplyLanguage: sensor alerts → null (profile hint decides)', () => {
  assert.equal(detectReplyLanguage('[SENSOR ALERT] Paddy p3 water_level = -16cm'), null);
});

test('buildSystemPrompt embeds a hard language directive when detected', () => {
  const prompt = buildSystemPrompt({
    memoryText: '',
    farmOverview: '',
    nalogMode: 'demo',
    language: 'th',
    activeFarmId: null,
    replyLanguage: 'English',
  });
  assert.match(prompt, /ENTIRE reply in English/);
  assert.doesNotMatch(prompt, /language hint/);
});

test('buildSystemPrompt falls back to the profile hint when undetected', () => {
  const prompt = buildSystemPrompt({
    memoryText: '',
    farmOverview: '',
    nalogMode: 'demo',
    language: 'th',
    activeFarmId: null,
    replyLanguage: null,
  });
  assert.match(prompt, /language hint: th/);
});
