'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { install } = require('./dom-stub.js');
install();
const tool = require('../dist/bundle.js');

const TYPES = tool.TYPES;
const types = (...keys) => TYPES.filter((t) => keys.includes(t.key));

test('countRows counts distinct annotations per gene and ignores null ids', () => {
	const counts = tool.countRows([[1, 10], [1, 11], [1, 11], [2, 20], [3, null]]);
	assert.deepStrictEqual(counts, { 1: 2, 2: 1 });
});

test('countQuery uses an inner join, the collection path and both sort keys', () => {
	const q = tool.countQuery(TYPES[0], ['1', '2']);
	assert.ok(q.includes('view="Gene.id Gene.goAnnotation.id"'));
	assert.ok(q.includes('sortOrder="Gene.id asc Gene.goAnnotation.id asc"'));
	assert.ok(!q.includes('OUTER'));
	assert.ok(q.includes('<value>1</value><value>2</value>'));
});

test('infoQuery joins the organism as OUTER and sorts by gene id', () => {
	const q = tool.infoQuery(['5']);
	assert.ok(q.includes('<join path="Gene.organism" style="OUTER"/>'));
	assert.ok(q.includes('sortOrder="Gene.id asc"'));
});

test('chunks splits ids into pages of the given size', () => {
	assert.deepStrictEqual(tool.chunks([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
	assert.deepStrictEqual(tool.chunks([], 2), []);
});

const info = [[1, 'FB:1', 'a', 'D. melanogaster'], [2, 'FB:2', 'b', 'D. melanogaster'], [3, 'MGI:3', 'c', 'M. musculus'], [4, 'MGI:4', null, null]];
const ts = types('go', 'disease');
const genes = tool.buildGenes(info, ts, { go: { 1: 4, 3: 1 }, disease: { 1: 2, 2: 1 } });

test('buildGenes fills zero counts and sorts by organism then symbol', () => {
	assert.deepStrictEqual(genes.map((g) => g.id), [1, 2, 3, 4]);
	const g2 = genes.find((g) => g.id === 2);
	assert.deepStrictEqual(g2.counts, { go: 0, disease: 1 });
	const g4 = genes.find((g) => g.id === 4);
	assert.strictEqual(g4.organism, 'Unknown species');
	assert.strictEqual(g4.symbol, 'MGI:4');
});

test('coverage gives per-organism shares of genes with at least one annotation', () => {
	const cov = tool.coverage(genes, ts);
	const fly = cov.find((o) => o.organism === 'D. melanogaster');
	assert.strictEqual(fly.genes, 2);
	assert.deepStrictEqual(fly.covered, { go: 1, disease: 2 });
	assert.strictEqual(fly.share.go, 0.5);
	assert.strictEqual(fly.share.disease, 1);
	const mouse = cov.find((o) => o.organism === 'M. musculus');
	assert.deepStrictEqual(mouse.share, { go: 1, disease: 0 });
});

test('withoutType returns genes with a zero count', () => {
	assert.deepStrictEqual(tool.withoutType(genes, 'go').map((g) => g.id).sort(), [2, 4]);
});

test('toCsv writes a header, counts and quotes fields with commas', () => {
	const csv = tool.toCsv([{ identifier: 'X:1', symbol: 'a,b', organism: 'S', counts: { go: 3, disease: 0 } }], ts);
	assert.strictEqual(csv, 'Gene,Symbol,Organism,GO,Disease\r\nX:1,"a,b",S,3,0\r\n');
});

test('listName embeds the type and a timestamp', () => {
	assert.strictEqual(tool.listName(TYPES[0], new Date('2026-11-19T10:20:30Z')), 'genes_without_go_annotations_20261119102030');
});
