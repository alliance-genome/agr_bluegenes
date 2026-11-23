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

test('isNegated flags not-qualifiers only', () => {
	assert.strictEqual(tool.isNegated('is_not_implicated_in'), true);
	assert.strictEqual(tool.isNegated('NOT'), true);
	assert.strictEqual(tool.isNegated('is_implicated_in'), false);
	assert.strictEqual(tool.isNegated('implicated_via_orthology'), false);
	assert.strictEqual(tool.isNegated(null), false);
});

// 4 list genes (n) of 100 (N). Term A: 3 list genes, 5 in mine. Term B: 1 list gene, 50 in mine.
const data = () => ({
	n: 4,
	N: 100,
	organisms: ['H. sapiens'],
	capped: false,
	listAnnotations: [
		[1, 901, 'DOID:A', 'term a', 'is_implicated_in'],
		[2, 901, 'DOID:A', 'term a', 'is_implicated_in'],
		[2, 901, 'DOID:A', 'term a', 'is_implicated_in'],
		[3, 901, 'DOID:A', 'term a', 'is_implicated_in'],
		[4, 901, 'DOID:A', 'term a', 'is_not_implicated_in'],
		[1, 902, 'DOID:B', 'term b', 'is_implicated_in']
	],
	background: [1, 2, 3, 4, 5]
		.map((g) => [g, 'DOID:A', g === 4 ? 'is_not_implicated_in' : 'is_implicated_in'])
		.concat(Array.from({ length: 50 }, (_, i) => [i + 1, 'DOID:B', 'is_implicated_in']))
});

test('compute counts distinct genes and drops negated annotations by default', () => {
	const r = tool.compute(data(), {});
	const a = r.find((t) => t.identifier === 'DOID:A');
	assert.deepStrictEqual([a.k, a.n, a.K, a.N], [3, 4, 4, 100]);
	close(a.p, tool.hypergeomUpperTail(3, 4, 4, 100));
	close(a.fold, (3 / 4) / (4 / 100));
	assert.deepStrictEqual(r.map((t) => t.identifier), ['DOID:A', 'DOID:B']);
	assert.ok(r[0].p < r[1].p);
});

test('compute with includeNegated counts the negated gene', () => {
	const a = tool.compute(data(), { includeNegated: true }).find((t) => t.identifier === 'DOID:A');
	assert.deepStrictEqual([a.k, a.K], [4, 5]);
});

test('compute applies BH over the tested terms', () => {
	const r = tool.compute(data(), {});
	const ps = r.map((t) => t.p);
	const adj = tool.benjaminiHochberg(ps);
	r.forEach((t, i) => close(t.fdr, adj[i]));
});

test('query builders escape values and use ONE OF', () => {
	const q = tool.backgroundQuery(['H. <sapiens>'], ['DOID:"1"']);
	assert.ok(q.includes('<value>H. &lt;sapiens&gt;</value>'));
	assert.ok(q.includes('<value>DOID:&quot;1&quot;</value>'));
	assert.ok(!q.includes('<sapiens>'));
	assert.ok(tool.listAnnotationsQuery(['1', '2']).includes('op="ONE OF"'));
});

const fakeEl = () => document.createElement('div');
const tick = () => new Promise((r) => setTimeout(r, 10));

// Answers each of the four requests by its body.
function stubFetch(log, opts = {}) {
	return async (url, init) => {
		log.push({ url, init });
		const body = decodeURIComponent(init.body);
		if (opts.fail) return { ok: false, status: 500 };
		let results;
		if (body.includes('summaryPath=')) {
			results = [['H. sapiens', 100]];
		} else if (body.includes('view="Gene.id Gene.organism.shortName"') && body.includes('path="Gene.id"')) {
			results = [[1, 'H. sapiens'], [2, 'H. sapiens'], [3, 'H. sapiens'], [4, 'H. sapiens']];
		} else if (body.includes('path="Gene.organism.shortName"')) {
			results = data().background;
		} else {
			results = data().listAnnotations;
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
	assert.ok(text.includes('term a'));
	assert.ok(text.includes('3/4'));
	assert.ok(text.includes('4/100'));
	el.find('a')[0].listeners.click({ preventDefault() {} });
	assert.deepStrictEqual(calls[0], ['report', { type: 'DOTerm', id: 901 }]);
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
	assert.ok(el.textContent.includes('Could not compute disease enrichment'));
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

test('compute withholds p and FDR when the list annotations hit the row limit', () => {
	const r = tool.compute({ ...data(), listCapped: true }, {});
	assert.ok(r.length > 0);
	r.forEach((t) => {
		assert.strictEqual(t.incomplete, true);
		assert.strictEqual(t.p, null);
		assert.strictEqual(t.fdr, null);
		assert.strictEqual(t.fold, null);
	});
});

test('compute withholds p and FDR only for terms whose background was truncated', () => {
	const r = tool.compute({ ...data(), truncated: { 'DOID:B': true } }, {});
	assert.deepStrictEqual(r.map((t) => [t.identifier, t.incomplete]), [['DOID:A', false], ['DOID:B', true]]);
	assert.strictEqual(r[1].p, null);
	assert.strictEqual(r[1].fdr, null);
	close(r[0].fdr, r[0].p);
});

// 450 distinct terms, each annotated for gene 1.
const manyTerms = Array.from({ length: 450 }, (_, i) => [1, 1000 + i, 'DOID:' + i, 'term ' + i, 'is_implicated_in']);

function manyTermsFetch(log, backgroundRows) {
	return async (url, init) => {
		const body = decodeURIComponent(init.body);
		let results;
		if (body.includes('summaryPath=')) results = [['H. sapiens', 100]];
		else if (body.includes('view="Gene.id Gene.organism.shortName"') && body.includes('path="Gene.id"')) results = [[1, 'H. sapiens']];
		else if (body.includes('path="Gene.organism.shortName"')) {
			log.push((body.match(/<value>DOID:/g) || []).length);
			results = backgroundRows(body);
		} else results = manyTerms;
		return { ok: true, json: async () => ({ results }) };
	};
}

test('background terms go out in sequential chunks of 200', async () => {
	const log = [];
	globalThis.fetch = manyTermsFetch(log, () => []);
	const el = fakeEl();
	tool.main(el, { root: 'http://h/mine' }, { Gene: { value: ['1'] } }, {}, {}, () => {});
	await new Promise((r) => setTimeout(r, 60));
	assert.deepStrictEqual(log, [200, 200, 50]);
});

test('a single term at the row limit is shown without p and FDR and with a note', async () => {
	globalThis.fetch = manyTermsFetch([], (body) =>
		body.includes('<value>DOID:7</value>')
			? Array.from({ length: 200000 }, (_, i) => [i + 1, 'DOID:7', 'is_implicated_in'])
			: []
	);
	const el = fakeEl();
	tool.main(el, { root: 'http://h/mine' }, { Gene: { value: ['1'] } }, {}, {}, () => {});
	await new Promise((r) => setTimeout(r, 1500));
	assert.ok(el.textContent.includes('their background counts are incomplete'));
	assert.ok(el.textContent.includes('449 terms tested'));
	el.find('button').find((b) => b.textContent === 'Show all 450').listeners.click();
	const last = el.find('tbody')[0].children[449];
	assert.ok(last.textContent.includes('term 7'));
	assert.ok(last.textContent.includes('n/a'));
});

test('the table shows 10 rows, offers all of them, and downloads every row as CSV', async () => {
	globalThis.fetch = manyTermsFetch([], () => []);
	const el = fakeEl();
	tool.main(el, { root: 'http://h/mine' }, { Gene: { value: ['1'] } }, {}, {}, () => {});
	await new Promise((r) => setTimeout(r, 60));
	assert.strictEqual(el.find('tbody')[0].children.length, 10);
	const labels = el.find('button').map((b) => b.textContent);
	assert.ok(labels.includes('Download CSV'));
	assert.ok(labels.includes('Show all 450'));
	el.find('button').find((b) => b.textContent === 'Show all 450').listeners.click();
	assert.strictEqual(el.find('tbody')[0].children.length, 450);
});

test('toCsv quotes commas and defuses spreadsheet formulas', () => {
	const csv = tool.toCsv(tool.CSV_HEADER, [tool.csvRow({ name: '=SUM(A1)', identifier: 'DOID:1', k: 2, n: 4, K: 5, N: 100, fold: 5, p: 0.01, fdr: 0.02, incomplete: false })]);
	assert.strictEqual(csv.split('\r\n')[0], 'Term,Identifier,k,n,K,N,Fold,p,FDR,Counts complete');
	assert.strictEqual(csv.split('\r\n')[1], "'=SUM(A1),DOID:1,2,4,5,100,5,0.01,0.02,yes");
	assert.strictEqual(tool.toCsv(['a'], [['x,"y"']]), 'a\r\n"x,""y"""\r\n');
});
