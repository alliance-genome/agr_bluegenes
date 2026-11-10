'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { install } = require('./dom-stub.js');
install();
const tool = require('../dist/bundle.js');

const gene = (id, symbol, organism = 'H. sapiens') => ({ id, symbol, primaryIdentifier: 'X:' + id, organism });
const link = (a, b, identity, rank = 1) => ({ a, b, identity, similarity: identity + 10, rank });

test('union-find joins, finds and reports no-op unions', () => {
	const uf = tool.createUnionFind([1, 2, 3, 4, 5]);
	assert.strictEqual(uf.union(1, 2), true);
	assert.strictEqual(uf.union(2, 3), true);
	assert.strictEqual(uf.union(1, 3), false);
	assert.strictEqual(uf.find(1), uf.find(3));
	assert.notStrictEqual(uf.find(1), uf.find(4));
	assert.strictEqual(uf.find(5), 5);
});

test('union-find adds unknown keys on demand', () => {
	const uf = tool.createUnionFind();
	assert.strictEqual(uf.find('a'), 'a');
	uf.union('a', 'b');
	assert.strictEqual(uf.find('b'), uf.find('a'));
});

const genes = [gene(1, 'TP53'), gene(2, 'TP63'), gene(3, 'TP73'), gene(4, 'MAPT'), gene(5, 'MAP2'), gene(6, 'ALONE')];
const links = [link(1, 3, 58), link(1, 2, 33, 2), link(4, 5, 59), link(3, 1, 60, 2), link(6, 99, 90)];

test('clusters connect through the threshold and ignore outside genes', () => {
	const c = tool.buildClusters(genes, links, { minIdentity: 40 });
	assert.strictEqual(c.length, 2);
	const sizes = c.map((x) => x.members.length);
	assert.deepStrictEqual(sizes, [2, 2]);
	assert.deepStrictEqual(c[0].members.map((g) => g.symbol), ['MAP2', 'MAPT']);
});

test('lower threshold merges transitively into one family of three', () => {
	const c = tool.buildClusters(genes, links, { minIdentity: 30 });
	assert.deepStrictEqual(c.map((x) => x.members.length), [3, 2]);
	assert.deepStrictEqual(c[0].members.map((g) => g.symbol), ['TP53', 'TP63', 'TP73']);
});

test('a pair seen in both directions keeps highest identity and lowest rank', () => {
	const c = tool.buildClusters(genes, links, { minIdentity: 40 });
	const l = c[1].links;
	assert.strictEqual(l.length, 1);
	assert.strictEqual(l[0].identity, 60);
	assert.strictEqual(l[0].rank, 1);
});

test('rank limit drops links with a higher rank', () => {
	const c = tool.buildClusters(genes, [link(1, 2, 80, 3), link(4, 5, 80, 1)], { minIdentity: 40, maxRank: 2 });
	assert.deepStrictEqual(c.map((x) => x.members.map((g) => g.symbol)), [['MAP2', 'MAPT']]);
});

test('no clusters when nothing passes', () => {
	assert.deepStrictEqual(tool.buildClusters(genes, links, { minIdentity: 99 }), []);
	assert.deepStrictEqual(tool.buildClusters([], [], {}), []);
});

test('default threshold is 40', () => {
	const c = tool.buildClusters(genes, [link(1, 2, 39), link(4, 5, 40)], {});
	assert.strictEqual(c.length, 1);
});

test('representative has most annotations then first symbol', () => {
	const c = tool.buildClusters(genes, links, { minIdentity: 30 })[0];
	assert.strictEqual(tool.pickRepresentative(c, { 2: 5, 1: 1 }).symbol, 'TP63');
	assert.strictEqual(tool.pickRepresentative(c, { 1: 2, 3: 2 }).symbol, 'TP53');
	assert.strictEqual(tool.pickRepresentative(c, null).symbol, 'TP53');
});

test('reduceList keeps one per family and every singleton, in list order', () => {
	const clusters = tool.buildClusters(genes, links, { minIdentity: 40 });
	const reduced = tool.reduceList(genes, clusters, { 3: 4 });
	assert.deepStrictEqual(reduced.map((g) => g.symbol), ['TP63', 'TP73', 'MAP2', 'ALONE']);
});

test('dominantShare is the largest family over list size', () => {
	const clusters = tool.buildClusters(genes, links, { minIdentity: 30 });
	assert.strictEqual(tool.dominantShare(clusters, 6), 0.5);
	assert.strictEqual(tool.dominantShare([], 6), 0);
});

test('queries escape values', () => {
	assert.ok(tool.genesQuery(['a"<&']).includes('a&quot;&lt;&amp;'));
	assert.ok(tool.linksQuery([1, 2]).includes('Gene.paralogues.paralogue.id'));
});

// ---- main with a stubbed fetch ----

function fakeFetch(handlers, calls) {
	return async (url, init) => {
		calls.push({ url, init });
		const q = decodeURIComponent(init.body.match(/query=([^&]*)/)[1].replace(/\+/g, ' '));
		const h = handlers.find((x) => x.when(q));
		return { ok: true, status: 200, json: async () => ({ results: h ? h.rows : [] }) };
	};
}

const flush = () => new Promise((r) => setTimeout(r, 10));

test('main renders families, warning and coverage, and posts to the service root', async () => {
	const calls = [];
	globalThis.fetch = fakeFetch(
		[
			{ when: (q) => q.includes('Gene.symbol'), rows: [[1, 'X:1', 'A', 'H. sapiens'], [2, 'X:2', 'B', 'H. sapiens'], [3, 'X:3', 'C', 'D. melanogaster'], [4, 'X:4', 'D', 'D. melanogaster'], [5, 'X:5', 'E', 'D. melanogaster']] },
			{ when: (q) => q.includes('paralogue.id'), rows: [[1, 2, 70, 80, 1]] },
			{ when: (q) => q.includes('IS NOT NULL'), rows: [[1, 'H. sapiens'], [2, 'H. sapiens']] }
		],
		calls
	);
	const el = document.createElement('div');
	tool.main(el, { root: 'http://localhost:9999/alliancetestmine' }, { Gene: { value: [1, 2, 3, 4, 5] } }, {}, {}, () => {});
	await flush();
	const text = el.textContent;
	assert.ok(text.includes('1 paralog families with 2 or more list genes'));
	assert.ok(text.includes('Paralogue data found for: H. sapiens'));
	assert.ok(text.includes('A - B: identity 70'));
	assert.ok(text.includes('Warning: the largest family holds 2 of 5'));
	assert.ok(calls.every((c) => c.url === 'http://localhost:9999/alliancetestmine/service/query/results'));
	assert.ok(calls.every((c) => c.init.method === 'POST'));
});

test('stale response does not overwrite a newer one', async () => {
	let release;
	const gate = new Promise((r) => (release = r));
	let n = 0;
	globalThis.fetch = async () => {
		const first = n++ < 3;
		if (first) await gate;
		return { ok: true, status: 200, json: async () => ({ results: first ? [[1, 'X:1', 'OLD', 'H. sapiens']] : [[2, 'X:2', 'NEW', 'H. sapiens']] }) };
	};
	const el = document.createElement('div');
	const sv = { root: 'http://h/m' };
	tool.main(el, sv, { Gene: { value: [1] } }, {}, {}, null);
	tool.main(el, sv, { Gene: { value: [2] } }, {}, {}, null);
	await flush();
	release();
	await flush();
	assert.ok(el.textContent.includes('List: 1 genes'));
	assert.ok(!el.textContent.includes('OLD'));
});

test('failure shows a short message and logs', async () => {
	const orig = console.error;
	let logged = 0;
	console.error = () => logged++;
	globalThis.fetch = async () => ({ ok: false, status: 500 });
	const el = document.createElement('div');
	tool.main(el, { root: 'http://h/m' }, { Gene: { value: [1] } }, {}, {}, null);
	await flush();
	console.error = orig;
	assert.strictEqual(logged, 1);
	assert.ok(el.textContent.includes('Could not load paralogue data'));
});

test('empty entity shows a message without fetching', () => {
	let fetched = 0;
	globalThis.fetch = async () => fetched++;
	const el = document.createElement('div');
	tool.main(el, { root: 'http://h/m' }, { Gene: { value: [] } }, {}, {}, null);
	assert.ok(el.textContent.includes('No genes to analyse'));
	assert.strictEqual(fetched, 0);
});
