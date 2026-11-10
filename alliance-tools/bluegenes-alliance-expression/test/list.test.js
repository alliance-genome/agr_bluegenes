'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { install } = require('./dom-stub.js');
install();
const tool = require('../dist/bundle.js');

const row = (gene, id, anatomy, stage, pmid) => [gene, id, anatomy, 'T:' + id, stage, 'RNA-seq', 'MGI', pmid];
const tick = () => new Promise((res) => setTimeout(res, 5));

test('main accepts an array of ids (list page) and posts ONE OF', async () => {
	let init;
	globalThis.fetch = async (u, i) => {
		init = i;
		return { ok: true, json: async () => ({ results: [row('G1', 1, 'brain', 's1', 11), row('G2', 2, 'eye', 's1', 12)] }) };
	};
	const el = document.createElement('div');
	tool.main(el, { root: 'http://localhost:9999/alliancetestmine' }, { Gene: { value: ['1', '2'] } });
	await tick();
	const body = decodeURIComponent(init.body);
	assert.ok(body.includes('op="ONE OF"'));
	assert.ok(body.includes('<value>1</value>') && body.includes('<value>2</value>'));
	assert.ok(el.textContent.includes('2 annotations in 2 anatomy terms'));
});
