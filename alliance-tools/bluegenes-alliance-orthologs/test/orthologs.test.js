'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { install } = require('./dom-stub.js');
install();
const tool = require('../dist/bundle.js');

const row = (source, id, identifier, symbol, species, match, attempted, best) =>
	[source, id, identifier, symbol, species, match, attempted, best, false];

test('buildQuery escapes the id', () => {
	const q = tool.buildQuery('1"><x/>&');
	assert.ok(q.includes('value="1&quot;&gt;&lt;x/&gt;&amp;"'));
	assert.ok(!q.includes('<x/>'));
	assert.ok(q.includes('path="Gene.id" op="="'));
});

test('buildQuery uses ONE OF for several ids and escapes each', () => {
	const q = tool.buildQuery(['1', '<2>']);
	assert.ok(q.includes('op="ONE OF"'));
	assert.ok(q.includes('<value>1</value><value>&lt;2&gt;</value>'));
});

test('groupRows sorts species, then symbol, then identifier', () => {
	const rows = [
		row('a', 1, 'MGI:2', 'Zeta', 'M. musculus'),
		row('a', 2, 'FB:1', 'abc', 'D. melanogaster'),
		row('a', 3, 'MGI:1', 'Alpha', 'M. musculus'),
		row('a', 4, 'MGI:9', 'Alpha', 'M. musculus')
	].map(tool.toRow);
	const g = tool.groupRows(rows);
	assert.deepStrictEqual(g.map((x) => x.species), ['D. melanogaster', 'M. musculus']);
	assert.deepStrictEqual(g[1].rows.map((r) => r.identifier), ['MGI:1', 'MGI:9', 'MGI:2']);
});

test('toCurie', () => {
	assert.strictEqual(tool.toCurie('FBgn0039044', 'D. melanogaster'), 'FB:FBgn0039044');
	assert.strictEqual(tool.toCurie('MGI:98834', 'M. musculus'), 'MGI:98834');
	assert.strictEqual(tool.toCurie('x', 'H. sapiens'), null);
	assert.strictEqual(tool.toCurie('2018', 'R. norvegicus'), null);
	assert.strictEqual(tool.toCurie('WBGene00006759', 'C. briggsae'), null);
});

const fakeEl = () => document.createElement('div');
const tick = () => new Promise((r) => setTimeout(r, 5));
const ok = (results) => ({ ok: true, json: async () => ({ results }) });

test('main renders rows, links and summary', async () => {
	let requested;
	let init;
	globalThis.fetch = async (url, i) => {
		requested = url;
		init = i;
		return ok([
			row('HGNC:1', 11, 'MGI:98834', 'Ptx', 'M. musculus', 5, 6, true),
			row('HGNC:1', 12, 'FBgn0039044', 'dx', 'D. melanogaster', 3, 6, false)
		]);
	};
	const el = fakeEl();
	const calls = [];
	tool.main(el, { root: 'http://h/mine/service/' }, { Gene: { value: '42' } }, {}, {}, (...a) => calls.push(a));
	await tick();
	assert.strictEqual(requested, 'http://h/mine/service/query/results');
	assert.strictEqual(init.method, 'POST');
	assert.ok(init.body.startsWith('format=json&size=2000&query='));
	assert.ok(decodeURIComponent(init.body).includes('value="42"'));
	assert.ok(el.textContent.includes('2 orthologs in 2 species: D. melanogaster 1, M. musculus 1'));
	const anchors = el.find('a');
	assert.strictEqual(anchors.length, 4);
	const ext = anchors.filter((a) => a.target === '_blank');
	assert.deepStrictEqual(ext.map((a) => a.href), [
		'https://www.alliancegenome.org/gene/FB:FBgn0039044',
		'https://www.alliancegenome.org/gene/MGI:98834'
	]);
	ext.forEach((a) => assert.strictEqual(a.rel, 'noopener noreferrer'));
	const internal = anchors.find((a) => a.textContent === 'MGI:98834');
	let prevented = false;
	internal.listeners.click({ preventDefault() { prevented = true; } });
	assert.ok(prevented);
	assert.deepStrictEqual(calls, [['report', { type: 'Gene', id: 11 }]]);
	assert.ok(el.textContent.includes('5/6'));
	assert.ok(el.textContent.includes('best'));
});

test('data is never parsed as HTML', async () => {
	globalThis.fetch = async () => ok([row('g', 1, 'MGI:1', '<img src=x>', 'M. musculus')]);
	const el = fakeEl();
	tool.main(el, { root: 'http://h/s' }, { Gene: { value: 1 } });
	await tick();
	assert.ok(el.textContent.includes('<img src=x>'));
	assert.strictEqual(el.find('img').length, 0);
});

test('empty state', async () => {
	globalThis.fetch = async () => ok([]);
	const el = fakeEl();
	tool.main(el, { root: 'http://h/s' }, { Gene: { value: 1 } });
	await tick();
	assert.strictEqual(el.textContent, 'No orthologs for this gene');
});

test('error shows a short message', async () => {
	globalThis.fetch = async () => ({ ok: false, status: 500 });
	const el = fakeEl();
	tool.main(el, { root: 'http://h/s' }, { Gene: { value: 1 } });
	await tick();
	assert.strictEqual(el.textContent, 'Could not load orthologs from the mine (HTTP 500)');
});

test('stale response is ignored', async () => {
	const resolvers = [];
	globalThis.fetch = () => new Promise((res) => resolvers.push(res));
	const el = fakeEl();
	tool.main(el, { root: 'http://h/s' }, { Gene: { value: 1 } });
	tool.main(el, { root: 'http://h/s' }, { Gene: { value: 2 } });
	await tick();
	resolvers[1](ok([row('g', 2, 'MGI:2', 'New', 'M. musculus')]));
	await tick();
	resolvers[0](ok([row('g', 1, 'MGI:1', 'Old', 'M. musculus')]));
	await tick();
	assert.ok(el.textContent.includes('New'));
	assert.ok(!el.textContent.includes('Old'));
});

test('several ids add a query gene column', async () => {
	globalThis.fetch = async () => ok([row('HGNC:1', 1, 'MGI:1', 'A', 'M. musculus')]);
	const el = fakeEl();
	tool.main(el, { root: 'http://h/s' }, { Gene: { value: [1, 2] } });
	await tick();
	assert.ok(el.textContent.includes('Query gene'));
	assert.ok(el.textContent.includes('HGNC:1'));
});

test('ids go in a POST body, not the URL', async () => {
	let requested, init;
	globalThis.fetch = async (url, i) => {
		requested = url;
		init = i;
		return ok([]);
	};
	const ids = Array.from({ length: 200 }, (_, i) => String(100000 + i));
	tool.main(fakeEl(), { root: 'http://h/mine/service' }, { Gene: { value: ids } }, {}, {}, () => {});
	await tick();
	assert.strictEqual(init.method, 'POST');
	assert.ok(!requested.includes('?'));
	assert.strictEqual(requested, 'http://h/mine/service/query/results');
	assert.strictEqual(init.headers['Content-Type'], 'application/x-www-form-urlencoded');
	const params = new URLSearchParams(init.body);
	assert.strictEqual(params.get('format'), 'json');
	assert.strictEqual(params.get('size'), '2000');
	assert.strictEqual((params.get('query').match(/<value>/g) || []).length, 200);
});

test('dedupeRows merges repeated homologue rows: max counts, any best flag', () => {
	const rows = [
		['r1', 7, 'HGNC:1100', 'BRCA1', 'H. sapiens', 5, 12, false, false],
		['r1', 7, 'HGNC:1100', 'BRCA1', 'H. sapiens', 9, 12, true, false],
		['r1', 7, 'HGNC:1100', 'BRCA1', 'H. sapiens', 3, 10, false, true],
		['r1', 8, 'MGI:1', 'Brca1', 'M. musculus', 4, 12, false, false],
		['r2', 7, 'HGNC:1100', 'BRCA1', 'H. sapiens', 2, 12, false, false]
	].map((r) => tool.toRow(r));
	const out = tool.dedupeRows(rows);
	assert.strictEqual(out.length, 3);
	assert.deepStrictEqual(
		[out[0].match, out[0].attempted, out[0].best, out[0].bestReverse],
		[9, 12, true, true]
	);
	assert.strictEqual(out[2].source, 'r2');
});

const fixture = require('./fixtures/tp53-orthologs.json').results;

test('duplicate Homologue rows from the mine collapse to one row per pair', async () => {
	globalThis.fetch = async () => ok(fixture);
	const el = fakeEl();
	tool.main(el, { root: 'http://h/s' }, { Gene: { value: 1 } });
	await tick();
	assert.strictEqual(el.find('tbody')[0].children.length, 5);
	assert.ok(el.textContent.includes('5 orthologs in 5 species'));
	assert.ok(!el.textContent.includes('incomplete'));
});

test('a response at the row limit shows the incomplete note even when de-duplication shrinks it', async () => {
	const capped = [];
	while (capped.length < 2000) capped.push(fixture[capped.length % fixture.length]);
	globalThis.fetch = async () => ok(capped);
	const el = fakeEl();
	tool.main(el, { root: 'http://h/s' }, { Gene: { value: 1 } });
	await tick();
	assert.ok(el.textContent.includes('5 orthologs in 5 species'));
	assert.ok(el.textContent.includes('the limit for one request, so the list is incomplete'));
});

test('450 ids go out in three sequential requests of at most 200 ids', async () => {
	const bodies = [];
	let inFlight = 0;
	let overlap = false;
	globalThis.fetch = async (url, i) => {
		if (++inFlight > 1) overlap = true;
		bodies.push(decodeURIComponent(i.body));
		await tick();
		inFlight--;
		return ok([]);
	};
	const ids = Array.from({ length: 450 }, (_, n) => n + 1);
	tool.main(fakeEl(), { root: 'http://h/s' }, { Gene: { value: ids } });
	await new Promise((r) => setTimeout(r, 60));
	assert.deepStrictEqual(bodies.map((b) => (b.match(/<value>/g) || []).length), [200, 200, 50]);
	assert.strictEqual(overlap, false);
});

test('HTTP 429 after the retries shows that the mine is busy', async () => {
	globalThis.fetch = async () => ({ ok: false, status: 429, headers: { get: () => '0.001' } });
	const el = fakeEl();
	tool.main(el, { root: 'http://h/s' }, { Gene: { value: 1 } });
	await new Promise((r) => setTimeout(r, 60));
	assert.ok(el.textContent.includes('the mine is busy (HTTP 429)'));
});

test('Download CSV carries every ortholog row with the algorithm counts', async () => {
	globalThis.fetch = async () => ok(fixture);
	const el = fakeEl();
	tool.main(el, { root: 'http://h/s' }, { Gene: { value: 1 } });
	await tick();
	assert.ok(el.find('button').some((b) => b.textContent === 'Download CSV'));
	const rows = tool.groupRows(tool.dedupeRows(fixture.map((r) => tool.toRow(r)))).reduce((a, g) => a.concat(g.rows), []);
	const csv = tool.toCsv(tool.CSV_HEADER, rows.map(tool.csvRow)).split('\r\n');
	assert.strictEqual(csv[0], 'Query gene,Species,Symbol,Identifier,Algorithms matched,Algorithms attempted,Best,Best reverse');
	assert.strictEqual(csv.length, 5 + 2);
	assert.ok(csv.includes('HGNC:11998,D. melanogaster,p53,FB:FBgn0039044,6,9,yes,yes'));
});
