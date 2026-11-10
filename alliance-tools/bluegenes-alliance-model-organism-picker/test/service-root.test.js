const test = require('node:test');
const assert = require('node:assert');
const { serviceRoot } = require('../dist/bundle.js');

test('serviceRoot appends /service to a mine root', () => {
  assert.strictEqual(serviceRoot('http://localhost:9999/alliancetestmine'), 'http://localhost:9999/alliancetestmine/service');
  assert.strictEqual(serviceRoot('https://alliancemine.alliancegenome.org/alliancemine/'), 'https://alliancemine.alliancegenome.org/alliancemine/service');
});

test('serviceRoot keeps a root that already ends in /service', () => {
  assert.strictEqual(serviceRoot('http://localhost:9999/alliancetestmine/service'), 'http://localhost:9999/alliancetestmine/service');
  assert.strictEqual(serviceRoot('http://localhost:9999/alliancetestmine/service/'), 'http://localhost:9999/alliancetestmine/service');
});
