'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { install } = require('./dom-stub.js');
install();
const tool = require('../dist/bundle.js');

const tick = () => new Promise((r) => setTimeout(r, 10));

test('queries escape ids and use ONE OF', () => {
	const q = tool.phenotypesQuery(['1"><x/>&', '2']);
	assert.ok(q.includes('op="ONE OF"'));
	assert.ok(q.includes('<value>1&quot;&gt;&lt;x/&gt;&amp;</value>'));
	assert.ok(!q.includes('<x/>'));
});

test('isDirectDisease excludes via_orthology and is_not_implicated_in', () => {
	assert.strictEqual(tool.isDirectDisease('is_implicated_in'), true);
	assert.strictEqual(tool.isDirectDisease('is_marker_for'), true);
	assert.strictEqual(tool.isDirectDisease('implicated_via_orthology'), false);
	assert.strictEqual(tool.isDirectDisease('biomarker_via_orthology'), false);
	assert.strictEqual(tool.isDirectDisease('is_not_implicated_in'), false);
});

test('buildMatrix groups by species and uses the gene itself for its own species', () => {
	const genes = [{ id: 1, identifier: 'HGNC:1', symbol: 'TP53', species: 'H. sapiens' }];
	const orth = [[1, 2, 'Trp53', 'MGI:2', 'M. musculus'], [1, 3, 'Trp53b', 'MGI:3', 'M. musculus']];
	const pheno = [[1, 'p0'], [2, 'p1'], [2, 'p2'], [3, 'p3']];
	const dis = [
		[1, 'is_implicated_in', 'd0'],
		[2, 'implicated_via_orthology', 'dx'],
		[3, 'is_not_implicated_in', 'dy'],
		[3, 'is_marker_for', 'd1']
	];
	const m = tool.buildMatrix(genes, orth, pheno, dis);
	const own = m.cells[1]['H. sapiens'];
	assert.deepStrictEqual([own.phenotypes, own.diseases], [1, 1]);
	const mm = m.cells[1]['M. musculus'];
	assert.deepStrictEqual([mm.phenotypes, mm.diseases], [3, 1]);
	assert.deepStrictEqual(mm.genes.map((g) => g.symbol), ['Trp53', 'Trp53b']);
});

function stubFetch(log) {
	globalThis.fetch = async (url, init) => {
		const q = decodeURIComponent(init.body.split('query=')[1]);
		log.push({ url, init, q });
		let results = [];
		if (q.includes('view="Organism.shortName"')) results = [['H. sapiens'], ['M. musculus']];
		else if (q.includes('view="Gene.id')) results = [[1, 'HGNC:1', 'TP53', 'H. sapiens'], [5, 'HGNC:5', 'AAA', 'H. sapiens']];
		else if (q.includes('Homologue.gene.id')) results = [[1, 2, 'Trp53', 'MGI:2', 'M. musculus']];
		else if (q.includes('PhenotypeAnnotation')) results = [[2, 'abnormal x'], [1, 'p']];
		else if (q.includes('DiseaseAnnotation')) results = [[1, 'is_implicated_in', 'cancer'], [2, 'implicated_via_orthology', 'skip']];
		return { ok: true, json: async () => ({ results }) };
	};
}

test('main renders grid, aria labels, notes and detail on click', async () => {
	const log = [];
	stubFetch(log);
	const el = document.createElement('div');
	tool.main(el, { root: 'http://h/mine' }, { Gene: { value: [1, 5] } }, {}, {}, () => {});
	await tick();
	assert.ok(log.every((l) => l.url === 'http://h/mine/service/query/results' && l.init.method === 'POST'));
	assert.strictEqual(log.length, 5);
	const text = el.textContent;
	assert.ok(text.includes('H. sapiens') && text.includes('M. musculus'));
	assert.ok(text.includes('MP, WBPhenotype, FBcv, ZP, HP'));
	const buttons = el.find('button');
	assert.deepStrictEqual(buttons.map((b) => b.textContent), ['0 / 0', '1 / 1', '1 / 0']);
	assert.ok(buttons[2].attrs['aria-label'].includes('Trp53'));
	buttons[2].listeners.click();
	assert.ok(el.textContent.includes('abnormal x'));
	assert.ok(!el.textContent.includes('skip'));
});

test('main caps at 200 genes and shows a message', async () => {
	const log = [];
	stubFetch(log);
	const ids = Array.from({ length: 250 }, (_, i) => i + 1);
	const el = document.createElement('div');
	tool.main(el, { root: 'http://h/mine' }, { Gene: { value: ids } }, {}, {}, () => {});
	await tick();
	const geneQ = log.find((l) => l.q.includes('view="Gene.id'));
	assert.strictEqual((geneQ.q.match(/<value>/g) || []).length, 200);
	assert.ok(el.textContent.includes('Showing the first 200 of 250 genes.'));
});

test('main logs and shows a message on failure', async () => {
	const errs = [];
	const orig = console.error;
	console.error = (...a) => errs.push(a);
	globalThis.fetch = async () => ({ ok: false, status: 500 });
	const el = document.createElement('div');
	tool.main(el, { root: 'http://h/mine' }, { Gene: { value: 1 } }, {}, {}, () => {});
	await tick();
	console.error = orig;
	assert.ok(el.textContent.includes('Could not load the species matrix'));
	assert.ok(errs.length >= 1);
});

test('a stale response does not overwrite a newer call', async () => {
	const log = [];
	stubFetch(log);
	const el = document.createElement('div');
	tool.main(el, { root: 'http://h/mine' }, { Gene: { value: 1 } }, {}, {}, () => {});
	el.__agrMatrixReq += 1;
	await tick();
	assert.ok(el.textContent.includes('Loading...'));
});
