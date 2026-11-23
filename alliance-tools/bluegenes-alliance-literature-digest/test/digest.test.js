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

test('topicCoverage and topicsOffered offer the filter when any paper has a topic', () => {
	const mk = (n, withTopic) => {
		const rows = [];
		for (let i = 0; i < n; i++) rows.push(row(1, 'a', 1000 + i, 2000, { topic: i < withTopic ? 't' : null }));
		return tool.groupPapers(rows);
	};
	assert.strictEqual(tool.topicCoverage(mk(10, 3)), 0.3);
	assert.ok(tool.topicsOffered(mk(10, 3)));
	assert.ok(tool.topicsOffered(mk(10, 1)));
	assert.ok(!tool.topicsOffered(mk(10, 0)));
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

test('pmidLines and papersTsv', () => {
	const papers = tool.rankPapers(tool.groupPapers([row(1, 'a', 5, 2020), row(2, 'b', 5, 2020), row(1, 'a', 6, 2019)]));
	assert.strictEqual(tool.pmidLines(papers), '5\n6');
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

const fixture = require('./fixtures/live-rows.json');
const liveView = fixture.views;
const jsonRes = (body) => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => body });
const statusRes = (status, headers) => ({ ok: false, status, headers: { get: (k) => (headers || {})[k] || null }, json: async () => ({}) });
const sandbox = async (fn) => {
	const saved = Object.assign({}, tool.settings);
	tool.settings.retryDelayMs = 0;
	try { return await fn(); } finally { Object.assign(tool.settings, saved); }
};

test('buildQuery outer-joins the topic collection when the view has the topic path', () => {
	const withTopic = tool.buildQuery(['1'], tool.VIEW.concat(['Gene.publications.literatureTopics.name']));
	assert.ok(withTopic.includes('<join path="Gene.publications.literatureTopics" style="OUTER"/>'));
	assert.ok(!tool.buildQuery(['1'], tool.VIEW).includes('<join'));
});

test('buildQuery sorts by gene then PubMed id and never by topic', () => {
	const q = tool.buildQuery(['1'], tool.VIEW.concat(['Gene.publications.literatureTopics.name']));
	assert.ok(q.includes('sortOrder="Gene.id asc Gene.publications.pubMedId asc"'));
});

test('VIEW carries the identifier and species columns', () => {
	assert.ok(tool.VIEW.includes('Gene.primaryIdentifier') && tool.VIEW.includes('Gene.organism.shortName'));
});

test('live rows: papers without a topic are kept, topics merge, identifiers and species are read', () => {
	const rows = fixture.results.map((r) => tool.toRow(r, liveView));
	const papers = tool.groupPapers(rows);
	const noTopic = papers.find((p) => p.pmid === '10082517');
	assert.ok(noTopic && noTopic.topics.length === 0);
	const two = papers.find((p) => p.pmid === '10051619');
	assert.deepStrictEqual(two.topics.sort(), ['Additional Literature', 'Primary Literature']);
	assert.strictEqual(two.genes[0].primaryIdentifier, 'SGD:S000000214');
	assert.strictEqual(two.genes[0].organism, 'S. cerevisiae');
	assert.strictEqual(papers.length, 8);
});

test('post retries a 429 and honours Retry-After', async () => {
	await sandbox(async () => {
		const calls = [];
		globalThis.fetch = async () => {
			calls.push(1);
			return calls.length === 1 ? statusRes(429, { 'Retry-After': '0' }) : jsonRes({ results: [] });
		};
		const res = await tool.fetchAll('http://h/mine', ['1'], tool.VIEW);
		assert.strictEqual(calls.length, 2);
		assert.deepStrictEqual(res.errors, []);
	});
});

test('a request that keeps failing is reported with its rows kept for complete genes', async () => {
	await sandbox(async () => {
		let n = 0;
		const page = Array.from({ length: 10000 }, (_, i) => [i < 6000 ? 1 : 2, 's', String(i), 't', 2000, 'J', 'c', 'A', 'X:1', 'sp']);
		globalThis.fetch = async () => (++n === 1 ? jsonRes({ results: page }) : statusRes(503));
		const res = await tool.fetchAll('http://h/mine', ['1', '2', '3'], tool.VIEW);
		assert.strictEqual(res.rows.length, 6000);
		assert.ok(res.rows.every((r) => String(r.gene) === '1'));
		assert.deepStrictEqual(res.unloaded, ['2', '3']);
		assert.deepStrictEqual(res.errors, ['HTTP 503']);
		assert.strictEqual(n, 1 + 1 + tool.settings.retries);
	});
});

test('a chunk that fills MAX_PAGES is split in halves and read again', async () => {
	await sandbox(async () => {
		const sizes = [];
		globalThis.fetch = async (url, i) => {
			const body = decodeURIComponent(i.body);
			const ids = (body.match(/<value>\d+<\/value>/g) || []).map((v) => v.replace(/\D/g, ''));
			sizes.push(ids.length);
			if (ids.length > 1) return jsonRes({ results: Array.from({ length: 10000 }, (_, k) => [Number(ids[0]), 's', String(k), 't', 2000, 'J', 'c', 'A', 'X:1', 'sp']) });
			return jsonRes({ results: [[Number(ids[0]), 's', '1', 't', 2000, 'J', 'c', 'A', 'X:1', 'sp']] });
		};
		const res = await tool.fetchAll('http://h/mine', ['1', '2', '3', '4'], tool.VIEW);
		assert.strictEqual(sizes.filter((n) => n === 4).length, 20);
		assert.deepStrictEqual(res.rows.map((r) => String(r.gene)), ['1', '2', '3', '4']);
		assert.strictEqual(res.truncated, false);
		assert.deepStrictEqual(res.unloaded, []);
	});
});

test('a single gene that fills MAX_PAGES is flagged as truncated and unloaded', async () => {
	await sandbox(async () => {
		globalThis.fetch = async () => jsonRes({ results: Array.from({ length: 10000 }, (_, k) => [7, 's', String(k), 't', 2000, 'J', 'c', 'A', 'X:1', 'sp']) });
		const res = await tool.fetchAll('http://h/mine', ['7'], tool.VIEW);
		assert.strictEqual(res.truncated, true);
		assert.deepStrictEqual(res.unloaded, ['7']);
		assert.strictEqual(res.rows.length, 200000);
	});
});

test('fetchAll sends 4 chunks of a 2000-id run one after another and reports progress', async () => {
	await sandbox(async () => {
		let open = 0;
		let peak = 0;
		let posts = 0;
		globalThis.fetch = async () => {
			posts++;
			peak = Math.max(peak, ++open);
			await tick();
			open--;
			return jsonRes({ results: [] });
		};
		const seen = [];
		const ids = Array.from({ length: 2000 }, (_, i) => String(i + 1));
		await tool.fetchAll('http://h/mine', ids, tool.VIEW, (p) => seen.push(p.chunk + '/' + p.chunks));
		assert.strictEqual(posts, 4);
		assert.strictEqual(peak, 1);
		assert.deepStrictEqual([...new Set(seen)], ['1/4', '2/4', '3/4', '4/4']);
	});
});

test('main shows loading progress, partial notice with the unloaded genes and a retry button', async () => {
	await sandbox(async () => {
		let n = 0;
		globalThis.fetch = async () => (++n === 1 ? jsonRes({ results: rowsToArrays([row(1, 'a', 5, 2020)]) }) : statusRes(500));
		const el = document.createElement('div');
		const ids = Array.from({ length: 501 }, (_, i) => String(i + 1));
		tool.main(el, { root: 'http://h/mine' }, { Gene: { value: ids } }, {}, {}, () => {});
		await new Promise((r) => setTimeout(r, 60));
		assert.ok(el.textContent.includes('Results are partial'));
		assert.ok(el.textContent.includes('Request failed: HTTP 500'));
		assert.ok(el.find('button').some((b) => b.textContent === 'Retry'));
	});
});

test('fetchSizes reads annotated gene counts from a summary query', async () => {
	let sent;
	globalThis.fetch = async (url, i) => { sent = decodeURIComponent(i.body); return jsonRes({ results: [['35636729', 33], ['23071261', 2]] }); };
	const sizes = await tool.fetchSizes('http://h/mine', ['35636729', '23071261']);
	assert.deepStrictEqual(sizes, { 35636729: 33, 23071261: 2 });
	assert.ok(sent.includes('summaryPath=Publication.pubMedId'));
	assert.ok(sent.includes('type="Gene"'));
});

test('ranking weighs gene coverage by paper size and moves screens to large studies', () => {
	const papers = tool.groupPapers([
		row(1, 'a', 1, 2020), row(2, 'b', 1, 2020), row(3, 'c', 1, 2020),
		row(1, 'a', 2, 2020), row(2, 'b', 2, 2020), row(3, 'c', 2, 2020),
		row(1, 'a', 3, 2020), row(2, 'b', 3, 2020)
	]);
	tool.applySizes(papers, { 1: 400, 2: 3, 3: 2 });
	const ranked = tool.rankPapers(papers);
	assert.deepStrictEqual(ranked.map((p) => p.pmid), ['2', '3', '1']);
	const parts = tool.splitLarge(ranked, 50);
	assert.deepStrictEqual(parts.large.map((p) => p.pmid), ['1']);
});

test('large-study cut is relative to the genes covered when the size is known', () => {
	const rows = [];
	for (let g = 1; g <= 30; g++) rows.push(row(g, 's' + g, 1, 2020));
	const papers = tool.groupPapers(rows);
	tool.applySizes(papers, { 1: 120 });
	assert.strictEqual(tool.splitLarge(papers, 50).large.length, 0);
	tool.applySizes(papers, { 1: 160 });
	assert.strictEqual(tool.splitLarge(papers, 50).large.length, 1);
});

test('papersTsv guards formulas, adds gene ids and species, keeps non-ASCII text', () => {
	const papers = tool.groupPapers([
		row(1, 'a', 5, 2020, { title: '=SUM(1)', firstAuthor: 'Müller', primaryIdentifier: 'HGNC:1', organism: 'H. sapiens' }),
		row(2, 'b', 5, 2020, { primaryIdentifier: 'MGI:2', organism: 'M. musculus' })
	]);
	const lines = tool.papersTsv(papers).split('\n');
	const head = lines[0].split('\t');
	const cols = lines[1].split('\t');
	assert.strictEqual(cols[head.indexOf('Title')], "'=SUM(1)");
	assert.strictEqual(cols[head.indexOf('First author')], 'Müller');
	assert.strictEqual(cols[head.indexOf('Gene IDs')], 'HGNC:1,MGI:2');
	assert.strictEqual(cols[head.indexOf('Species')], 'H. sapiens; M. musculus');
});

test('TSV download starts with a UTF-8 BOM and PMIDs are newline separated', async () => {
	const blobs = [];
	globalThis.Blob = class { constructor(parts) { blobs.push(parts[0]); } };
	globalThis.URL = { createObjectURL: () => 'blob:x', revokeObjectURL: () => { blobs.revoked = true; } };
	globalThis.fetch = async () => jsonRes({ results: rowsToArrays([row(1, 'a', 5, 2020), row(1, 'a', 6, 2019)]) });
	const el = document.createElement('div');
	tool.main(el, { root: 'http://h/mine' }, { Gene: { value: ['1'] } }, {}, {}, () => {});
	await tick();
	const click = (re) => el.find('button').find((b) => re.test(b.textContent)).listeners.click({});
	const realCreate = document.createElement;
	document.createElement = (t) => { const n = realCreate(t); if (t === 'a') n.click = () => {}; return n; };
	click(/TSV/);
	click(/^Download 2 PMIDs/);
	document.createElement = realCreate;
	assert.ok(blobs[0].startsWith('﻿PMID'));
	assert.strictEqual(blobs[1], '5\n6');
	await new Promise((r) => setTimeout(r, 1100));
	assert.ok(blobs.revoked);
});

test('copy falls back to a download and reports when the clipboard is blocked', async () => {
	const blobs = [];
	globalThis.Blob = class { constructor(parts) { blobs.push(parts[0]); } };
	globalThis.URL = { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} };
	Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard: { writeText: () => Promise.reject(new Error('denied')) } } });
	globalThis.fetch = async () => jsonRes({ results: rowsToArrays([row(1, 'a', 5, 2020)]) });
	const el = document.createElement('div');
	tool.main(el, { root: 'http://h/mine' }, { Gene: { value: ['1'] } }, {}, {}, () => {});
	await tick();
	const realCreate = document.createElement;
	document.createElement = (t) => { const n = realCreate(t); if (t === 'a') n.click = () => {}; return n; };
	el.find('button').find((b) => b.textContent === 'Copy 1 PMID').listeners.click({});
	await tick();
	document.createElement = realCreate;
	delete globalThis.navigator;
	assert.deepStrictEqual(blobs, ['5']);
	assert.ok(el.textContent.includes('Clipboard blocked'));
});

const filterFixture = () => tool.groupPapers([
	row(1, 'a', 1, 2001, { journal: 'X' }), row(1, 'a', 2, 2010, { journal: 'Y', topic: 'Reviews' }), row(1, 'a', 3, null, { journal: 'X' })
]);

test('changing a filter keeps the filter nodes, so focus stays on the select', () => {
	const el = document.createElement('div');
	tool.render(el, { papers: filterFixture(), geneCount: 1, unloaded: [], errors: [] }, {});
	const before = el.find('select');
	assert.ok(before.length >= 2);
	before[0].value = '2010';
	before[0].listeners.change();
	const after = el.find('select');
	assert.ok(after[0] === before[0] && after[1] === before[1]);
	assert.ok(el.textContent.includes('1 match the filters'));
});

test('filter summary is a live region and the table has a caption and column headers', () => {
	const el = document.createElement('div');
	tool.render(el, { papers: filterFixture(), geneCount: 1, unloaded: [], errors: [] }, {});
	const p = el.find('p').find((x) => /match the filters/.test(x.textContent));
	assert.strictEqual(p.attrs['aria-live'], 'polite');
	assert.ok(el.find('caption').length >= 1);
	assert.ok(el.find('th').every((th) => th.attrs.scope === 'col'));
});

test('year selects disable impossible ranges, zero results explain themselves, Clear filters resets', () => {
	const el = document.createElement('div');
	tool.render(el, { papers: filterFixture(), geneCount: 1, unloaded: [], errors: [] }, {});
	const [from, to] = el.find('select');
	from.value = '2010';
	from.listeners.change();
	const toOpts = to.children.filter((o) => o.value);
	assert.ok(toOpts.find((o) => o.value === '2001').disabled);
	assert.ok(!toOpts.find((o) => o.value === '2010').disabled);
	assert.ok(el.textContent.includes('1 paper without a year is hidden'));
	const journal = el.find('input')[0];
	journal.value = 'Nowhere';
	journal.listeners.change();
	assert.ok(el.textContent.includes('No papers match these filters'));
	el.find('button').find((b) => b.textContent === 'Clear filters').listeners.click({});
	assert.ok(el.textContent.includes('3 match the filters'));
	assert.strictEqual(from.value, '');
	assert.strictEqual(journal.value, '');
});

test('journal field is an input with a datalist of paper counts', () => {
	const el = document.createElement('div');
	tool.render(el, { papers: filterFixture(), geneCount: 1, unloaded: [], errors: [] }, {});
	const input = el.find('input')[0];
	const list = el.find('datalist')[0];
	assert.strictEqual(input.attrs.list, list.attrs.id);
	assert.deepStrictEqual(list.children.map((o) => o.value + ':' + o.textContent), ['X:2 papers', 'Y:1 paper']);
});

test('Reviews topic papers get their own section', () => {
	const el = document.createElement('div');
	tool.render(el, { papers: filterFixture(), geneCount: 1, unloaded: [], errors: [] }, {});
	assert.ok(el.find('h4').some((h) => h.textContent === 'Reviews (1)'));
	assert.ok(el.find('h4').some((h) => h.textContent === 'Papers by gene coverage (2)'));
});

test('gene chips are buttons with identifier and species in the tooltip', () => {
	const papers = tool.groupPapers([row(1, 'a', 5, 2020, { primaryIdentifier: 'HGNC:1', organism: 'H. sapiens' })]);
	const el = document.createElement('div');
	let went;
	tool.render(el, { papers, geneCount: 1, unloaded: [], errors: [] }, { navigate: (...a) => { went = a; } });
	const chip = el.find('button').find((b) => b.className === 'agr-chip');
	assert.strictEqual(chip.title, 'HGNC:1, H. sapiens');
	chip.listeners.click({});
	assert.deepStrictEqual(went, ['report', { type: 'Gene', id: '1' }]);
	assert.ok(!el.find('a').some((a) => a.className === 'agr-chip'));
});

test('save status is a status region', () => {
	const papers = tool.groupPapers([row(1, 'a', 5, 2020)]);
	const el = document.createElement('div');
	tool.render(el, { papers, geneCount: 1, unloaded: [], errors: [] }, { saveList: () => Promise.resolve('x') });
	assert.ok(el.find('span').some((s) => s.attrs.role === 'status'));
});
