'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { install } = require('./dom-stub.js');
install();
const tool = require('../dist/bundle.js');

const [SELF, ORTH] = tool.SOURCES;

// Row layout: gene symbol, gene id, gene species, allele id, allele identifier, allele symbol,
// allele species, term id, term name, qualifier or statement, pubMedId.
const row = (gene, geneSpecies, aid, aident, asym, tid, tname, third, pmid) =>
	[gene, gene + '-id', geneSpecies, aid, aident, asym, geneSpecies, tid, tname, third, pmid];

const fakeEl = () => document.createElement('div');
const tick = () => new Promise((r) => setTimeout(r, 5));
const ok = (results) => ({ ok: true, json: async () => ({ results }) });

test('buildQuery escapes the gene id and uses outer joins', () => {
	const q = tool.buildQuery(SELF, 'disease', '1"><x/>&');
	assert.ok(q.includes('value="1&quot;&gt;&lt;x/&gt;&amp;"'));
	assert.ok(!q.includes('<x/>'));
	assert.ok(q.includes('path="Gene.id" op="="'));
	assert.ok(q.includes('Gene.alleles.diseaseAnnotations.evidence.publications.pubMedId'));
	assert.ok(q.includes('<join path="Gene.alleles.diseaseAnnotations.evidence.publications" style="OUTER"/>'));
});

test('buildQuery uses the ortholog and phenotype paths', () => {
	const q = tool.buildQuery(ORTH, 'phenotype', '7');
	assert.ok(q.includes('Gene.homologues.homologue.alleles.phenotypeAnnotations.phenotypeStatement'));
	assert.ok(q.includes('Gene.homologues.homologue.alleles.phenotypeAnnotations.publications.pubMedId'));
	assert.ok(q.includes('Gene.homologues.homologue.symbol'));
});

test('aggregate merges publication rows and sorts', () => {
	const rows = [
		row('Brca1', 'M. musculus', 2, 'MGI:2', 'b<2>', 'DOID:1', 'cancer', 'is_implicated_in', '30'),
		row('Brca1', 'M. musculus', 2, 'MGI:2', 'b<2>', 'DOID:1', 'cancer', 'is_implicated_in', '5'),
		row('Brca1', 'M. musculus', 2, 'MGI:2', 'b<2>', 'DOID:1', 'cancer', 'is_implicated_in', '5'),
		row('Atm', 'H. sapiens', 1, 'HGNC:1', 'a1', 'DOID:1', 'cancer', null, null)
	].map((r) => tool.toRow(ORTH, 'disease', r));
	const agg = tool.aggregate(rows);
	assert.deepStrictEqual(agg.map((e) => e.species), ['H. sapiens', 'M. musculus']);
	assert.deepStrictEqual(agg[1].pubs, ['5', '30']);
	assert.deepStrictEqual(agg[0].pubs, []);
});

test('termCounts counts distinct alleles and filterTerms searches label and id', () => {
	const rows = [
		row('g', 'M. musculus', 1, 'A1', 'a1', 'MP:1', 'edema', 's1', '1'),
		row('g', 'M. musculus', 1, 'A1', 'a1', 'MP:1', 'edema', 's1', '2'),
		row('g', 'M. musculus', 2, 'A2', 'a2', 'MP:1', 'edema', 's1', '3'),
		row('g', 'M. musculus', 2, 'A2', 'a2', null, null, 'dry skin', null)
	].map((r) => tool.toRow(SELF, 'phenotype', r));
	const terms = tool.termCounts(tool.aggregate(rows));
	assert.deepStrictEqual(terms.map((t) => [t.label, t.count]), [['edema', 2], ['dry skin', 1]]);
	assert.deepStrictEqual(tool.filterTerms(terms, 'EDE').map((t) => t.key), ['MP:1']);
	assert.deepStrictEqual(tool.filterTerms(terms, 'mp:1').length, 1);
	assert.strictEqual(tool.filterTerms(terms, '').length, 2);
});

function routeFetch(map, calls) {
	return async (url, init) => {
		const body = decodeURIComponent(init.body);
		calls.push({ url, init, body });
		const source = body.includes('homologues') ? 'ortholog' : 'self';
		const kind = body.includes('diseaseAnnotations') ? 'disease' : 'phenotype';
		return ok(map[source + ':' + kind] || []);
	};
}

test('main fetches four queries, renders, filters by term and switches kind', async () => {
	const calls = [];
	globalThis.fetch = routeFetch(
		{
			'self:disease': [row('Brca1', 'M. musculus', 10, 'MGI:10', 'Brca1<a>', 'DOID:1612', 'breast cancer', 'is_implicated_in', '111')],
			'ortholog:disease': [
				row('BRCA1', 'H. sapiens', 11, 'HGNC:11', 'BRCA1-v', 'DOID:1612', 'breast cancer', 'is_marker_for', '222'),
				row('Atm', 'M. musculus', 12, 'MGI:12', 'Atm1', 'DOID:0001', 'ataxia', null, null)
			],
			'self:phenotype': [row('Brca1', 'M. musculus', 10, 'MGI:10', 'Brca1<a>', 'MP:1', 'edema', 'edema', '333')]
		},
		calls
	);
	const el = fakeEl();
	const nav = [];
	tool.main(el, { root: 'http://h/mine' }, { Gene: { value: '42' } }, {}, {}, (...a) => nav.push(a));
	await tick();
	assert.strictEqual(calls.length, 4);
	assert.ok(calls.every((c) => c.url === 'http://h/mine/service/query/results' && c.init.method === 'POST'));
	assert.ok(calls.every((c) => c.body.includes('value="42"')));

	let text = el.textContent;
	assert.ok(text.includes('Disease (3)'));
	assert.ok(text.includes('Phenotype (1)'));
	assert.ok(text.includes('3 alleles with disease annotations, 2 terms, 2 species'));
	assert.ok(text.includes('Brca1<a>'));
	assert.ok(text.includes('Brca1 (this gene)'));

	const pm = el.find('a').filter((a) => a.href && a.href.startsWith('https://pubmed.ncbi.nlm.nih.gov/'));
	assert.deepStrictEqual(pm.map((a) => a.href).sort(), [
		'https://pubmed.ncbi.nlm.nih.gov/111/',
		'https://pubmed.ncbi.nlm.nih.gov/222/'
	]);

	// allele click navigates to the Allele report
	const alleleLink = el.find('a').find((a) => a.textContent === 'Brca1<a>');
	alleleLink.listeners.click({ preventDefault() {} });
	assert.deepStrictEqual(nav[0], ['report', { type: 'Allele', id: 10 }]);

	// term picker lists terms with counts
	const select = el.find('select')[0];
	const labels = select.children.map((o) => o.textContent);
	assert.strictEqual(labels[0], 'All terms (2)');
	assert.ok(labels.includes('breast cancer (DOID:1612) - 2 alleles'));

	// choose a term
	select.value = 'DOID:0001';
	select.listeners.change();
	text = el.textContent;
	assert.ok(text.includes('1 alleles with disease annotations, 1 terms, 1 species'));
	assert.ok(!text.includes('Brca1<a>'));

	// search narrows options
	const input = el.find('input')[0];
	input.value = 'breast';
	input.listeners.input();
	assert.strictEqual(select.children.length, 2);

	// switch to phenotype
	const phBtn = el.find('button').find((b) => b.textContent.startsWith('Phenotype'));
	phBtn.listeners.click();
	text = el.textContent;
	assert.ok(text.includes('1 alleles with phenotype annotations, 1 terms, 1 species'));
	assert.ok(!text.includes('Qualifier'));
});

test('main shows an empty message', async () => {
	globalThis.fetch = async () => ok([]);
	const el = fakeEl();
	tool.main(el, { root: 'http://h/mine' }, { Gene: { value: '1' } }, {}, {}, () => {});
	await tick();
	assert.ok(el.textContent.includes('No alleles with disease or phenotype annotations'));
});

test('main logs and shows a message on failure', async () => {
	globalThis.fetch = async () => ({ ok: false, status: 500 });
	const errors = [];
	const orig = console.error;
	console.error = (...a) => errors.push(a);
	const el = fakeEl();
	tool.main(el, { root: 'http://h/mine' }, { Gene: { value: '1' } }, {}, {}, () => {});
	await tick();
	console.error = orig;
	assert.strictEqual(errors.length, 1);
	assert.ok(el.textContent.includes('Could not load alleles'));
});

test('a stale response does not overwrite a newer one', async () => {
	let release;
	const slow = new Promise((r) => (release = r));
	let n = 0;
	globalThis.fetch = async (url, init) => {
		const mine = decodeURIComponent(init.body).includes('value="1"');
		if (mine) await slow;
		n++;
		return ok(mine ? [row('OLD', 'M. musculus', 1, 'A', 'old', 'DOID:1', 'x', null, null)] : []);
	};
	const el = fakeEl();
	tool.main(el, { root: 'http://h/mine' }, { Gene: { value: '1' } }, {}, {}, () => {});
	tool.main(el, { root: 'http://h/mine' }, { Gene: { value: '2' } }, {}, {}, () => {});
	await tick();
	release();
	await tick();
	assert.ok(n >= 8);
	assert.ok(!el.textContent.includes('OLD'));
	assert.ok(el.textContent.includes('No alleles with disease'));
});
