'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { install } = require('./dom-stub.js');
install();
const tool = require('../dist/bundle.js');

const fakeEl = () => document.createElement('div');
const tick = (ms) => new Promise((r) => setTimeout(r, ms || 10));
const ok = (results) => ({ ok: true, json: async () => ({ results }) });
const bad = (status) => () => ({ ok: false, status });

function router(handlers) {
	return async (url, init) => {
		const q = decodeURIComponent(init.body.replace(/^.*&query=/, ''));
		for (const key of Object.keys(handlers)) {
			if (q.includes(key)) return handlers[key](q);
		}
		throw new Error('unrouted ' + q);
	};
}

const handlers = () => ({
	'Gene.homologues': () =>
		ok([
			[7, 'MGI:1', 'Brca1', 'M. musculus', 8, 10, true, true],
			[8, 'FBgn1', 'dx', 'D. melanogaster', 3, 10, false, false]
		]),
	'Gene.alleles.id': () => ok([[7, 100], [7, 101], [8, 102]]),
	'Gene.phenotypeAnnotations.id': () => ok([[7, 200]]),
	'Gene.diseaseAnnotation.id': () => ok([[7, 300, 'is_implicated_in']]),
	'Gene.diseaseModels.id': () => ok([[7, 400]]),
	'Gene.expressionAnnotations.id': () => ok([[8, 500]])
});

test('count queries rejected with HTTP 400 drop their columns and show a note', async () => {
	const h = handlers();
	h['Gene.phenotypeAnnotations.id'] = bad(400);
	h['Gene.diseaseModels.id'] = bad(400);
	h['Gene.expressionAnnotations.id'] = bad(400);
	globalThis.fetch = router(h);
	const el = fakeEl();
	tool.main(el, { root: 'http://h/mine' }, { Gene: { value: '42' } }, {}, {}, () => {});
	await tick();
	assert.deepStrictEqual(
		el.find('th').map((c) => c.textContent),
		['Species', 'Symbol', 'Confidence', 'Alleles', 'Disease', 'Score']
	);
	assert.ok(el.textContent.includes('This mine has no data for: phenotypes, disease models, expression.'));
	const first = el.find('tr')[1].find('td').map((c) => c.textContent);
	assert.deepStrictEqual(first.slice(0, 5), ['M. musculus', 'Brca1', '8/10, best both ways', '2', '1']);
	assert.strictEqual(first.length, 6);
});

test('a count query failing with HTTP 500 still fails the whole tool', async () => {
	const h = handlers();
	h['Gene.alleles.id'] = bad(500);
	globalThis.fetch = router(h);
	const orig = console.error;
	console.error = () => {};
	const el = fakeEl();
	tool.main(el, { root: 'http://h/mine' }, { Gene: { value: '42' } }, {}, {}, () => {});
	await tick();
	console.error = orig;
	assert.ok(el.textContent.includes('Could not load orthologs'));
});

test('in a list every gene section drops the unavailable column', async () => {
	const h = handlers();
	h['Gene.expressionAnnotations.id'] = bad(400);
	h['Gene.symbol'] = () => ok([[1, 'Brca1'], [2, 'Atm']]);
	globalThis.fetch = router(h);
	const el = fakeEl();
	tool.main(el, { root: 'http://h/mine' }, { Gene: { value: [1, 2] } }, {}, {}, () => {});
	await tick(40);
	assert.strictEqual(el.find('table').length, 2);
	assert.ok(!el.find('th').some((c) => c.textContent === 'Expression'));
});
