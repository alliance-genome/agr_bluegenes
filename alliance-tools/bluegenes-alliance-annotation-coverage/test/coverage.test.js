'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { install } = require('./dom-stub.js');
install();
const tool = require('../dist/bundle.js');
const { model } = require('./mine-stub.js');

const TYPES = tool.TYPES;
const types = (...keys) => TYPES.filter((t) => keys.includes(t.key));

test('every type maps to a Gene collection id path that exists in the live model', () => {
	const service = { model };
	assert.strictEqual(tool.typesFor(service).length, 5);
	TYPES.forEach((t) => assert.ok(tool.hasPath(service, 'Gene.' + t.collection + '.id'), t.collection));
});

test('presenceQuery tests the type collection for NOT NULL and returns one gene id per row', () => {
	TYPES.forEach((t) => {
		const q = tool.presenceQuery(t, ['1', '2']);
		assert.ok(q.includes('view="Gene.id"'), t.key);
		assert.ok(q.includes('<constraint path="Gene.' + t.collection + '" op="IS NOT NULL"/>'), t.key);
		assert.ok(q.includes('<value>1</value><value>2</value>'));
		assert.ok(!q.includes('OUTER'));
	});
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
const genes = tool.buildGenes(info, ts, { go: { 1: true, 3: true }, disease: { 1: true, 2: true } });

test('buildGenes sets has per type, sorts by organism then symbol, and leaves unloaded types unset', () => {
	assert.deepStrictEqual(genes.map((g) => g.id), [1, 2, 3, 4]);
	assert.deepStrictEqual(genes.find((g) => g.id === 2).has, { go: false, disease: true });
	const g4 = genes.find((g) => g.id === 4);
	assert.strictEqual(g4.organism, 'Unknown species');
	assert.strictEqual(g4.symbol, 'MGI:4');
	const partial = tool.buildGenes(info, ts, { go: { 1: true } });
	assert.deepStrictEqual(partial[0].has, { go: true });
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

test('coverage marks a type as none only for an organism of 20 or more genes with no annotation', () => {
	const make = (n, hit) => Array.from({ length: n }, (_, i) => ({ organism: 'H. sapiens', has: { alleles: i < hit } }));
	const t = types('alleles');
	assert.strictEqual(tool.coverage(make(20, 0), t)[0].none.alleles, true);
	assert.strictEqual(tool.coverage(make(19, 0), t)[0].none.alleles, false);
	assert.strictEqual(tool.coverage(make(20, 1), t)[0].none.alleles, false);
});

test('withoutType returns only genes known to lack the type', () => {
	assert.deepStrictEqual(tool.withoutType(genes, 'go').map((g) => g.id).sort(), [2, 4]);
	const unloaded = tool.buildGenes(info, ts, { go: { 1: true } });
	assert.deepStrictEqual(tool.withoutType(unloaded, 'disease'), []);
});

test('matches handles a type, any and all', () => {
	const g = { has: { go: true, disease: false } };
	assert.strictEqual(tool.matches(g, '', ts), true);
	assert.strictEqual(tool.matches(g, 'disease', ts), true);
	assert.strictEqual(tool.matches(g, 'go', ts), false);
	assert.strictEqual(tool.matches(g, 'any', ts), true);
	assert.strictEqual(tool.matches(g, 'all', ts), false);
	assert.strictEqual(tool.matches({ has: { go: false, disease: false } }, 'all', ts), true);
});

test('toCsv writes yes and no, quotes commas and neutralises formula prefixes', () => {
	const csv = tool.toCsv([{ identifier: 'X:1', symbol: 'a,b', organism: 'S', has: { go: true, disease: false } }, { identifier: '=X', symbol: '@s', organism: 'S', has: {} }], ts);
	assert.strictEqual(csv, "Gene,Symbol,Organism,GO,Disease\r\nX:1,\"a,b\",S,yes,no\r\n'=X,'@s,S,,\r\n");
});

test('listName embeds the type, the organism and a timestamp', () => {
	const now = new Date('2026-11-19T10:20:30Z');
	assert.strictEqual(tool.listName(TYPES[0], now), 'genes_without_go_annotations_20261119102030');
	assert.strictEqual(tool.listName('alleles', now, 'H. sapiens'), 'genes_without_alleles_annotations_h_sapiens_20261119102030');
	assert.strictEqual(tool.listName('any', now), 'genes_missing_any_annotation_type_20261119102030');
});
