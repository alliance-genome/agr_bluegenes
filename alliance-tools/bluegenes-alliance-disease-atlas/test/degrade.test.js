'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { install } = require('./dom-stub.js');
install();
const atlas = require('../dist/bundle.js');

const tick = () => new Promise((r) => setTimeout(r, 10));
const ROOT = 'http://h/mine';

const ANN = [[1, 'BRCA1', 'HGNC:1100', 'H. sapiens', 'DOID:162', 'cancer', 'is_implicated_in', 'ECO:1']];

// Answers by query text; a handler returning null means HTTP 400.
function stub(handlers) {
	return async (url, opts) => {
		const q = new URLSearchParams(opts.body).get('query');
		for (const h of handlers) {
			if (h.when.test(q)) {
				if (h.rows === null) return { ok: false, status: 400, json: async () => ({}) };
				return { ok: true, json: async () => ({ results: h.rows }) };
			}
		}
		return { ok: true, json: async () => ({ results: [] }) };
	};
}

test('disease model query rejected with HTTP 400 drops the models column and shows a note', async () => {
	globalThis.fetch = stub([
		{ when: /Gene\.diseaseModels/, rows: null },
		{ when: /DOTerm\.id" op="="/, rows: [[10, 'DOID:162', 'cancer']] },
		{ when: /diseaseAnnotation/, rows: ANN }
	]);
	const el = document.createElement('div');
	atlas.main(el, { root: ROOT }, { DOTerm: { value: 10 } }, {}, {}, () => {});
	await tick();
	assert.deepStrictEqual(el.find('th').map((c) => c.textContent), ['Gene', 'Direct', 'Via orthology']);
	assert.match(el.textContent, /This mine has no disease model data/);
	assert.match(el.textContent, /1 genes in 1 organisms annotated to cancer/);
});

test('child term query rejected with HTTP 400 disables the checkbox and keeps the term', async () => {
	globalThis.fetch = stub([
		{ when: /DOTerm\.parents\.id/, rows: null },
		{ when: /DOTerm\.id" op="="/, rows: [[10, 'DOID:162', 'cancer']] },
		{ when: /diseaseAnnotation/, rows: ANN }
	]);
	const el = document.createElement('div');
	atlas.main(el, { root: ROOT }, { DOTerm: { value: 10 } }, {}, {}, () => {});
	await tick();
	const box = el.find('input')[0];
	box.checked = true;
	box.listeners.change();
	await tick();
	assert.match(el.textContent, /This mine has no child term data/);
	assert.strictEqual(el.find('input')[0].disabled, true);
	assert.match(el.textContent, /1 genes in 1 organisms annotated to cancer/);
});

test('annotation query rejected with HTTP 400 still fails the tool', async () => {
	globalThis.fetch = stub([
		{ when: /DOTerm\.id" op="="/, rows: [[10, 'DOID:162', 'cancer']] },
		{ when: /diseaseAnnotation/, rows: null }
	]);
	const orig = console.error;
	console.error = () => {};
	const el = document.createElement('div');
	atlas.main(el, { root: ROOT }, { DOTerm: { value: 10 } }, {}, {}, () => {});
	await tick();
	console.error = orig;
	assert.match(el.textContent, /Could not load genes/);
});
