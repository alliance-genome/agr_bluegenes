'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { install } = require('./dom-stub.js');
install();
const tool = require('../dist/bundle.js');

const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, a + ' vs ' + b);

test('confidence is the match ratio plus 0.1 per best flag', () => {
	near(tool.confidence(5, 10, false, false), 0.5);
	near(tool.confidence(5, 10, true, false), 0.6);
	near(tool.confidence(5, 10, true, true), 0.7);
	near(tool.confidence(10, 10, true, true), 1.2);
	assert.strictEqual(tool.confidence(null, null, false, false), 0);
	assert.strictEqual(tool.confidence(3, 0, false, false), 0);
});

test('resourceTerm is 1 plus the sum of log1p counts', () => {
	assert.strictEqual(tool.resourceTerm({}), 1);
	near(tool.resourceTerm({ alleles: 1, phenotypes: 3 }), 1 + Math.log(2) + Math.log(4));
	near(
		tool.resourceTerm({ alleles: 1, phenotypes: 1, diseases: 1, models: 1, expression: 1 }),
		1 + 5 * Math.log(2)
	);
	assert.strictEqual(tool.resourceTerm({ alleles: -4 }), 1);
});

test('score is confidence times resource term', () => {
	near(tool.score({ match: 5, attempted: 10, best: true, bestReverse: true, alleles: 2 }), 0.7 * (1 + Math.log(3)));
	assert.strictEqual(tool.score({ match: 0, attempted: 10, alleles: 50 }), 0);
});

test('rank sorts by score, then species and symbol', () => {
	const r = tool.rank([
		{ id: 1, symbol: 'b', species: 'M. musculus', match: 5, attempted: 10 },
		{ id: 2, symbol: 'a', species: 'M. musculus', match: 5, attempted: 10 },
		{ id: 3, symbol: 'c', species: 'D. rerio', match: 9, attempted: 10, alleles: 4 }
	]);
	assert.deepStrictEqual(r.map((o) => o.id), [3, 2, 1]);
	assert.ok(r[0].score > r[1].score);
});

test('isDirectQualifier excludes negations and via_orthology', () => {
	assert.strictEqual(tool.isDirectQualifier('is_implicated_in'), true);
	assert.strictEqual(tool.isDirectQualifier('is_marker_for'), true);
	assert.strictEqual(tool.isDirectQualifier('is_not_implicated_in'), false);
	assert.strictEqual(tool.isDirectQualifier('implicated_via_orthology'), false);
	assert.strictEqual(tool.isDirectQualifier('biomarker_via_orthology'), false);
	assert.strictEqual(tool.isDirectQualifier(null), false);
});

test('toOrthologs keeps one entry per homologue, the more confident one', () => {
	const o = tool.toOrthologs([
		[7, 'MGI:1', 'Brca1', 'M. musculus', 2, 10, false, false],
		[7, 'MGI:1', 'Brca1', 'M. musculus', 8, 10, true, false],
		[8, 'FB:1', 'x', 'D. melanogaster', 1, 10, false, true]
	]);
	assert.strictEqual(o.length, 2);
	assert.strictEqual(o.find((x) => x.id === 7).match, 8);
});

test('countByGene counts distinct object ids per gene and applies keep', () => {
	const rows = [[1, 10, 'a'], [1, 10, 'a'], [1, 11, 'b'], [2, null, null], [2, 12, 'a']];
	assert.deepStrictEqual(tool.countByGene(rows), { 1: 2, 2: 1 });
	assert.deepStrictEqual(tool.countByGene(rows, (r) => r[2] === 'a'), { 1: 1, 2: 1 });
});

test('buildQuery escapes ids and uses ONE OF for several', () => {
	const view = ['Gene.id', 'Gene.alleles.id'];
	const one = tool.buildQuery(view, '1"><x/>&');
	assert.ok(one.includes('value="1&quot;&gt;&lt;x/&gt;&amp;"'));
	assert.ok(!one.includes('<x/>'));
	const many = tool.buildQuery(view, ['1', '<2>']);
	assert.ok(many.includes('op="ONE OF"'));
	assert.ok(many.includes('<value>1</value><value>&lt;2&gt;</value>'));
});

const fakeEl = () => document.createElement('div');
const tick = (ms) => new Promise((r) => setTimeout(r, ms || 10));
const ok = (results) => ({ ok: true, json: async () => ({ results }) });

// Routes a POST by the first path in its query view.
function router(handlers, log) {
	return async (url, init) => {
		const q = decodeURIComponent(init.body.replace(/^.*&query=/, ''));
		log && log.push({ url, init, q });
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
	'Gene.diseaseAnnotation.id': () => ok([[7, 300, 'is_implicated_in'], [7, 301, 'implicated_via_orthology'], [8, 302, 'is_not_implicated_in']]),
	'Gene.diseaseModels.id': () => ok([[7, 400]]),
	'Gene.expressionAnnotations.id': () => ok([[8, 500], [8, 501], [8, 502]])
});

test('main renders ranked rows with counts, link and formula, in six POST requests', async () => {
	const log = [];
	globalThis.fetch = router(handlers(), log);
	const el = fakeEl();
	const calls = [];
	tool.main(el, { root: 'http://h/mine' }, { Gene: { value: '42' } }, {}, {}, (...a) => calls.push(a));
	await tick();
	assert.strictEqual(log.length, 6);
	assert.ok(log.every((l) => l.url === 'http://h/mine/service/query/results' && l.init.method === 'POST'));
	assert.ok(log[0].q.includes('path="Gene.id" op="=" value="42"'));
	assert.ok(log.slice(1).every((l) => l.q.includes('op="ONE OF"') && l.q.includes('<value>7</value><value>8</value>')));

	const rows = el.find('tr').slice(1);
	assert.strictEqual(rows.length, 2);
	const first = rows[0].find('td').map((c) => c.textContent);
	assert.deepStrictEqual(first.slice(0, 8), ['M. musculus', 'Brca1', '8/10, best both ways', '2', '1', '1', '1', '0']);
	const expected = tool.score({ match: 8, attempted: 10, best: true, bestReverse: true, alleles: 2, phenotypes: 1, diseases: 1, models: 1, expression: 0 });
	assert.strictEqual(first[8], (Math.round(expected * 100) / 100).toFixed(2));
	const second = rows[1].find('td').map((c) => c.textContent);
	assert.strictEqual(second[5], '0');
	assert.strictEqual(second[7], '3');
	assert.ok(el.textContent.includes('How is this ranked?'));
	assert.ok(el.textContent.includes('2 orthologs in 2 species. Top: Brca1'));

	rows[0].find('a')[0].listeners.click({ preventDefault() {} });
	assert.deepStrictEqual(calls, [['report', { type: 'Gene', id: 7 }]]);
});

test('main shows "No orthologs" and makes no count queries when there are none', async () => {
	const log = [];
	globalThis.fetch = router({ 'Gene.homologues': () => ok([]) }, log);
	const el = fakeEl();
	tool.main(el, { root: 'http://h/mine' }, { Gene: { value: '42' } }, {}, {}, () => {});
	await tick();
	assert.strictEqual(log.length, 1);
	assert.ok(el.textContent.includes('No orthologs'));
});

test('main with an empty entity shows "No orthologs"', () => {
	const el = fakeEl();
	tool.main(el, { root: 'http://h/mine' }, { Gene: { value: '' } }, {}, {}, () => {});
	assert.ok(el.textContent.includes('No orthologs'));
});

test('main logs and shows a message when a request fails', async () => {
	globalThis.fetch = async () => ({ ok: false, status: 500 });
	const errors = [];
	const orig = console.error;
	console.error = (...a) => errors.push(a);
	const el = fakeEl();
	tool.main(el, { root: 'http://h/mine' }, { Gene: { value: '42' } }, {}, {}, () => {});
	await tick();
	console.error = orig;
	assert.strictEqual(errors.length, 1);
	assert.ok(el.textContent.includes('Could not load orthologs'));
});

test('a stale response does not overwrite a newer one', async () => {
	let n = 0;
	globalThis.fetch = async (url, init) => {
		const q = decodeURIComponent(init.body);
		const mine = q.includes('Gene.homologues') ? ++n : 0;
		if (mine === 1) await tick(40);
		return handlers()[Object.keys(handlers()).find((k) => q.includes(k))]();
	};
	const el = fakeEl();
	tool.main(el, { root: 'http://h/mine' }, { Gene: { value: '1' } }, {}, {}, () => {});
	tool.main(el, { root: 'http://h/mine' }, { Gene: { value: '2' } }, {}, {}, () => {});
	await tick(120);
	assert.strictEqual(el.find('tr').length, 3);
	assert.strictEqual(el.__agrPickerReq, 2);
});

test('a list of two genes renders one section per gene with symbols', async () => {
	const log = [];
	const h = handlers();
	h['Gene.symbol'] = () => ok([[1, 'Brca1'], [2, 'Atm']]);
	globalThis.fetch = router(h, log);
	const el = fakeEl();
	tool.main(el, { root: 'http://h/mine' }, { Gene: { value: [1, 2] } }, {}, {}, () => {});
	await tick(40);
	assert.strictEqual(log.length, 13);
	assert.deepStrictEqual(el.find('h4').map((x) => x.textContent), ['Brca1', 'Atm']);
	assert.strictEqual(el.find('table').length, 2);
	assert.ok(log.some((l) => l.q.includes('path="Gene.id" op="=" value="1"')));
	assert.ok(log.some((l) => l.q.includes('path="Gene.id" op="=" value="2"')));
});

test('a list longer than 10 genes shows a visible note', async () => {
	globalThis.fetch = router({ 'Gene.symbol': () => ok([]), 'Gene.homologues': () => ok([]) }, []);
	const el = fakeEl();
	const ids = Array.from({ length: 12 }, (_, i) => i + 1);
	tool.main(el, { root: 'http://h/mine' }, { Gene: { value: ids } }, {}, {}, () => {});
	await tick(40);
	assert.ok(el.textContent.includes('Showing the first 10 of 12 genes.'));
	assert.strictEqual(el.find('h4').length, 10);
});

test('a one-element list behaves like a single gene', async () => {
	globalThis.fetch = router(handlers(), []);
	const el = fakeEl();
	tool.main(el, { root: 'http://h/mine' }, { Gene: { value: [42] } }, {}, {}, () => {});
	await tick();
	assert.strictEqual(el.find('h4').length, 0);
	assert.strictEqual(el.find('tr').length, 3);
});
