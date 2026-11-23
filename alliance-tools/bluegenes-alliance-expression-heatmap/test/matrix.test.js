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
		gene: 'G1', symbol: 'g1', annotation: 9, anatomy: 'liver', anatomyId: 'UBERON:1', stage: 'adult', geneId: undefined, source: undefined, organism: undefined
	});
});

test('dedupeRows keeps one row per gene and annotation id', () => {
	const dup = sample.concat(sample.slice(0, 2));
	assert.strictEqual(tool.dedupeRows(dup).length, 7);
});

test('stagesOf lists distinct stages in developmental order, with a label for missing', () => {
	assert.deepStrictEqual(tool.stagesOf(sample), ['embryo', 'adult', 'Unspecified stage']);
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

const live = require('./fixtures/live.json');

test('toRow reads source and organism from the live view', () => {
	const row = tool.toRow(live.page1[0]);
	assert.strictEqual(row.source, 'MGI');
	assert.strictEqual(row.organism, 'M. musculus');
	assert.strictEqual(row.geneId, 44178454);
});

test('stages sort by bucket and numerically, per organism', () => {
	const mk = (org, stage, n) => tool.toRow(['G' + org, 's', n, 'x', 'T:1', stage, 1, 'S', org]);
	const stageRows = [
		mk('Dm', 'embryonic stage 10', 1), mk('Dm', 'embryonic stage 2', 2), mk('Dm', 'adult', 3), mk('Dm', 'larval stage', 4),
		mk('Ce', 'adult Ce', 5), mk('Ce', 'L1 larva Ce', 6), mk('Ce', '2-fold embryo Ce', 7), mk('Ce', '1.5-fold embryo Ce', 8),
		mk('Mm', 'TS28', 9), mk('Mm', 'TS17', 10), mk('Mm', 'TS02', 11)
	];
	const groups = tool.stageGroups(stageRows);
	assert.deepStrictEqual(groups.map((g) => g.organism), ['Ce', 'Dm', 'Mm']);
	assert.deepStrictEqual(groups[0].stages, ['1.5-fold embryo Ce', '2-fold embryo Ce', 'L1 larva Ce', 'adult Ce']);
	assert.deepStrictEqual(groups[1].stages, ['embryonic stage 2', 'embryonic stage 10', 'larval stage', 'adult']);
	assert.deepStrictEqual(groups[2].stages, ['TS02', 'TS17', 'TS28']);
});

test('a stage group filter matches embryo stages of every organism', () => {
	const mk = (org, stage, n) => tool.toRow(['G' + org, 's', n, 'x', 'T:1', stage, 1, 'S', org]);
	const stageRows = [mk('Mm', 'TS17', 1), mk('Ce', '2-fold embryo Ce', 2), mk('Ce', 'adult Ce', 3), mk('Mm', 'TS28', 4)];
	const m = tool.buildMatrix(stageRows, { stage: 'bucket:embryo' });
	assert.strictEqual(m.terms[0].total, 2);
	assert.strictEqual(tool.buildMatrix(stageRows, { stage: 'bucket:adult' }).terms[0].total, 2);
});

test('metric stages counts a stage once however many records it has', () => {
	const live2 = rows([
		['G1', 'g', 59725747, 'brain', 'EMAPA:1', 'TS17', 1, 'MGI', 'M. musculus'],
		['G1', 'g', 59725748, 'brain', 'EMAPA:1', 'TS17', 1, 'MGI', 'M. musculus'],
		['G1', 'g', 59725749, 'brain', 'EMAPA:1', 'TS20', 1, 'MGI', 'M. musculus']
	]);
	const cell = (metric) => tool.buildMatrix(live2, { metric }).terms[0].counts.G1;
	assert.strictEqual(cell('annotations'), 3);
	assert.strictEqual(cell('stages'), 2);
	assert.strictEqual(cell('present'), 1);
	assert.deepStrictEqual(tool.buildMatrix(live2, {}).terms[0].sources, { G1: ['MGI'] });
});

test('genes without rows keep a column, ordered by organism then symbol', () => {
	const genes = live.info.map(tool.toGene);
	const m = tool.buildMatrix(rows(live.page1), { genes });
	assert.deepStrictEqual(m.genes.map((g) => g.id), ['HGNC:11998', 'MGI:97490', 'RGD:3258']);
	assert.deepStrictEqual(m.genes.map((g) => g.organism), ['H. sapiens', 'M. musculus', 'R. norvegicus']);
	assert.strictEqual(m.terms[0].counts['HGNC:11998'], undefined);
});

test('hideRoot drops root terms and search filters by name', () => {
	const rs = rows([r('G1', 1, 'C. elegans anatomical entity', 'WBbt:1', 'a'), r('G1', 2, 'whole organism', 'X:1', 'a'), r('G1', 3, 'liver', 'U:1', 'a')]);
	assert.strictEqual(tool.buildMatrix(rs, {}).terms.length, 3);
	assert.deepStrictEqual(tool.buildMatrix(rs, { hideRoot: true }).terms.map((t) => t.name), ['liver']);
	assert.deepStrictEqual(tool.buildMatrix(rs, { search: 'LIV' }).terms.map((t) => t.name), ['liver']);
});

test('allTerms keeps every ranked term while terms is limited', () => {
	const many = [];
	for (let i = 0; i < 55; i++) many.push(r('G1', i, 'term' + i, 'T:' + i, 'adult'));
	const m = tool.buildMatrix(rows(many), { limit: 40 });
	assert.strictEqual(m.terms.length, 40);
	assert.strictEqual(m.allTerms.length, 55);
});

test('binEdges grow geometrically so one large cell does not flatten the rest', () => {
	assert.deepStrictEqual(tool.binEdges(42), [2, 4, 9, 19, 42]);
	assert.deepStrictEqual(tool.binEdges(2), [1, 2]);
	assert.deepStrictEqual(tool.binEdges(1), [1]);
	assert.deepStrictEqual(tool.binEdges(0), []);
	const edges = tool.binEdges(42);
	assert.strictEqual(tool.level(0, edges), 0);
	assert.strictEqual(tool.level(1, edges), 1);
	assert.strictEqual(tool.level(5, edges), 3);
	assert.strictEqual(tool.level(42, edges), 5);
	assert.ok(tool.level(3, edges) > tool.level(2, edges));
});

test('toCsv puts the organism in the header so equal symbols stay apart', () => {
	const genes = [
		{ id: 'MGI:97490', symbol: 'Pax6', organism: 'M. musculus' },
		{ id: 'RGD:3258', symbol: 'Pax6', organism: 'R. norvegicus' }
	];
	const head = tool.toCsv(genes, [], true).split('\r\n')[0];
	assert.strictEqual(head, 'Anatomy term,Anatomy ID,Pax6 (M. musculus),Pax6 (R. norvegicus),Total,Genes');
});

test('csvFilename carries the stage', () => {
	assert.strictEqual(tool.csvFilename(''), 'expression-heatmap.csv');
	assert.strictEqual(tool.csvFilename('TS17'), 'expression-heatmap-ts17.csv');
	assert.strictEqual(tool.csvFilename('bucket:embryo'), 'expression-heatmap-embryo.csv');
});
