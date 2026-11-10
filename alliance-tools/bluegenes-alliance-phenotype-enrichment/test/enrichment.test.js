'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { install } = require('./dom-stub.js');
install();
const tool = require('../dist/bundle.js');

const close = (actual, expected, rel = 1e-9) =>
	assert.ok(
		Math.abs(actual - expected) <= rel * Math.abs(expected),
		'expected ' + expected + ' got ' + actual
	);

// Reference values: scipy.stats.hypergeom.sf(k - 1, N, K, n), scipy 1.x.
const REFERENCE = [
	[3, 10, 20, 100, 0.3187799361823112],
	[1, 10, 20, 100, 0.9048837275692115],
	[10, 10, 10, 100, 5.776904234533875e-14],
	[5, 50, 60, 1000, 0.1747094227849466],
	[40, 200, 300, 20000, 1.9882408278245844e-33],
	[200, 1000, 2000, 20000, 1.5085601363767355e-22],
	[2, 5, 5000, 20000, 0.36718749912091786]
];

test('hypergeometric upper tail matches scipy', () => {
	REFERENCE.forEach(([k, n, K, N, p]) => close(tool.hypergeomUpperTail(k, n, K, N), p, 1e-8));
});

test('hypergeometric upper tail edge cases', () => {
	assert.strictEqual(tool.hypergeomUpperTail(0, 10, 20, 100), 1);
	assert.strictEqual(tool.hypergeomUpperTail(7, 30, 40, 45), 1);
	assert.strictEqual(tool.hypergeomUpperTail(12, 12, 12, 12), 1);
	assert.strictEqual(tool.hypergeomUpperTail(6, 5, 20, 100), 0);
});

test('Benjamini-Hochberg matches scipy false_discovery_control', () => {
	const adj = tool.benjaminiHochberg([0.01, 0.04, 0.03, 0.005, 0.5, 0.03, 1.0]);
	[0.035, 0.056, 0.0525, 0.035, 0.5833333333333334, 0.0525, 1.0].forEach((v, i) => close(adj[i], v));
});

test('prefixOf takes the text before the colon', () => {
	assert.strictEqual(tool.prefixOf('MP:0002169'), 'MP');
	assert.strictEqual(tool.prefixOf('WBPhenotype:0000001'), 'WBPhenotype');
	assert.strictEqual(tool.prefixOf('FBcv:0000351'), 'FBcv');
	assert.strictEqual(tool.prefixOf('nocolon'), 'other');
});

// 4 list genes (n) of 100 (N). Term A: 3 list genes, 5 in mine. Term B: 1 list gene, 50 in mine.
// Annotation 7 and 8 have no term; annotation 8 appears twice.
const data = () => ({
	n: 4,
	N: 100,
	organisms: ['H. sapiens'],
	capped: false,
	skipped: 2,
	listAnnotations: [
		[1, 1, 901, 'MP:A', 'term a'],
		[2, 2, 901, 'MP:A', 'term a'],
		[2, 3, 901, 'MP:A', 'term a'],
		[3, 4, 901, 'MP:A', 'term a'],
		[1, 5, 902, 'HP:B', 'term b'],
		[4, 7, null, null, null],
		[4, 8, null, null, null],
		[4, 8, null, null, null]
	],
	background: [1, 2, 3, 4, 5]
		.map((g) => [g, 'MP:A'])
		.concat(Array.from({ length: 50 }, (_, i) => [i + 1, 'HP:B']))
});

test('compute counts distinct genes and ignores rows without a term', () => {
	const r = tool.compute(data());
	const a = r.find((t) => t.identifier === 'MP:A');
	assert.deepStrictEqual([a.k, a.n, a.K, a.N, a.prefix], [3, 4, 5, 100, 'MP']);
	close(a.p, tool.hypergeomUpperTail(3, 4, 5, 100));
	close(a.fold, (3 / 4) / (5 / 100));
	assert.deepStrictEqual(r.map((t) => t.identifier), ['MP:A', 'HP:B']);
	assert.ok(r[0].p < r[1].p);
});

test('compute applies BH over all tested terms', () => {
	const r = tool.compute(data());
	const adj = tool.benjaminiHochberg(r.map((t) => t.p));
	r.forEach((t, i) => close(t.fdr, adj[i]));
});

test('skippedCount counts distinct annotations without a term', () => {
	assert.strictEqual(tool.skippedCount(data().listAnnotations), 2);
	assert.strictEqual(tool.skippedCount([[1, null, null, null, null]]), 0);
});

test('query builders escape values and use ONE OF', () => {
	const q = tool.backgroundQuery(['H. <sapiens>'], ['MP:"1"'], 'Gene.phenotypeAnnotations');
	assert.ok(q.includes('<value>H. &lt;sapiens&gt;</value>'));
	assert.ok(q.includes('<value>MP:&quot;1&quot;</value>'));
	assert.ok(!q.includes('<sapiens>'));
	assert.ok(q.includes('Gene.phenotypeAnnotations.ontologyTerm.identifier'));
	const l = tool.listAnnotationsQuery(['1', '2'], 'Gene.alleles.phenotypeAnnotations');
	assert.ok(l.includes('op="ONE OF"'));
	assert.ok(l.includes('Gene.alleles.phenotypeAnnotations.ontologyTerm.name'));
	assert.ok(l.includes('<join path="Gene.alleles" style="OUTER"/>'));
	assert.ok(l.includes('<join path="Gene.alleles.phenotypeAnnotations.ontologyTerm" style="OUTER"/>'));
	assert.ok(tool.listAnnotationsQuery(['1'], 'Gene.phenotypeAnnotations').includes('<join path="Gene.phenotypeAnnotations" style="OUTER"/>'));
});

const fakeEl = () => document.createElement('div');
const tick = () => new Promise((r) => setTimeout(r, 10));

// Answers each request by its body. Allele paths return one extra term, ZP:X, on all four genes.
function stubFetch(log, opts = {}) {
	return async (url, init) => {
		log.push({ url, init });
		const body = decodeURIComponent(init.body);
		if (opts.fail) return { ok: false, status: 500 };
		const allele = body.includes('Gene.alleles.phenotypeAnnotations');
		let results;
		if (body.includes('summaryPath=')) {
			results = [['H. sapiens', 100]];
		} else if (body.includes('view="Gene.id Gene.organism.shortName"') && body.includes('path="Gene.id"')) {
			results = [[1, 'H. sapiens'], [2, 'H. sapiens'], [3, 'H. sapiens'], [4, 'H. sapiens']];
		} else if (body.includes('path="Gene.organism.shortName"')) {
			results = allele ? [1, 2, 3, 4].map((g) => [g, 'ZP:X']) : data().background;
		} else {
			results = allele ? [1, 2, 3, 4].map((g) => [g, 50 + g, 903, 'ZP:X', 'term x']) : data().listAnnotations;
		}
		return { ok: true, json: async () => ({ results }) };
	};
}

test('main posts to <mine root>/service/query/results and renders the table', async () => {
	const log = [];
	globalThis.fetch = stubFetch(log);
	const el = fakeEl();
	const calls = [];
	tool.main(el, { root: 'http://h/mine' }, { Gene: { value: ['1', '2', '3', '4'] } }, {}, {}, (...a) => calls.push(a));
	await tick();
	assert.strictEqual(log.length, 4);
	log.forEach((l) => {
		assert.strictEqual(l.url, 'http://h/mine/service/query/results');
		assert.strictEqual(l.init.method, 'POST');
	});
	const text = el.textContent;
	assert.ok(text.includes('Background: all 100 genes of H. sapiens'));
	assert.ok(text.includes('2 annotations without a term were skipped'));
	assert.ok(text.includes('term a'));
	assert.ok(text.includes('3/4'));
	assert.ok(text.includes('5/100'));
	assert.ok(!text.includes('term x'));
	el.find('a')[0].listeners.click({ preventDefault() {} });
	assert.deepStrictEqual(calls[0], ['report', { type: 'OntologyTerm', id: 901 }]);
});

test('prefix checkbox hides the ontology rows', async () => {
	globalThis.fetch = stubFetch([]);
	const el = fakeEl();
	tool.main(el, { root: 'http://h/mine' }, { Gene: { value: ['1', '2', '3', '4'] } }, {}, {}, () => {});
	await tick();
	const boxes = el.find('input');
	// inputs: max FDR, alleles, then one per prefix sorted (HP, MP)
	assert.strictEqual(boxes.length, 4);
	assert.ok(el.textContent.includes('term a'));
	boxes[3].checked = false;
	boxes[3].listeners.change();
	const text = el.textContent;
	assert.ok(!text.includes('term a'));
	assert.ok(text.includes('No enriched phenotype terms'));
});

test('allele option reloads with allele paths and adds their terms', async () => {
	const log = [];
	globalThis.fetch = stubFetch(log);
	const el = fakeEl();
	tool.main(el, { root: 'http://h/mine' }, { Gene: { value: ['1', '2', '3', '4'] } }, {}, {}, () => {});
	await tick();
	assert.ok(!log.some((l) => decodeURIComponent(l.init.body).includes('Gene.alleles.')));
	const box = el.find('input')[1];
	box.checked = true;
	box.listeners.change();
	await tick();
	assert.ok(log.some((l) => decodeURIComponent(l.init.body).includes('Gene.alleles.phenotypeAnnotations')));
	const text = el.textContent;
	assert.ok(text.includes('term x'));
	assert.ok(text.includes('ZP'));
	assert.ok(el.find('input')[1].checked);
});

test('main shows a message and logs on failure', async () => {
	const errors = [];
	const orig = console.error;
	console.error = (...a) => errors.push(a);
	globalThis.fetch = stubFetch([], { fail: true });
	const el = fakeEl();
	tool.main(el, { root: 'http://h/mine' }, { Gene: { value: ['1'] } }, {}, {}, () => {});
	await tick();
	console.error = orig;
	assert.ok(el.textContent.includes('Could not compute phenotype enrichment'));
	assert.strictEqual(errors.length, 1);
});

test('main ignores a stale response', async () => {
	let release;
	const gate = new Promise((r) => (release = r));
	let first = true;
	globalThis.fetch = async (url, init) => {
		if (first) {
			first = false;
			await gate;
		}
		return stubFetch([])(url, init);
	};
	const el = fakeEl();
	tool.main(el, { root: 'http://h/mine' }, { Gene: { value: ['1'] } }, {}, {}, () => {});
	globalThis.fetch = stubFetch([]);
	tool.main(el, { root: 'http://h/mine' }, { Gene: { value: ['2'] } }, {}, {}, () => {});
	await tick();
	const after = el.textContent;
	release();
	await tick();
	assert.strictEqual(el.textContent, after);
});

test('main with no ids shows a message without fetching', () => {
	let called = false;
	globalThis.fetch = async () => { called = true; };
	const el = fakeEl();
	tool.main(el, { root: 'http://h/mine' }, { Gene: { value: [] } }, {}, {}, () => {});
	assert.strictEqual(called, false);
	assert.ok(el.textContent.includes('No genes to analyse'));
});
