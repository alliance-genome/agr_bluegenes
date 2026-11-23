'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { install } = require('./dom-stub.js');
install();
const tool = require('../dist/bundle.js');

// view: g1.id, g1.pid, g1.symbol, g2.id, g2.pid, g2.symbol, relation, method, pmid
const PHYS = 'physically_interacts_with';
const GEN = 'genetically_interacts_with';
const ROWS = [
	[1, 'HGNC:1', 'AAA', 2, 'HGNC:2', 'BBB', PHYS, 'two hybrid', '111'],
	[2, 'HGNC:2', 'BBB', 1, 'HGNC:1', 'AAA', PHYS, 'two hybrid', '222'],
	[1, 'HGNC:1', 'AAA', 3, 'HGNC:3', 'CCC', PHYS, 'pull down', '333'],
	[1, 'HGNC:1', 'AAA', 4, 'HGNC:4', 'DDD', GEN, 'synthetic lethality', null],
	[3, 'HGNC:3', 'CCC', 4, 'HGNC:4', 'DDD', PHYS, 'pull down', '444'],
	[1, 'HGNC:1', 'AAA', 1, 'HGNC:1', 'AAA', PHYS, 'two hybrid', '555']
];

test('buildEdges merges both directions and publications, keeps self loops flagged', () => {
	const edges = tool.buildEdges(ROWS);
	assert.strictEqual(edges.length, 5);
	assert.deepStrictEqual(edges.filter((e) => e.self).map((e) => e.a.pid), ['HGNC:1']);
	const ab = edges.find((e) => e.a.pid === 'HGNC:1' && e.b.pid === 'HGNC:2');
	assert.deepStrictEqual(ab.pmids, ['111', '222']);
	assert.strictEqual(ab.relation, PHYS);
});

test('filterEdges filters by relation and detection method', () => {
	const edges = tool.buildEdges(ROWS);
	assert.strictEqual(tool.filterEdges(edges, { relation: GEN }).length, 1);
	assert.strictEqual(tool.filterEdges(edges, { method: 'pull down' }).length, 2);
	assert.strictEqual(tool.filterEdges(edges, { relation: PHYS, method: 'pull down' }).length, 2);
	assert.strictEqual(tool.filterEdges(edges, { relation: GEN, method: 'pull down' }).length, 0);
	assert.strictEqual(tool.filterEdges(edges, {}).length, 5);
});

test('degreeRanking counts distinct neighbours and sorts by degree then symbol', () => {
	const ranking = tool.degreeRanking(tool.buildEdges(ROWS));
	assert.deepStrictEqual(
		ranking.map((r) => [r.node.symbol, r.degree]),
		[['AAA', 3], ['CCC', 2], ['DDD', 2], ['BBB', 1]]
	);
});

test('degreeRanking counts a neighbour once across relations', () => {
	const rows = ROWS.concat([[1, 'HGNC:1', 'AAA', 2, 'HGNC:2', 'BBB', GEN, 'x', null]]);
	const top = tool.degreeRanking(tool.buildEdges(rows))[0];
	assert.strictEqual(top.degree, 3);
});

test('toSif writes one tab separated line per pair and relation', () => {
	const sif = tool.toSif(tool.buildEdges(ROWS));
	assert.deepStrictEqual(sif.split('\n').sort(), [
		'AAA\tgenetically_interacts_with\tDDD',
		'AAA\tphysically_interacts_with\tAAA',
		'AAA\tphysically_interacts_with\tBBB',
		'AAA\tphysically_interacts_with\tCCC',
		'CCC\tphysically_interacts_with\tDDD'
	]);
});

test('degreeRanking ignores self edges', () => {
	const ranking = tool.degreeRanking(tool.buildEdges([ROWS[5]]));
	assert.deepStrictEqual(ranking, []);
});

test('toSif falls back to the identifier and removes whitespace', () => {
	const rows = [[1, 'HGNC:1', 'A B', 2, 'HGNC:2', '', PHYS, 'm', null]];
	assert.strictEqual(tool.toSif(tool.buildEdges(rows)), 'A_B\tphysically_interacts_with\tHGNC:2');
});

test('toTsv has a header with gene ids and one row per edge', () => {
	const lines = tool.toTsv(tool.buildEdges(ROWS)).split('\n');
	assert.strictEqual(lines[0], 'gene_a\tgene_a_id\tgene_b\tgene_b_id\trelation\tdetection_method\tpubmed_ids');
	assert.strictEqual(lines.length, 6);
	assert.ok(lines.includes('AAA\tHGNC:1\tBBB\tHGNC:2\tphysically_interacts_with\ttwo hybrid\t111,222'));
});

test('circularLayout caps nodes at the limit and keeps only edges among them', () => {
	const rows = [];
	for (let i = 1; i <= 200; i++) rows.push([1, 'H:0', 'HUB', i + 1, 'H:' + i, 'G' + i, PHYS, 'm', null]);
	const lay = tool.circularLayout(tool.buildEdges(rows), 150);
	assert.strictEqual(lay.nodes.length, 150);
	assert.strictEqual(lay.nodes[0].node.symbol, 'HUB');
	assert.strictEqual(lay.links.length, 149);
	assert.ok(lay.nodes.every((n) => isFinite(n.x) && isFinite(n.y)));
});

test('buildSetQuery constrains both ends to the set and escapes values', () => {
	const q = tool.buildSetQuery([1, 2, 3]);
	assert.ok(q.indexOf('path="Gene.id" op="ONE OF"') > -1);
	assert.ok(q.indexOf('path="Gene.interactions.participant2.id" op="ONE OF"') > -1);
	assert.ok(q.indexOf('Gene.interactions.details.experiment.publication.pubMedId') > -1);
	assert.strictEqual((q.match(/<value>3<\/value>/g) || []).length, 2);
});

test('buildSetQuery uses OUTER joins so edges without method or publication are kept', () => {
	const q = tool.buildSetQuery([1]);
	['Gene.interactions.detectionMethod', 'Gene.interactions.details',
		'Gene.interactions.details.experiment', 'Gene.interactions.details.experiment.publication']
		.forEach((p) => assert.ok(q.indexOf('<join path="' + p + '" style="OUTER"/>') > -1, p));
	assert.ok(q.indexOf('<join') < q.indexOf('<constraint'));
});

// Three hubs of degree 4 and two leaves of degree 3 (ids 1-3 hubs, 4-5 leaves).
const HUB_ROWS = [];
[[1, 2], [1, 3], [2, 3], [1, 4], [2, 4], [3, 4], [1, 5], [2, 5], [3, 5]].forEach(([x, y]) => {
	HUB_ROWS.push([x, 'H:' + x, 'G' + x, y, 'H:' + y, 'G' + y, PHYS, 'm', null]);
});

test('hubIds keeps genes with 2 or more partners at the top-decile degree', () => {
	assert.deepStrictEqual(tool.hubIds(tool.degreeRanking(tool.buildEdges(HUB_ROWS)), 20), [1, 2, 3]);
	assert.deepStrictEqual(tool.hubIds(tool.degreeRanking(tool.buildEdges(HUB_ROWS)), 2), [1, 2]);
});

test('hubIds returns one gene for a small network with a single top gene', () => {
	assert.deepStrictEqual(tool.hubIds(tool.degreeRanking(tool.buildEdges(ROWS)), 20), [1]);
});

const tick = () => new Promise((r) => setTimeout(r, 20));

function run(context, rows) {
	const calls = [];
	globalThis.fetch = (url, opts) => {
		calls.push({ url, opts });
		return Promise.resolve({ ok: true, json: () => Promise.resolve({ results: rows }) });
	};
	const el = document.createElement('div');
	tool.main(el, { root: 'http://h/mine' }, { Gene: { value: [1, 2, 3, 4], class: 'Gene' } }, {}, {}, () => {}, context);
	return { el, calls };
}

test('main posts one query to the service root and shows the edge count', async () => {
	const { el, calls } = run(undefined, ROWS);
	await tick();
	assert.strictEqual(calls.length, 1);
	assert.strictEqual(calls[0].url, 'http://h/mine/service/query/results');
	assert.strictEqual(calls[0].opts.method, 'POST');
	assert.ok(/4 gene pairs, 5 pair-method records, 4 genes with partners, 1 with self-interactions/.test(el.textContent));
	assert.ok(!/Save hubs/.test(el.textContent));
});

test('main offers hub saving only when context.saveList exists', async () => {
	const saved = [];
	const context = { list: { title: 'My list' }, saveList: (o) => { saved.push(o); return Promise.resolve('n'); } };
	const { el } = run(context, HUB_ROWS);
	await tick();
	assert.ok(/Save hubs/.test(el.textContent));
	const btn = el.find('button').find((b) => /Save hubs/.test(b.textContent));
	btn.listeners.click();
	await tick();
	assert.strictEqual(saved.length, 1);
	assert.strictEqual(saved[0].class, 'Gene');
	assert.deepStrictEqual(saved[0].ids, [1, 2, 3]);
});

test('main asks for a set when one gene is given', async () => {
	globalThis.fetch = () => { throw new Error('no fetch expected'); };
	const el = document.createElement('div');
	tool.main(el, { root: 'http://h/mine' }, { Gene: { value: 5 } }, {}, {}, () => {});
	assert.ok(/at least 2 genes/.test(el.textContent));
});

test('main reports an empty network', async () => {
	const { el } = run(undefined, []);
	await tick();
	assert.ok(/No interactions among these genes/.test(el.textContent));
});

test('main shows why there is nothing to save when fewer than 3 hubs qualify', async () => {
	const context = { saveList: () => Promise.resolve('n') };
	const { el } = run(context, ROWS);
	await tick();
	assert.ok(!/Save hubs/.test(el.textContent));
	assert.ok(/Fewer than 3 genes have 2 or more partners/.test(el.textContent));
});

// Live result for TP53, MDM2, BRCA1, BARD1, EP300, CREBBP, trimmed to 49 of 2181 rows.
const LIVE = require('./live-rows.json');

test('live rows: self rows kept, 11 pairs, null methods kept', () => {
	const edges = tool.buildEdges(LIVE);
	assert.strictEqual(new Set(edges.filter((e) => e.self).map((e) => e.a.pid)).size, 2);
	assert.strictEqual(new Set(edges.filter((e) => !e.self).map((e) => e.a.pid + e.b.pid)).size, 11);
	assert.strictEqual(tool.degreeRanking(edges).length, 6);
	assert.ok(edges.some((e) => e.method === ''));
});

test('live rows: SIF lines have 3 fields and TSV rows have 7', () => {
	const edges = tool.buildEdges(LIVE);
	tool.toSif(edges).split('\n').forEach((l) => assert.strictEqual(l.split('\t').length, 3, l));
	const tsv = tool.toTsv(edges).split('\n');
	assert.strictEqual(tsv.length, edges.length + 1);
	tsv.forEach((l) => assert.strictEqual(l.split('\t').length, 7, l));
	assert.ok(tsv.some((l) => /^BRCA1\tHGNC:1100\tBRCA1\tHGNC:1100\t/.test(l)));
});

test('groupEdges makes one row per pair and relation, best supported first', () => {
	const edges = tool.buildEdges(LIVE);
	const groups = tool.groupEdges(edges);
	const keys = groups.map((g) => g.a.pid + '|' + g.b.pid + '|' + g.relation);
	assert.strictEqual(new Set(keys).size, groups.length);
	assert.ok(groups.length < edges.length);
	for (let i = 1; i < groups.length; i++) assert.ok(groups[i - 1].pmids.length >= groups[i].pmids.length);
	const g = groups[0];
	assert.strictEqual(g.methods.length, new Set(g.methods).size);
});

test('toSif disambiguates two genes that share a symbol and nothing else', () => {
	const rows = [
		[1, 'MGI:1', 'Brca1', 2, 'MGI:2', 'Trp53', PHYS, 'm', null],
		[3, 'RGD:1', 'Brca1', 2, 'MGI:2', 'Trp53', PHYS, 'm', null]
	];
	const lines = tool.toSif(tool.buildEdges(rows)).split('\n');
	assert.deepStrictEqual(lines.sort(), [
		'Brca1_MGI:1\tphysically_interacts_with\tTrp53',
		'Trp53\tphysically_interacts_with\tBrca1_RGD:1'
	]);
	assert.strictEqual(tool.toSif(tool.buildEdges(ROWS)).indexOf('_HGNC'), -1);
});

function mock(handler) {
	const calls = [];
	globalThis.fetch = (url, opts) => {
		calls.push({ url, opts, body: decodeURIComponent(String(opts.body)) });
		const r = handler(calls.length, opts, calls[calls.length - 1]);
		return r instanceof Promise ? r : Promise.resolve({
			ok: r.status === undefined || (r.status >= 200 && r.status < 300),
			status: r.status || 200,
			json: () => Promise.resolve({ results: r.rows || [] }),
			text: () => Promise.resolve(r.text === undefined ? '' : r.text)
		});
	};
	return calls;
}

function start(rows, ctx) {
	const el = document.createElement('div');
	tool.main(el, { root: 'http://h/mine' }, { Gene: { value: [1, 2, 3, 4], class: 'Gene' } }, {}, {}, () => {}, ctx);
	return el;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('main pages the query with start and size and joins the pages', async () => {
	const row = ROWS[0];
	const calls = mock((n) => ({ rows: n < 3 ? new Array(5000).fill(row) : [ROWS[2]] }));
	const el = start();
	await wait(60);
	assert.strictEqual(calls.length, 3);
	assert.ok(/start=0&size=5000/.test(calls[0].body));
	assert.ok(/start=5000&size=5000/.test(calls[1].body));
	assert.ok(/start=10000&size=5000/.test(calls[2].body));
	assert.ok(/2 gene pairs/.test(el.textContent));
	assert.ok(!/incomplete/.test(el.textContent));
});

test('main warns when the row cap is hit and keeps what it loaded', async () => {
	const row = ROWS[0];
	const calls = mock((n, opts, c) => {
		const size = Number(/size=(\d+)/.exec(c.body)[1]);
		return { rows: new Array(size).fill(row) };
	});
	const el = start();
	await wait(150);
	assert.strictEqual(calls.length, 11);
	assert.ok(/Only the first 50000 interaction rows were loaded/.test(el.textContent));
	assert.ok(/1 gene pairs/.test(el.textContent));
});

test('exactly the row cap is not reported as truncated', async () => {
	const row = ROWS[0];
	mock((n, opts, c) => {
		const size = Number(/size=(\d+)/.exec(c.body)[1]);
		return { rows: size === 1 ? [] : new Array(size).fill(row) };
	});
	const el = start();
	await wait(150);
	assert.ok(!/incomplete/.test(el.textContent));
});

test('main retries on HTTP 429 with backoff and then succeeds', async () => {
	tool.settings.backoffMs = 1;
	const calls = mock((n) => (n < 3 ? { status: 429 } : { rows: ROWS }));
	const el = start();
	await wait(80);
	assert.strictEqual(calls.length, 3);
	assert.ok(/gene pairs/.test(el.textContent));
	assert.ok(!/busy/.test(el.textContent));
});

test('main shows the status and a Retry button after repeated 429', async () => {
	tool.settings.backoffMs = 1;
	const calls = mock(() => ({ status: 429 }));
	const el = start();
	await wait(80);
	assert.strictEqual(calls.length, 4);
	assert.ok(/The mine is busy \(HTTP 429\)/.test(el.textContent));
	const retry = el.find('button').find((b) => b.textContent === 'Retry');
	assert.ok(retry);
	mock(() => ({ rows: ROWS }));
	retry.listeners.click();
	await wait(40);
	assert.ok(/gene pairs/.test(el.textContent));
});

test('main shows the status for a server error without retrying', async () => {
	const calls = mock(() => ({ status: 500 }));
	const el = start();
	await wait(40);
	assert.strictEqual(calls.length, 1);
	assert.ok(/The mine returned HTTP 500/.test(el.textContent));
});

test('main shows a message when the request is rejected', async () => {
	globalThis.fetch = () => Promise.reject(new TypeError('network'));
	const el = start();
	await wait(40);
	assert.ok(/Could not reach the mine/.test(el.textContent));
	assert.ok(el.find('button').some((b) => b.textContent === 'Retry'));
});

test('main aborts a hung request after the timeout', async () => {
	tool.settings.timeoutMs = 20;
	let signal;
	globalThis.fetch = (url, opts) => {
		signal = opts.signal;
		return new Promise((resolve, reject) => {
			opts.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
		});
	};
	const el = start();
	await wait(80);
	tool.settings.timeoutMs = 60000;
	assert.ok(signal && signal.aborted);
	assert.ok(/did not answer within/.test(el.textContent));
});

test('a stale response does not overwrite a newer one', async () => {
	let release;
	const first = new Promise((r) => { release = r; });
	let n = 0;
	globalThis.fetch = () => {
		n += 1;
		if (n === 1) return first;
		return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ results: HUB_ROWS }) });
	};
	const el = document.createElement('div');
	const entity = { Gene: { value: [1, 2, 3, 4], class: 'Gene' } };
	tool.main(el, { root: 'http://h/mine' }, entity, {}, {}, () => {});
	tool.main(el, { root: 'http://h/mine' }, entity, {}, {}, () => {});
	await wait(30);
	release({ ok: true, status: 200, json: () => Promise.resolve({ results: ROWS }) });
	await wait(30);
	assert.ok(/5 gene pairs/.test(el.textContent) === false);
	assert.ok(/9 pair-method records/.test(el.textContent));
});

test('an empty result with no interaction data says so', async () => {
	const calls = mock((n) => (n === 1 ? { rows: [] } : { text: '0' }));
	const el = start();
	await wait(40);
	assert.strictEqual(calls.length, 2);
	assert.ok(/format=count/.test(calls[1].body));
	assert.ok(/Gene\.interactions\.id" op="IS NOT NULL"/.test(calls[1].body));
	assert.ok(/None of the 4 genes has interaction data/.test(el.textContent));
});

test('an empty result with interaction data elsewhere says how many genes have it', async () => {
	mock((n) => (n === 1 ? { rows: [] } : { text: '3' }));
	const el = start();
	await wait(40);
	assert.ok(/3 of 4 genes have interaction data in AllianceMine, none of them with another gene in this set/.test(el.textContent));
});

test('an empty result falls back to the plain message when the count fails', async () => {
	mock((n) => (n === 1 ? { rows: [] } : { status: 500 }));
	const el = start();
	await wait(40);
	assert.ok(/No interactions among these genes/.test(el.textContent));
});

test('the request timer is cleared when the response parser throws', async () => {
	const live = new Set();
	const realSet = globalThis.setTimeout;
	const realClear = globalThis.clearTimeout;
	globalThis.setTimeout = (f, ms, ...a) => {
		const id = realSet(() => { live.delete(id); f(...a); }, ms);
		if (ms === tool.settings.timeoutMs) live.add(id);
		return id;
	};
	globalThis.clearTimeout = (id) => { live.delete(id); realClear(id); };
	try {
		mock((n) => (n === 1 ? { rows: [] } : { text: '0' }));
		const base = globalThis.fetch;
		globalThis.fetch = (url, opts) => base(url, opts).then((res) => (
			/format=count/.test(String(opts.body)) ? Object.assign({}, res, { text: () => { throw new Error('boom'); } }) : res
		));
		start();
		await wait(40);
		assert.strictEqual(live.size, 0);
	} finally {
		live.forEach((id) => realClear(id));
		globalThis.setTimeout = realSet;
		globalThis.clearTimeout = realClear;
	}
});

test('a result of self rows only is shown, not reported as empty', async () => {
	mock(() => ({ rows: [ROWS[5]] }));
	const el = start();
	await wait(40);
	assert.ok(/0 gene pairs, 1 pair-method records, 0 genes with partners, 1 with self-interactions/.test(el.textContent));
	assert.ok(!/No interactions/.test(el.textContent));
});

test('tables have a caption and column scopes, and gene links are buttons', async () => {
	mock(() => ({ rows: ROWS }));
	const el = start();
	await wait(40);
	const tables = el.find('table');
	assert.ok(tables.length >= 2);
	tables.forEach((t) => assert.ok(t.find('caption').length === 1));
	el.find('th').forEach((th) => assert.strictEqual(th.getAttribute('scope'), 'col'));
	assert.strictEqual(el.find('a').filter((a) => a.attrs && a.attrs.href === '#').length, 0);
	assert.ok(el.find('button').some((b) => b.textContent === 'AAA'));
});

test('gene buttons and network nodes navigate to the gene report', async () => {
	mock(() => ({ rows: ROWS }));
	const nav = [];
	const el = document.createElement('div');
	tool.main(el, { root: 'http://h/mine' }, { Gene: { value: [1, 2, 3, 4] } }, {}, {}, (...a) => nav.push(a));
	await wait(40);
	el.find('button').find((b) => b.textContent === 'AAA').listeners.click();
	const node = el.find('circle').find((c) => c.getAttribute('role') === 'link');
	node.listeners.keydown({ key: 'Enter', preventDefault() {} });
	node.listeners.click();
	assert.deepStrictEqual(nav[0], ['report', { type: 'Gene', id: 1 }]);
	assert.strictEqual(nav.length, 3);
});

test('network nodes are focusable and the top 20 carry a text label', async () => {
	const rows = [];
	for (let i = 1; i <= 30; i++) rows.push([1, 'H:0', 'HUB', i + 1, 'H:' + i, 'G' + i, PHYS, 'm', null]);
	mock(() => ({ rows }));
	const el = start();
	await wait(40);
	const circles = el.find('circle').filter((c) => c.getAttribute('class') === 'agr-node');
	assert.strictEqual(circles.length, 31);
	circles.forEach((c) => assert.strictEqual(c.getAttribute('tabindex'), '0'));
	assert.strictEqual(el.find('text').length, 20);
	assert.strictEqual(el.find('text')[0].textContent, 'HUB');
	assert.ok(el.find('svg')[0].getAttribute('aria-label'));
});

test('a gene with a self interaction gets a ring marker', async () => {
	mock(() => ({ rows: ROWS }));
	const el = start();
	await wait(40);
	assert.strictEqual(el.find('circle').filter((c) => c.getAttribute('class') === 'agr-self').length, 1);
});

test('downloads use a Blob URL and revoke it', async () => {
	mock(() => ({ rows: ROWS }));
	const el = start();
	await wait(40);
	const made = [];
	const revoked = [];
	const real = [URL.createObjectURL, URL.revokeObjectURL];
	URL.createObjectURL = (b) => { made.push(b); return 'blob:x'; };
	URL.revokeObjectURL = (u) => revoked.push(u);
	el.find('button').find((b) => b.textContent === 'Download TSV').listeners.click();
	[URL.createObjectURL, URL.revokeObjectURL] = real;
	assert.strictEqual(made.length, 1);
	assert.ok(made[0] instanceof Blob);
	assert.strictEqual(await made[0].text(), tool.toTsv(tool.buildEdges(ROWS)));
	await wait(1100);
});

test('show more moves focus to the first new row', async () => {
	const rows = [];
	for (let i = 1; i <= 150; i++) rows.push([1, 'H:0', 'HUB', i + 1, 'H:' + i, 'G' + i, PHYS, 'm', null]);
	mock(() => ({ rows }));
	const el = start();
	await wait(40);
	let focused = null;
	const origFind = el.find.bind(el);
	const more = el.find('button').find((b) => /^Show more/.test(b.textContent));
	assert.ok(more);
	const Node = Object.getPrototypeOf(el).constructor;
	Node.prototype.focus = function () { focused = this; };
	more.listeners.click();
	delete Node.prototype.focus;
	assert.ok(focused && focused.tag === 'tr');
	assert.strictEqual(focused.getAttribute('tabindex'), '-1');
	assert.ok(origFind);
});

test('config threshold keeps auto-start on small sets', () => {
	const cfg = require('../config.json');
	assert.ok(cfg.threshold <= 200);
});
