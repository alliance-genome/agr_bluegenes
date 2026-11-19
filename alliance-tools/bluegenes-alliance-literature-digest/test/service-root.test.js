'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { serviceRoot } = require('../dist/bundle.js');

test('serviceRoot appends /service and keeps an existing one', () => {
	assert.strictEqual(serviceRoot('http://h/mine/'), 'http://h/mine/service');
	assert.strictEqual(serviceRoot('http://h/mine/service/'), 'http://h/mine/service');
});
