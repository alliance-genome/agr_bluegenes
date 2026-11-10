'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { install } = require('./dom-stub.js');
install();
const tool = require('../dist/bundle.js');

// [gene, annotation id, anatomy, anatomy id, stage, assay, source, pmid]
const r = (id, anatomy, stage, pmid, gene = 'G1') => [gene, id, anatomy, 'T:' + id, stage, 'RNA-seq', 'MGI', pmid];
const fakeEl = () => document.createElement('div');
const tick = () => new Promise((res) => setTimeout(res, 5));
const ok = (results) => ({ ok: true, json: async () => ({ results }) });

test('serviceRoot appends /service to a mine root and keeps one that has it', () => {
	assert.strictEqual(tool.serviceRoot('http://localhost:9999/alliancetestmine'), 'http://localhost:9999/alliancetestmine/service');
	assert.strictEqual(tool.serviceRoot('http://localhost:9999/alliancetestmine/service/'), 'http://localhost:9999/alliancetestmine/service');
});

test('buildQuery escapes ids and uses ONE OF for several', () => {
	assert.ok(tool.buildQuery('1"><x/>&').includes('value="1&quot;&gt;&lt;x/&gt;&amp;"'));
	const q = tool.buildQuery(['1', '<2>']);
	assert.ok(q.includes('op="ONE OF"'));
	assert.ok(q.includes('<value>&lt;2&gt;</value>'));
});

test('toAnnotations merges rows of one annotation across publications', () => {
	const rows = [r(1, 'brain', 's1', 11), r(1, 'brain', 's1', 12), r(1, 'brain', 's1', 11), r(2, null, null, null)].map(tool.toRow);
	const a = tool.toAnnotations(rows);
	assert.strictEqual(a.length, 2);
	assert.deepStrictEqual(a[0].pubs, ['11', '12']);
	assert.deepStrictEqual(tool.toAnnotations([tool.toRow(r(5, 'x', 's', 'PMID:77'))])[0].pubs, ['77']);
	assert.strictEqual(a[1].anatomy, 'Unspecified anatomy');
	assert.strictEqual(a[1].stage, 'Unspecified stage');
});

test('buildGrid counts cells, orders by count, and level shades by count', () => {
	const rows = [r(1, 'brain', 's1', 1), r(2, 'brain', 's1', 1), r(3, 'brain', 's2', 1), r(4, 'eye', 's1', 1)].map(tool.toRow);
	const g = tool.buildGrid(tool.toAnnotations(rows));
	assert.deepStrictEqual(g.anatomies, ['brain', 'eye']);
	assert.deepStrictEqual(g.stages, ['s1', 's2']);
	assert.strictEqual(g.counts.brain.s1, 2);
	assert.strictEqual(g.counts.brain['Any stage'], 3);
	assert.strictEqual(g.max, 2);
	assert.strictEqual(tool.level(0, 2), 0);
	assert.strictEqual(tool.level(1, 2), 2);
	assert.strictEqual(tool.level(2, 2), 4);
	assert.strictEqual(tool.level(1, 100), 1);
});

test('main posts to the /service endpoint and renders an accessible grid', async () => {
	let url;
	let init;
	globalThis.fetch = async (u, i) => {
		url = u;
		init = i;
		return ok([r(1, 'brain', 's1', 11), r(1, 'brain', 's1', 12), r(2, 'brain', 's2', 11), r(3, 'eye', 's1', 13)]);
	};
	const el = fakeEl();
	tool.main(el, { root: 'http://localhost:9999/alliancetestmine' }, { Gene: { value: '42' } });
	await tick();
	assert.strictEqual(url, 'http://localhost:9999/alliancetestmine/service/query/results');
	assert.strictEqual(init.method, 'POST');
	assert.ok(init.body.startsWith('format=json&size='));
	assert.ok(decodeURIComponent(init.body).includes('value="42"'));
	assert.ok(el.textContent.includes('3 annotations in 2 anatomy terms and 2 stage terms'));
	const buttons = el.find('button');
	assert.ok(buttons.every((b) => b.tag === 'button' && b.type === 'button'));
	assert.ok(buttons.some((b) => b.getAttribute('aria-label') === 'brain, Any stage: 2 annotations'));
	assert.ok(buttons.some((b) => b.getAttribute('aria-label') === 'eye, s1: 1 annotation'));
});

test('clicking a cell lists its annotations and marks it pressed', async () => {
	globalThis.fetch = async () => ok([r(1, 'brain', 's1', 11), r(1, 'brain', 's1', 12), r(2, 'brain', 's2', 13)]);
	const el = fakeEl();
	tool.main(el, { root: 'http://h/mine' }, { Gene: { value: '1' } });
	await tick();
	const cell = el.find('button').find((b) => b.getAttribute('aria-label') === 'brain, s1: 1 annotation');
	cell.click();
	assert.strictEqual(cell.getAttribute('aria-pressed'), 'true');
	const text = el.textContent;
	assert.ok(text.includes('brain, s1: 1 annotation'));
	assert.ok(text.includes('PMID 11, PMID 12'));
	assert.ok(!text.includes('PMID 13'));
	const link = el.find('a')[0];
	assert.strictEqual(link.href, 'https://pubmed.ncbi.nlm.nih.gov/11/');
});

test('more than 30 anatomy terms: top 30 shown, show all reveals the rest', async () => {
	const results = [];
	for (let i = 1; i <= 35; i++) results.push(r(i, 'term' + String(i).padStart(2, '0'), 's1', i));
	globalThis.fetch = async () => ok(results);
	const el = fakeEl();
	tool.main(el, { root: 'http://h/mine' }, { Gene: { value: ['1', '2'] } });
	await tick();
	const bodyRows = () => el.find('tbody')[0].children.length;
	assert.strictEqual(bodyRows(), 30);
	const more = el.find('button').find((b) => b.textContent === 'Show all 35 anatomy terms');
	more.click();
	assert.strictEqual(bodyRows(), 35);
});

test('empty result shows the empty state', async () => {
	globalThis.fetch = async () => ok([]);
	const el = fakeEl();
	tool.main(el, { root: 'http://h/mine' }, { Gene: { value: '1' } });
	await tick();
	assert.strictEqual(el.textContent, 'No expression annotations');
});

test('failure logs to console.error and shows a message', async () => {
	globalThis.fetch = async () => ({ ok: false, status: 500 });
	const logged = [];
	const orig = console.error;
	console.error = (...a) => logged.push(a);
	const el = fakeEl();
	tool.main(el, { root: 'http://h/mine' }, { Gene: { value: '1' } });
	await tick();
	console.error = orig;
	assert.strictEqual(logged.length, 1);
	assert.strictEqual(el.textContent, 'Could not load expression annotations from the mine');
});

test('a stale response does not overwrite a newer one', async () => {
	let resolveFirst;
	const first = new Promise((res) => { resolveFirst = res; });
	let n = 0;
	globalThis.fetch = () => (++n === 1 ? first : Promise.resolve(ok([r(2, 'eye', 's1', 2)])));
	const el = fakeEl();
	tool.main(el, { root: 'http://h/mine' }, { Gene: { value: '1' } });
	tool.main(el, { root: 'http://h/mine' }, { Gene: { value: '2' } });
	await tick();
	resolveFirst(ok([r(1, 'brain', 's1', 1)]));
	await tick();
	assert.ok(el.textContent.includes('eye'));
	assert.ok(!el.textContent.includes('brain'));
});

test('main throws without arguments', () => {
	assert.throws(() => tool.main(null, null, null), /correct signature/);
});
