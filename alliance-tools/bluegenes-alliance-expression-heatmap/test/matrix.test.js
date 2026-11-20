'use strict';
const test = require('node:test');
const assert = require('node:assert');
const tool = require('../dist/bundle.js');

// gene, symbol, annotation id, anatomy name, anatomy id, stage
const r = (gene, ann, name, aid, stage) => [gene, gene.toLowerCase(), ann, name, aid, stage];
const rows = (list) => list.map(tool.toRow);

const sample = rows([
	r('G1', 1, 'liver', 'UBERON:1', 'adult'),
	r('G1', 2, 'liver', 'UBERON:1', 'adult'),
	r('G1', 3, 'brain', 'UBERON:2', 'embryo'),
	r('G2', 4, 'liver', 'UBERON:1', 'embryo'),
	r('G2', 5, 'heart', 'UBERON:3', 'adult'),
	r('G3', 6, 'heart', 'UBERON:3', 'adult'),
	r('G3', 7, 'liver', 'UBERON:1', null)
]);

test('toRow reads the view columns', () => {
	assert.deepStrictEqual(tool.toRow(r('G1', 9, 'liver', 'UBERON:1', 'adult')), {
		gene: 'G1', symbol: 'g1', annotation: 9, anatomy: 'liver', anatomyId: 'UBERON:1', stage: 'adult', geneId: undefined
	});
});

test('dedupeRows keeps one row per gene and annotation id', () => {
	const dup = sample.concat(sample.slice(0, 2));
	assert.strictEqual(tool.dedupeRows(dup).length, 7);
});

test('stagesOf lists distinct stages sorted, with a label for missing', () => {
	assert.deepStrictEqual(tool.stagesOf(sample), ['adult', 'embryo', 'Unspecified stage']);
});

test('buildMatrix counts annotations per gene and anatomy term', () => {
	const m = tool.buildMatrix(sample, { limit: 40 });
	assert.deepStrictEqual(m.genes.map((g) => g.id), ['G1', 'G2', 'G3']);
	const liver = m.terms.find((t) => t.name === 'liver');
	assert.deepStrictEqual(liver.counts, { G1: 2, G2: 1, G3: 1 });
	assert.strictEqual(liver.total, 4);
	assert.strictEqual(liver.coverage, 3);
});

test('rankTerms orders by gene coverage, then total, then name', () => {
	const m = tool.buildMatrix(sample, { limit: 40 });
	assert.deepStrictEqual(m.terms.map((t) => t.name), ['liver', 'heart', 'brain']);
});

test('rankTerms breaks a coverage tie by total annotations', () => {
	const extra = sample.concat(rows([r('G2', 8, 'brain', 'UBERON:2', 'adult'), r('G2', 9, 'brain', 'UBERON:2', 'adult')]));
	const m = tool.buildMatrix(extra, { limit: 40 });
	assert.deepStrictEqual(m.terms.map((t) => t.name), ['liver', 'brain', 'heart']);
});

test('buildMatrix keeps the top N terms and reports the rest', () => {
	const m = tool.buildMatrix(sample, { limit: 2 });
	assert.deepStrictEqual(m.terms.map((t) => t.name), ['liver', 'heart']);
	assert.strictEqual(m.hidden, 1);
});

test('buildMatrix limits to 40 terms by default', () => {
	const many = [];
	for (let i = 0; i < 55; i++) many.push(r('G1', i, 'term' + i, 'T:' + i, 'adult'));
	const m = tool.buildMatrix(rows(many), {});
	assert.strictEqual(m.terms.length, 40);
	assert.strictEqual(m.hidden, 15);
});

test('stage filter drops other stages before ranking', () => {
	const m = tool.buildMatrix(sample, { stage: 'adult', limit: 40 });
	assert.deepStrictEqual(m.terms.map((t) => t.name), ['heart', 'liver']);
	const heart = m.terms.find((t) => t.name === 'heart');
	assert.deepStrictEqual(heart.counts, { G2: 1, G3: 1 });
	assert.deepStrictEqual(m.genes.map((g) => g.id), ['G1', 'G2', 'G3']);
});

test('stage filter on the missing-stage label matches null stages', () => {
	const m = tool.buildMatrix(sample, { stage: 'Unspecified stage', limit: 40 });
	assert.deepStrictEqual(m.terms.map((t) => t.name), ['liver']);
});

test('rows without an anatomy term group under one label', () => {
	const m = tool.buildMatrix(rows([r('G1', 1, null, null, 'adult')]), {});
	assert.strictEqual(m.terms[0].name, 'Unspecified anatomy');
});

test('maxCount is the largest cell', () => {
	assert.strictEqual(tool.buildMatrix(sample, {}).max, 2);
});

test('sortTerms by gene column, descending then ascending', () => {
	const m = tool.buildMatrix(sample, {});
	assert.deepStrictEqual(tool.sortTerms(m.terms, 'gene:G1', 'desc').map((t) => t.name), ['liver', 'brain', 'heart']);
	assert.strictEqual(tool.sortTerms(m.terms, 'gene:G3', 'asc')[0].name, 'brain');
});

test('sortTerms by name, total and coverage; input is not mutated', () => {
	const m = tool.buildMatrix(sample, {});
	const before = m.terms.map((t) => t.name);
	assert.deepStrictEqual(tool.sortTerms(m.terms, 'name', 'asc').map((t) => t.name), ['brain', 'heart', 'liver']);
	assert.deepStrictEqual(tool.sortTerms(m.terms, 'total', 'desc').map((t) => t.name)[0], 'liver');
	assert.deepStrictEqual(tool.sortTerms(m.terms, 'coverage', 'asc').map((t) => t.name)[0], 'brain');
	assert.deepStrictEqual(m.terms.map((t) => t.name), before);
});

test('toCsv writes a header, one row per term and quotes commas and quotes', () => {
	const m = tool.buildMatrix(rows([r('G1', 1, 'a, "b"', 'T:1', 'adult'), r('G2', 2, 'a, "b"', 'T:1', 'adult')]), {});
	const lines = tool.toCsv(m.genes, m.terms).split('\r\n');
	assert.strictEqual(lines[0], 'Anatomy term,Anatomy ID,G1,G2,Total,Genes');
	assert.strictEqual(lines[1], '"a, ""b""",T:1,1,1,2,2');
});

test('toCsv labels genes by symbol when present', () => {
	const m = tool.buildMatrix(rows([r('G1', 1, 'x', 'T:1', 'a')]), {});
	assert.strictEqual(tool.toCsv(m.genes, m.terms, true).split('\r\n')[0], 'Anatomy term,Anatomy ID,g1,Total,Genes');
});

test('toCsv guards against formulas', () => {
	const m = tool.buildMatrix(rows([r('G1', 1, '=cmd', 'T:1', 'a')]), {});
	assert.ok(tool.toCsv(m.genes, m.terms).split('\r\n')[1].startsWith("'=cmd,"));
});
