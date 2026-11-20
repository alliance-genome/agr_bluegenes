'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { install } = require('./dom-stub.js');
install();
const tool = require('../dist/bundle.js');

const row = (gene, sym, pmid, year, extra) =>
	Object.assign({ gene: String(gene), symbol: sym, pmid: pmid == null ? null : String(pmid), title: 'T' + pmid, year, journal: 'J', citation: 'c', firstAuthor: 'A', topic: null }, extra);

test('chunk splits ids in groups of 500', () => {
	const ids = Array.from({ length: 1201 }, (_, i) => i + 1);
	const parts = tool.chunk(ids, 500);
	assert.deepStrictEqual(parts.map((p) => p.length), [500, 500, 201]);
	assert.deepStrictEqual(tool.chunk([], 500), []);
});

test('buildQuery lists the view and constrains Gene.id', () => {
	const q = tool.buildQuery(['1', '2'], tool.VIEW);
	assert.ok(q.includes('Gene.publications.pubMedId'));
	assert.ok(q.includes('op="ONE OF"'));
	assert.ok(q.includes('<value>2</value>'));
});

test('viewFor adds literatureTopics only when the model has it', () => {
	const model = (topics) => ({
		classes: {
			Gene: { collections: { publications: { referencedType: 'Publication' } }, attributes: { symbol: {} } },
			Publication: {
				attributes: { pubMedId: {}, title: {}, year: {}, journal: {}, citation: {}, firstAuthor: {} },
				collections: topics ? { literatureTopics: { referencedType: 'LiteratureTopic' } } : {}
			},
			LiteratureTopic: { attributes: { name: {} } }
		}
	});
	assert.ok(tool.viewFor({ model: model(true) }).includes('Gene.publications.literatureTopics.name'));
	assert.ok(!tool.viewFor({ model: model(false) }).includes('Gene.publications.literatureTopics.name'));
});

test('toRow reads columns by name', () => {
	const view = tool.VIEW;
	const values = view.map((p) => p);
	const r = tool.toRow(values, view);
	assert.strictEqual(r.pmid, 'Gene.publications.pubMedId');
	assert.strictEqual(r.symbol, 'Gene.symbol');
});

test('groupPapers merges rows per PMID and counts distinct genes', () => {
	const papers = tool.groupPapers([
		row(1, 'a', 100, 2020), row(2, 'b', 100, 2020), row(2, 'b', 100, 2020),
		row(1, 'a', 200, 2019), row(3, 'c', '', 2018), row(3, 'c', null, 2018)
	]);
	assert.strictEqual(papers.length, 2);
	const p = papers.find((x) => x.pmid === '100');
	assert.deepStrictEqual(p.genes.map((g) => g.id).sort(), ['1', '2']);
	assert.strictEqual(p.genes.length, 2);
});

test('groupPapers collects distinct topics', () => {
	const papers = tool.groupPapers([
		row(1, 'a', 100, 2020, { topic: 'x' }), row(1, 'a', 100, 2020, { topic: 'y' }), row(2, 'b', 100, 2020, { topic: 'x' })
	]);
	assert.deepStrictEqual(papers[0].topics.sort(), ['x', 'y']);
});

test('rankPapers sorts by gene count, then newer year, then PMID', () => {
	const papers = tool.groupPapers([
		row(1, 'a', 1, 2000), row(2, 'b', 1, 2000),
		row(1, 'a', 2, 2010),
		row(1, 'a', 3, 2020),
		row(1, 'a', 4, 2020), row(2, 'b', 4, 2020), row(3, 'c', 4, 2020)
	]);
	assert.deepStrictEqual(tool.rankPapers(papers).map((p) => p.pmid), ['4', '1', '3', '2']);
});

test('splitLarge moves papers above 50 genes to the large-study group', () => {
	const rows = [];
	for (let g = 1; g <= 51; g++) rows.push(row(g, 's' + g, 900, 2015));
	for (let g = 1; g <= 50; g++) rows.push(row(g, 's' + g, 901, 2016));
	rows.push(row(1, 's1', 902, 2017));
	const { focused, large } = tool.splitLarge(tool.rankPapers(tool.groupPapers(rows)), 50);
	assert.deepStrictEqual(large.map((p) => p.pmid), ['900']);
	assert.deepStrictEqual(focused.map((p) => p.pmid), ['901', '902']);
});

test('topicCoverage and topicsOffered apply the 30 percent rule', () => {
	const mk = (n, withTopic) => {
		const rows = [];
		for (let i = 0; i < n; i++) rows.push(row(1, 'a', 1000 + i, 2000, { topic: i < withTopic ? 't' : null }));
		return tool.groupPapers(rows);
	};
	assert.strictEqual(tool.topicCoverage(mk(10, 3)), 0.3);
	assert.ok(tool.topicsOffered(mk(10, 3)));
	assert.ok(!tool.topicsOffered(mk(10, 2)));
	assert.ok(!tool.topicsOffered([]));
});

test('filterPapers applies year, journal and topic', () => {
	const papers = tool.groupPapers([
		row(1, 'a', 1, 2001, { journal: 'X', topic: 't1' }), row(1, 'a', 2, 2010, { journal: 'Y' }), row(1, 'a', 3, 2020, { journal: 'X', topic: 't2' })
	]);
	assert.strictEqual(tool.filterPapers(papers, { yearFrom: 2005 }).length, 2);
	assert.strictEqual(tool.filterPapers(papers, { yearTo: 2010 }).length, 2);
	assert.strictEqual(tool.filterPapers(papers, { journal: 'X' }).length, 2);
	assert.deepStrictEqual(tool.filterPapers(papers, { topic: 't2' }).map((p) => p.pmid), ['3']);
	assert.strictEqual(tool.filterPapers(papers, {}).length, 3);
});

test('pmidCsv and papersTsv', () => {
	const papers = tool.rankPapers(tool.groupPapers([row(1, 'a', 5, 2020), row(2, 'b', 5, 2020), row(1, 'a', 6, 2019)]));
	assert.strictEqual(tool.pmidCsv(papers), '5,6');
	const lines = tool.papersTsv(papers).split('\n');
	assert.strictEqual(lines[0].split('\t')[0], 'PMID');
	assert.strictEqual(lines.length, 3);
	assert.ok(lines[1].startsWith('5\t2\t'));
	assert.ok(lines[1].includes('a,b'));
});

test('papersTsv strips tabs and newlines from titles', () => {
	const papers = tool.groupPapers([row(1, 'a', 5, 2020, { title: 'x\ty\nz' })]);
	assert.strictEqual(tool.papersTsv(papers).split('\n').length, 2);
});

const tick = () => new Promise((r) => setTimeout(r, 10));
const rowsToArrays = (rows) => rows.map((r) => [r.gene, r.symbol, r.pmid, r.title, r.year, r.journal, r.citation, r.firstAuthor]);

test('fetchAll posts one request per 500 ids', async () => {
	const bodies = [];
	globalThis.fetch = async (url, i) => {
		bodies.push(decodeURIComponent(i.body));
		return { ok: true, json: async () => ({ results: [] }) };
	};
	const ids = Array.from({ length: 1001 }, (_, i) => String(i + 1));
	await tool.fetchAll('http://h/mine/service', ids, tool.VIEW.slice(0, 8));
	assert.strictEqual(bodies.length, 3);
	assert.ok(bodies[0].includes('<value>500</value>') && !bodies[0].includes('<value>501</value>'));
});

test('main renders ranked papers and hides save without context', async () => {
	globalThis.fetch = async () => ({
		ok: true,
		json: async () => ({ results: rowsToArrays([row(1, 'a', 5, 2020), row(2, 'b', 5, 2020), row(1, 'a', 6, 2019)]) })
	});
	const el = document.createElement('div');
	tool.main(el, { root: 'http://h/mine' }, { Gene: { value: ['1', '2'] } }, {}, {}, () => {});
	await tick();
	assert.ok(el.textContent.includes('2 papers'));
	assert.strictEqual(el.find('a').filter((a) => /pubmed/.test(a.href || '')).length, 2);
	assert.ok(!el.textContent.includes('Save'));
});

test('main offers saving the genes of a paper when context.saveList exists', async () => {
	globalThis.fetch = async () => ({
		ok: true,
		json: async () => ({ results: rowsToArrays([row(1, 'a', 5, 2020), row(2, 'b', 5, 2020)]) })
	});
	let saved;
	const context = { saveList: (x) => { saved = x; return Promise.resolve(x.name); } };
	const el = document.createElement('div');
	tool.main(el, { root: 'http://h/mine' }, { Gene: { value: ['1', '2'] } }, {}, {}, () => {}, context);
	await tick();
	const btn = el.find('button').find((b) => /Save/.test(b.textContent));
	assert.ok(btn);
	btn.listeners.click({});
	assert.deepStrictEqual(saved.ids, ['1', '2']);
	assert.strictEqual(saved.class, 'Gene');
	assert.ok(Array.isArray(saved.tags));
});

test('main labels the save button in the singular for one gene', async () => {
	globalThis.fetch = async () => ({
		ok: true,
		json: async () => ({ results: rowsToArrays([row(1, 'a', 5, 2020)]) })
	});
	const context = { saveList: (x) => Promise.resolve(x.name) };
	const el = document.createElement('div');
	tool.main(el, { root: 'http://h/mine' }, { Gene: { value: ['1'] } }, {}, {}, () => {}, context);
	await tick();
	const btn = el.find('button').find((b) => /Save/.test(b.textContent));
	assert.strictEqual(btn.textContent, 'Save 1 gene as list');
	assert.ok(el.textContent.includes('1 paper cites 1 gene.'));
});

test('main reports an empty list', () => {
	const el = document.createElement('div');
	tool.main(el, { root: 'http://h/mine' }, { Gene: { value: [] } }, {}, {}, () => {});
	assert.ok(el.textContent.includes('No genes'));
});
