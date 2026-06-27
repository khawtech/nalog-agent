import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodePumpCommand } from '../src/integrations/chirpstack.js';

test('pump command encoding maps on/start to 0x01 and off/stop to 0x00', () => {
  assert.equal(encodePumpCommand('on'), 'AQ==');
  assert.equal(encodePumpCommand('start'), 'AQ==');
  assert.equal(encodePumpCommand('off'), 'AA==');
  assert.equal(encodePumpCommand('stop'), 'AA==');
});
