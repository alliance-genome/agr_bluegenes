'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { install } = require('./dom-stub.js');
install();
const tool = require('../dist/bundle.js');

const ROOT = 'http://h/mine';
const tick = () => new Promise((r) => setTimeout(r, 10));
const fakeEl = () => document.createElement('div');

test('serviceRoot appends /service to a mine root and keeps an existing one', () => {
	assert.strictEqual(tool.serviceRoot('http://localhost:9999/alliancetestmine'), 'http://localhost:9999/alliancetestmine/service');
	assert.strictEqual(tool.serviceRoot('http://localhost:9999/alliancetestmine/service/'), 'http://localhost:9999/alliancetestmine/service');
});

test('buildQuery escapes ids and uses ONE OF for lists', () => {
	const q = tool.buildQuery(['Gene.id'], '1"><x/>');
	assert.ok(q.includes('value="1&quot;&gt;&lt;x/&gt;"'));
	assert.ok(!q.includes('<x/>'));
	assert.ok(tool.buildQuery('Gene.id', ['1', '2']).includes('op="ONE OF"'));
});

test('plain strips html tags from symbols', () => {
	assert.strictEqual(tool.plain('Atm<sup>tm1Bal</sup>'), 'Atmtm1Bal');
	assert.strictEqual(tool.plain(null), '');
});

test('toParalogRow counts matched and called methods', () => {
	const r = tool.toParalogRow(['G', 5, 'HGNC:1', 'ERBB2', 'H. sapiens', 24, 33, 3, 'A|B|C', 'D']);
	assert.strictEqual(r.matched, 3);
	assert.strictEqual(r.total, 4);
});

test('toAlleleRow takes annotation counts by allele id', () => {
	const ph = tool.countBy([[7, 1], [7, 2], [8, null]]);
	const r = tool.toAlleleRow(['G', 7, 'MGI:1', 'A<sup>x</sup>', null, 'allele', null], ph, {});
	assert.strictEqual(r.phenotypes, 2);
	assert.strictEqual(r.diseases, 0);
	assert.strictEqual(r.symbol, 'Ax');
});

// Fake mine: dispatches on the query view and format.
function fakeMine(data, log) {
	return async (url, init) => {
		const body = new URLSearchParams(init.body);
		const query = body.get('query');
		const format = body.get('format');
		log.push({ url, format, query });
		const key = Object.keys(data).find((k) => query.includes(k));
		if (!key) return { ok: false, status: 500 };
		const v = data[key];
		if (v instanceof Error) return { ok: false, status: 500 };
		if (format === 'count') return { ok: true, text: async () => String(v.length) };
		return { ok: true, json: async () => ({ results: v }) };
	};
}

const DATA = {
	'Gene.alleles.phenotypeAnnotations.id': [[7, 1], [7, 2]],
	'Gene.alleles.diseaseAnnotations.id': [[7, 9]],
	'Gene.alleles.alleleSymbol': [['G1', 7, 'MGI:1', 'Atm<sup>a</sup>', null, 'allele', null]],
	'Gene.alleles.id': [[7]],
	'Gene.diseaseModels.modelName': [['G1', 'm1', 'ataxia', 'is_model_of', 'MGI'], ['G1', 'm2', 'cancer', 'is_model_of', 'MGI']],
	'Gene.diseaseModels.id': [[1], [2]],
	'Gene.paralogues.paralogue.primaryIdentifier': [['G1', 5, 'HGNC:1', 'ERBB2', 'H. sapiens', 24, 33, 3, 'A|B', 'C']],
	'Gene.paralogues.id': [[1]]
};

test('main loads counts, shows alleles, loads other tabs only on click', async () => {
	const log = [];
	globalThis.fetch = fakeMine(DATA, log);
	const el = fakeEl();
	const nav = [];
	tool.main(el, { root: ROOT }, { Gene: { value: '42' } }, {}, {}, (...a) => nav.push(a));
	await tick();

	assert.ok(log.every((l) => l.url === ROOT + '/service/query/results'));
	const json = log.filter((l) => l.format === 'json');
	assert.strictEqual(json.length, 3, 'only the alleles tab queries rows at start');
	assert.strictEqual(log.filter((l) => l.format === 'count').length, 3);

	const buttons = el.find('button');
	assert.deepStrictEqual(buttons.map((b) => b.textContent), ['Alleles (1)', 'Disease models (2)', 'Paralogs (1)']);
	assert.deepStrictEqual(buttons.map((b) => b.getAttribute('aria-selected')), ['true', 'false', 'false']);
	const text = el.textContent;
	assert.ok(text.includes('MGI:1') && text.includes('Atma'));
	const tds = el.find('td').map((t) => t.textContent);
	assert.deepStrictEqual(tds.slice(-2), ['2', '1']);

	el.find('a')[0].listeners.click({ preventDefault() {} });
	assert.deepStrictEqual(nav[0], ['report', { type: 'Allele', id: 7 }]);

	buttons[1].listeners.click();
	await tick();
	assert.ok(el.textContent.includes('ataxia') && el.textContent.includes('is_model_of'));
	assert.strictEqual(buttons[1].getAttribute('aria-selected'), 'true');
	assert.strictEqual(buttons[0].getAttribute('aria-selected'), 'false');

	buttons[2].listeners.click();
	await tick();
	assert.ok(el.textContent.includes('ERBB2') && el.textContent.includes('24%') && el.textContent.includes('2/3'));
	el.find('a')[0].listeners.click({ preventDefault() {} });
	assert.deepStrictEqual(nav[1], ['report', { type: 'Gene', id: 5 }]);

	const before = log.length;
	buttons[1].listeners.click();
	await tick();
	assert.strictEqual(log.length, before, 'a loaded tab is not queried again');
});

test('empty tab shows its empty state with a zero count', async () => {
	globalThis.fetch = fakeMine({ 'Gene.diseaseModels.modelName': [], 'Gene.diseaseModels.id': [], 'Gene.alleles': [], 'Gene.paralogues': [] }, []);
	const el = fakeEl();
	tool.main(el, { root: ROOT }, { Gene: { value: '42' } }, {}, {}, () => {});
	await tick();
	const b = el.find('button');
	assert.strictEqual(b[0].textContent, 'Alleles (0)');
	assert.ok(el.textContent.includes('No alleles in this mine'));
	b[1].listeners.click();
	await tick();
	assert.ok(el.textContent.includes('No disease models in this mine'));
});

test('failed tab logs to console.error and shows a short message', async () => {
	globalThis.fetch = fakeMine({ 'Gene.diseaseModels': new Error('x'), 'Gene.alleles': [], 'Gene.paralogues': [] }, []);
	const errors = [];
	const orig = console.error;
	console.error = (...a) => errors.push(a);
	try {
		const el = fakeEl();
		tool.main(el, { root: ROOT }, { Gene: { value: '42' } }, {}, {}, () => {});
		await tick();
		el.find('button')[1].listeners.click();
		await tick();
		assert.ok(el.textContent.includes('Could not load models from the mine'));
		assert.ok(errors.length >= 2, 'count failure and tab failure are both logged');
		assert.strictEqual(el.find('button')[1].textContent, 'Disease models');
	} finally {
		console.error = orig;
	}
});

test('list entity sends ONE OF and adds a Query gene column', async () => {
	const log = [];
	globalThis.fetch = fakeMine(DATA, log);
	const el = fakeEl();
	tool.main(el, { root: ROOT }, { Gene: { value: ['1', '2'] } }, {}, {}, () => {});
	await tick();
	assert.ok(log.every((l) => l.query.includes('op="ONE OF"')));
	assert.ok(el.find('th')[0].textContent === 'Query gene');
});

test('stale response from an older entity is dropped', async () => {
	let release;
	const gate = new Promise((r) => { release = r; });
	globalThis.fetch = async (url, init) => {
		const body = new URLSearchParams(init.body);
		const first = body.get('query').includes('value="1"');
		if (first) await gate;
		const rows = first ? [['G1', 7, 'OLD:1', 'old', null, 'allele', null]] : [['G2', 8, 'NEW:1', 'new', null, 'allele', null]];
		if (body.get('format') === 'count') return { ok: true, text: async () => '1' };
		const q = body.get('query');
		const res = q.includes('alleleSymbol') ? rows : [];
		return { ok: true, json: async () => ({ results: res }) };
	};
	const el = fakeEl();
	tool.main(el, { root: ROOT }, { Gene: { value: '1' } }, {}, {}, () => {});
	tool.main(el, { root: ROOT }, { Gene: { value: '2' } }, {}, {}, () => {});
	await tick();
	release();
	await tick();
	assert.ok(el.textContent.includes('NEW:1'));
	assert.ok(!el.textContent.includes('OLD:1'));
});

test('missing entity value shows an empty message, bad signature throws', () => {
	const el = fakeEl();
	tool.main(el, { root: ROOT }, { Gene: { value: [] } }, {}, {}, () => {});
	assert.ok(el.textContent.includes('No alleles, models or paralogs'));
	assert.throws(() => tool.main(null, {}, {}));
});

test('config.json accepts both id and ids', () => {
	const config = require('../config.json');
	assert.deepStrictEqual(config.accepts, ['id', 'ids']);
});
