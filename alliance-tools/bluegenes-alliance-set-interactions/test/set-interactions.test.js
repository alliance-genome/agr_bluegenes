'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { install } = require('./dom-stub.js');
install();
const tool = require('../dist/bundle.js');

// view: g1.id, g1.pid, g1.symbol, g2.id, g2.pid, g2.symbol, relation, method, pmid
const PHYS = 'physically_interacts_with';
const GEN = 'genetically_interacts_with';
const ROWS = [
	[1, 'HGNC:1', 'AAA', 2, 'HGNC:2', 'BBB', PHYS, 'two hybrid', '111'],
	[2, 'HGNC:2', 'BBB', 1, 'HGNC:1', 'AAA', PHYS, 'two hybrid', '222'],
	[1, 'HGNC:1', 'AAA', 3, 'HGNC:3', 'CCC', PHYS, 'pull down', '333'],
	[1, 'HGNC:1', 'AAA', 4, 'HGNC:4', 'DDD', GEN, 'synthetic lethality', null],
	[3, 'HGNC:3', 'CCC', 4, 'HGNC:4', 'DDD', PHYS, 'pull down', '444'],
	[1, 'HGNC:1', 'AAA', 1, 'HGNC:1', 'AAA', PHYS, 'two hybrid', '555']
];

test('buildEdges merges both directions and publications, drops self loops', () => {
	const edges = tool.buildEdges(ROWS);
	assert.strictEqual(edges.length, 4);
	const ab = edges.find((e) => e.a.pid === 'HGNC:1' && e.b.pid === 'HGNC:2');
	assert.deepStrictEqual(ab.pmids, ['111', '222']);
	assert.strictEqual(ab.relation, PHYS);
});

test('filterEdges filters by relation and detection method', () => {
	const edges = tool.buildEdges(ROWS);
	assert.strictEqual(tool.filterEdges(edges, { relation: GEN }).length, 1);
	assert.strictEqual(tool.filterEdges(edges, { method: 'pull down' }).length, 2);
	assert.strictEqual(tool.filterEdges(edges, { relation: PHYS, method: 'pull down' }).length, 2);
	assert.strictEqual(tool.filterEdges(edges, { relation: GEN, method: 'pull down' }).length, 0);
	assert.strictEqual(tool.filterEdges(edges, {}).length, 4);
});

test('degreeRanking counts distinct neighbours and sorts by degree then symbol', () => {
	const ranking = tool.degreeRanking(tool.buildEdges(ROWS));
	assert.deepStrictEqual(
		ranking.map((r) => [r.node.symbol, r.degree]),
		[['AAA', 3], ['CCC', 2], ['DDD', 2], ['BBB', 1]]
	);
});

test('degreeRanking counts a neighbour once across relations', () => {
	const rows = ROWS.concat([[1, 'HGNC:1', 'AAA', 2, 'HGNC:2', 'BBB', GEN, 'x', null]]);
	const top = tool.degreeRanking(tool.buildEdges(rows))[0];
	assert.strictEqual(top.degree, 3);
});

test('toSif writes one tab separated line per pair and relation', () => {
	const sif = tool.toSif(tool.buildEdges(ROWS));
	assert.deepStrictEqual(sif.split('\n').sort(), [
		'AAA\tgenetically_interacts_with\tDDD',
		'AAA\tphysically_interacts_with\tBBB',
		'AAA\tphysically_interacts_with\tCCC',
		'CCC\tphysically_interacts_with\tDDD'
	]);
});

test('toSif falls back to the identifier and removes whitespace', () => {
	const rows = [[1, 'HGNC:1', 'A B', 2, 'HGNC:2', '', PHYS, 'm', null]];
	assert.strictEqual(tool.toSif(tool.buildEdges(rows)), 'A_B\tphysically_interacts_with\tHGNC:2');
});

test('toTsv has a header and one row per edge', () => {
	const lines = tool.toTsv(tool.buildEdges(ROWS)).split('\n');
	assert.strictEqual(lines[0], 'gene_a\tgene_b\trelation\tdetection_method\tpubmed_ids');
	assert.strictEqual(lines.length, 5);
	assert.ok(lines.includes('AAA\tBBB\tphysically_interacts_with\ttwo hybrid\t111,222'));
});

test('circularLayout caps nodes at the limit and keeps only edges among them', () => {
	const rows = [];
	for (let i = 1; i <= 200; i++) rows.push([1, 'H:0', 'HUB', i + 1, 'H:' + i, 'G' + i, PHYS, 'm', null]);
	const lay = tool.circularLayout(tool.buildEdges(rows), 150);
	assert.strictEqual(lay.nodes.length, 150);
	assert.strictEqual(lay.nodes[0].node.symbol, 'HUB');
	assert.strictEqual(lay.links.length, 149);
	assert.ok(lay.nodes.every((n) => isFinite(n.x) && isFinite(n.y)));
});

test('buildSetQuery constrains both ends to the set and escapes values', () => {
	const q = tool.buildSetQuery([1, 2, 3]);
	assert.ok(q.indexOf('path="Gene.id" op="ONE OF"') > -1);
	assert.ok(q.indexOf('path="Gene.interactions.participant2.id" op="ONE OF"') > -1);
	assert.ok(q.indexOf('Gene.interactions.details.experiment.publication.pubMedId') > -1);
	assert.strictEqual((q.match(/<value>3<\/value>/g) || []).length, 2);
});

test('hubIds returns the top-degree gene ids', () => {
	const ids = tool.hubIds(tool.degreeRanking(tool.buildEdges(ROWS)), 2);
	assert.deepStrictEqual(ids, [1, 3]);
});

const tick = () => new Promise((r) => setTimeout(r, 20));

function run(context, rows) {
	const calls = [];
	globalThis.fetch = (url, opts) => {
		calls.push({ url, opts });
		return Promise.resolve({ ok: true, json: () => Promise.resolve({ results: rows }) });
	};
	const el = document.createElement('div');
	tool.main(el, { root: 'http://h/mine' }, { Gene: { value: [1, 2, 3, 4], class: 'Gene' } }, {}, {}, () => {}, context);
	return { el, calls };
}

test('main posts one query to the service root and shows the edge count', async () => {
	const { el, calls } = run(undefined, ROWS);
	await tick();
	assert.strictEqual(calls.length, 1);
	assert.strictEqual(calls[0].url, 'http://h/mine/service/query/results');
	assert.strictEqual(calls[0].opts.method, 'POST');
	assert.ok(/4 edges/.test(el.textContent));
	assert.ok(!/Save hubs/.test(el.textContent));
});

test('main offers hub saving only when context.saveList exists', async () => {
	const saved = [];
	const context = { list: { title: 'My list' }, saveList: (o) => { saved.push(o); return Promise.resolve('n'); } };
	const { el } = run(context, ROWS);
	await tick();
	assert.ok(/Save hubs/.test(el.textContent));
	const btn = el.find('button').find((b) => /Save hubs/.test(b.textContent));
	btn.listeners.click();
	await tick();
	assert.strictEqual(saved.length, 1);
	assert.strictEqual(saved[0].class, 'Gene');
	assert.deepStrictEqual(saved[0].ids, [1, 3, 4, 2]);
});

test('main asks for a set when one gene is given', async () => {
	globalThis.fetch = () => { throw new Error('no fetch expected'); };
	const el = document.createElement('div');
	tool.main(el, { root: 'http://h/mine' }, { Gene: { value: 5 } }, {}, {}, () => {});
	assert.ok(/at least 2 genes/.test(el.textContent));
});

test('main reports an empty network', async () => {
	const { el } = run(undefined, []);
	await tick();
	assert.ok(/No interactions among these genes/.test(el.textContent));
});
