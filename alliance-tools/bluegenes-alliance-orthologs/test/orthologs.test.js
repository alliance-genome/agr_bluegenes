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
});

const fakeEl = () => document.createElement('div');
const tick = () => new Promise((r) => setTimeout(r, 5));
const ok = (results) => ({ ok: true, json: async () => ({ results }) });

test('main renders rows, links and summary', async () => {
	let requested;
	globalThis.fetch = async (url) => {
		requested = url;
		return ok([
			row('HGNC:1', 11, 'MGI:98834', 'Ptx', 'M. musculus', 5, 6, true),
			row('HGNC:1', 12, 'FBgn0039044', 'dx', 'D. melanogaster', 3, 6, false)
		]);
	};
	const el = fakeEl();
	const calls = [];
	tool.main(el, { root: 'http://h/mine/service/' }, { Gene: { value: '42' } }, {}, {}, (...a) => calls.push(a));
	await tick();
	assert.ok(requested.startsWith('http://h/mine/service/query/results?format=json'));
	assert.ok(decodeURIComponent(requested).includes('value="42"'));
	assert.ok(el.textContent.includes('2 orthologs in 2 species: D. melanogaster 1, M. musculus 1'));
	const anchors = el.find('a');
	assert.strictEqual(anchors.length, 4);
	const ext = anchors.filter((a) => a.target === '_blank');
	assert.deepStrictEqual(ext.map((a) => a.href), [
		'https://www.alliancegenome.org/gene/FB:FBgn0039044',
		'https://www.alliancegenome.org/gene/MGI:98834'
	]);
	ext.forEach((a) => assert.strictEqual(a.rel, 'noopener'));
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
	assert.strictEqual(el.textContent, 'No orthologs in this mine');
});

test('error shows a short message', async () => {
	globalThis.fetch = async () => ({ ok: false, status: 500 });
	const el = fakeEl();
	tool.main(el, { root: 'http://h/s' }, { Gene: { value: 1 } });
	await tick();
	assert.strictEqual(el.textContent, 'Could not load orthologs from the mine');
});

test('stale response is ignored', async () => {
	const resolvers = [];
	globalThis.fetch = () => new Promise((res) => resolvers.push(res));
	const el = fakeEl();
	tool.main(el, { root: 'http://h/s' }, { Gene: { value: 1 } });
	tool.main(el, { root: 'http://h/s' }, { Gene: { value: 2 } });
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
