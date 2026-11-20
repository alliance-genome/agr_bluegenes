const test = require('node:test');
const assert = require('node:assert');
const m = require('../dist/bundle.js');

// view order: gene id, gene identifier, symbol, annotation id, term, slim, evidenceType, via order, qualifier, code, pmid
const ROWS = [
	[1, 'HGNC:1', 'AAA', 10, 'breast cancer', 'cancer', 'IEA', null, 'is_implicated_in', 'ECO:1', '111'],
	[1, 'HGNC:1', 'AAA', 10, 'breast cancer', 'cancer', 'IEA', null, 'is_implicated_in', 'ECO:2', '111'],
	[1, 'HGNC:1', 'AAA', 10, 'breast cancer', 'cancer', 'IEA', null, 'is_implicated_in', 'ECO:1', '222'],
	[1, 'HGNC:1', 'AAA', 11, 'anemia', 'blood', 'TAS', 1, 'implicated_via_orthology', null, null],
	[2, 'HGNC:2', 'BBB', 12, 'lung cancer', 'cancer', 'TAS', null, 'is_implicated_in', 'ECO:3', '333'],
	[2, 'HGNC:2', 'BBB', 13, 'unclassified', null, null, null, null, null, null]
];

test('toAnnotations merges rows of one annotation and collects codes and PMIDs', () => {
	const a = m.toAnnotations(ROWS);
	assert.strictEqual(a.length, 4);
	const first = a.find((x) => x.id === 10);
	assert.deepStrictEqual(first.codes, ['ECO:1', 'ECO:2']);
	assert.deepStrictEqual(first.pmids, ['111', '222']);
	assert.deepStrictEqual(first.slims, ['cancer']);
	assert.strictEqual(first.symbol, 'AAA');
});

test('isViaOrthology uses viaOrthologyOrder or a via_orthology qualifier', () => {
	assert.strictEqual(m.isViaOrthology({ via: 1, qualifier: null }), true);
	assert.strictEqual(m.isViaOrthology({ via: null, qualifier: 'implicated_via_orthology' }), true);
	assert.strictEqual(m.isViaOrthology({ via: null, qualifier: 'is_implicated_in' }), false);
});

test('filterAnnotations by evidence type and orthology mode', () => {
	const a = m.toAnnotations(ROWS);
	assert.strictEqual(m.filterAnnotations(a, { evidenceType: 'TAS', via: 'all' }).length, 2);
	assert.strictEqual(m.filterAnnotations(a, { evidenceType: '', via: 'only' }).length, 1);
	assert.strictEqual(m.filterAnnotations(a, { evidenceType: '', via: 'exclude' }).length, 3);
	assert.strictEqual(m.filterAnnotations(a, { evidenceType: m.NO_VALUE, via: 'all' }).length, 1);
	assert.strictEqual(m.filterAnnotations(a, { evidenceType: '', via: 'all' }).length, 4);
});

test('evidenceTypes lists distinct values', () => {
	assert.deepStrictEqual(m.evidenceTypes(m.toAnnotations(ROWS)), ['IEA', 'TAS', m.NO_VALUE]);
});

test('pivot counts annotations per gene and slim term', () => {
	const p = m.pivot(m.toAnnotations(ROWS));
	assert.deepStrictEqual(p.cols.map((c) => [c.slim, c.count, c.genes.length]), [
		['blood', 1, 1], ['cancer', 2, 2], [m.NO_SLIM, 1, 1]
	]);
	const aaa = p.rows.find((r) => r.symbol === 'AAA');
	assert.strictEqual(aaa.total, 2);
	assert.strictEqual(aaa.cells.cancer.length, 1);
	assert.strictEqual(aaa.cells.blood.length, 1);
	assert.strictEqual(p.rows.find((r) => r.symbol === 'BBB').cells[m.NO_SLIM].length, 1);
});

test('an annotation with two slim terms counts once in each column and once in the total', () => {
	const a = m.toAnnotations([
		[1, 'G:1', 'AAA', 5, 't', 's1', null, null, null, null, null],
		[1, 'G:1', 'AAA', 5, 't', 's2', null, null, null, null, null]
	]);
	const p = m.pivot(a);
	assert.strictEqual(p.rows[0].total, 1);
	assert.strictEqual(p.cols.length, 2);
});

test('sortRows by symbol, total and column count', () => {
	const p = m.pivot(m.toAnnotations(ROWS));
	assert.deepStrictEqual(m.sortRows(p.rows, 'symbol', 1).map((r) => r.symbol), ['AAA', 'BBB']);
	assert.deepStrictEqual(m.sortRows(p.rows, 'symbol', -1).map((r) => r.symbol), ['BBB', 'AAA']);
	assert.deepStrictEqual(m.sortRows(p.rows, 'blood', -1).map((r) => r.symbol), ['AAA', 'BBB']);
	assert.deepStrictEqual(m.sortRows(p.rows, 'blood', 1).map((r) => r.symbol), ['BBB', 'AAA']);
	assert.deepStrictEqual(m.sortRows(p.rows, m.TOTAL, -1).map((r) => r.total), [2, 2]);
});

test('sortCols by name and by count', () => {
	const p = m.pivot(m.toAnnotations(ROWS));
	assert.deepStrictEqual(m.sortCols(p.cols, 'name').map((c) => c.slim), ['blood', 'cancer', m.NO_SLIM]);
	assert.deepStrictEqual(m.sortCols(p.cols, 'count').map((c) => c.slim), ['cancer', 'blood', m.NO_SLIM]);
});

test('toCsv escapes fields and lists counts per column', () => {
	const p = m.pivot(m.toAnnotations([
		[1, 'HGNC:1', 'A,"B"', 1, 't', 'cancer', null, null, null, null, null]
	]));
	const csv = m.toCsv(m.sortRows(p.rows, 'symbol', 1), p.cols);
	assert.strictEqual(csv, 'Gene,Identifier,Total,cancer\r\n"A,""B""",HGNC:1,1,1\r\n');
});

test('cellDetails lists term, qualifier, codes and PMIDs', () => {
	const p = m.pivot(m.toAnnotations(ROWS));
	const d = m.cellDetails(p.rows.find((r) => r.symbol === 'AAA'), 'cancer');
	assert.deepStrictEqual(d, [{ term: 'breast cancer', qualifier: 'is_implicated_in', codes: ['ECO:1', 'ECO:2'], pmids: ['111', '222'] }]);
});

test('buildQuery has outer joins and Gene.id constraint', () => {
	const q = m.buildQuery([1, 2]);
	assert.match(q, /Gene\.id" op="ONE OF"/);
	assert.match(q, /<join path="Gene\.diseaseAnnotation\.slimTerms" style="OUTER"\/>/);
	assert.match(q, /<join path="Gene\.diseaseAnnotation\.evidence\.publications" style="OUTER"\/>/);
	assert.match(m.buildQuery(7), /op="=" value="7"/);
});

test('serviceRoot appends /service once', () => {
	assert.strictEqual(m.serviceRoot('https://x/mine/'), 'https://x/mine/service');
	assert.strictEqual(m.serviceRoot('https://x/mine/service'), 'https://x/mine/service');
});
