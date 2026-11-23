'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { install } = require('./dom-stub.js');
const Node = install();
const tool = require('../dist/bundle.js');

const row = (id, name, geneId, pid, symbol) => [id, name, geneId, pid, symbol];
const tick = () => new Promise((r) => setTimeout(r, 5));
const ok = (results) => ({ ok: true, json: async () => ({ results }) });

const fs = require('node:fs');
const path = require('node:path');
const fixture = (n) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', n), 'utf8'));

function freshDocument() {
	const head = new Node('head');
	document.head = head;
	tool.timing.requestMs = 200;
	tool.timing.iframeMs = 30;
	tool.timing.backoffMs = [1, 1, 1];
	return head;
}

const dmeRows = () => fixture('dme-genes.json').results.map((r) => row(r[1], 'Apoptosis', r[2], 'FBgn' + r[2], r[3]));
const mount = (el, service = { root: 'http://h/mine' }, context) =>
	tool.main(el, service, { Pathway: { value: '7' } }, {}, {}, () => {}, context);
const buttons = (el) => el.find('button');
const byText = (el, re) => buttons(el).find((b) => re.test(b.textContent));

test('isReactomeId accepts the seven Alliance species prefixes', () => {
	['HSA', 'MMU', 'RNO', 'DRE', 'DME', 'CEL', 'SCE'].forEach((p) =>
		assert.strictEqual(tool.isReactomeId('R-' + p + '-109581'), true, p)
	);
});

test('isReactomeId rejects other identifiers', () => {
	['GLYSYN-THR-PWY', 'R-HSA-', 'R-HSA-12a', 'xR-HSA-1', '', null, undefined].forEach((v) =>
		assert.strictEqual(tool.isReactomeId(v), false, String(v))
	);
});

test('urls point at Reactome', () => {
	assert.strictEqual(tool.diagramImageUrl('R-HSA-1'), 'https://reactome.org/ContentService/exporter/diagram/R-HSA-1.png');
	assert.strictEqual(tool.browserUrl('R-HSA-1'), 'https://reactome.org/PathwayBrowser/#/R-HSA-1');
});

test('buildQuery filters on Pathway.id and escapes it', () => {
	const q = tool.buildQuery('1"><x/>');
	assert.ok(q.includes('path="Pathway.id" op="="'));
	assert.ok(q.includes('value="1&quot;&gt;&lt;x/&gt;"'));
	assert.ok(q.includes('Pathway.genes.symbol'));
});

test('toGenes drops rows without a gene and sorts by symbol', () => {
	const genes = tool.toGenes([
		row('R-HSA-1', 'P', 2, 'HGNC:2', 'ZED'),
		row('R-HSA-1', 'P', null, null, null),
		row('R-HSA-1', 'P', 1, 'HGNC:1', 'ABC')
	]);
	assert.deepStrictEqual(genes.map((g) => g.symbol), ['ABC', 'ZED']);
});

test('Reactome diagram runs in a sandboxed cross-origin iframe and no script is loaded', async () => {
	const head = freshDocument();
	globalThis.fetch = async () => ok([row('R-HSA-109581', 'Apoptosis', 1, 'HGNC:10019', 'RIPK1')]);
	const el = document.createElement('div');
	mount(el);
	await tick();
	assert.strictEqual(head.find('script').length, 0);
	const frames = el.find('iframe');
	assert.strictEqual(frames.length, 1);
	assert.strictEqual(frames[0].src, 'https://reactome.org/PathwayBrowser/#/R-HSA-109581');
	assert.strictEqual(frames[0].sandbox, 'allow-scripts allow-same-origin allow-popups');
	assert.strictEqual(frames[0].referrerPolicy, 'no-referrer');
	assert.strictEqual(frames[0].loading, 'lazy');
	assert.ok(el.textContent.includes('RIPK1'));
	assert.ok(el.find('a').some((a) => a.href === 'https://reactome.org/PathwayBrowser/#/R-HSA-109581'));
	frames[0].onload();
});

test('a frame that never loads is replaced by the static image and a message', async () => {
	freshDocument();
	globalThis.fetch = async () => ok([row('R-HSA-109581', 'Apoptosis', 1, 'HGNC:10019', 'RIPK1')]);
	const el = document.createElement('div');
	mount(el);
	await tick();
	await new Promise((r) => setTimeout(r, 60));
	assert.strictEqual(el.find('iframe').length, 0);
	assert.ok(el.textContent.includes('reactome.org did not respond'));
	const imgs = el.find('img');
	assert.strictEqual(imgs.length, 1);
	assert.strictEqual(imgs[0].src, 'https://reactome.org/ContentService/exporter/diagram/R-HSA-109581.png');
	assert.strictEqual(imgs[0].style.maxWidth, '100%');
});

test('a failing static image shows a message', async () => {
	freshDocument();
	globalThis.fetch = async () => ok([row('R-HSA-109581', 'Apoptosis', 1, 'HGNC:10019', 'RIPK1')]);
	const el = document.createElement('div');
	mount(el);
	await tick();
	await new Promise((r) => setTimeout(r, 60));
	el.find('img')[0].onerror();
	assert.strictEqual(el.find('img').length, 0);
	assert.ok(el.textContent.includes('reactome.org unreachable'));
});

test('a KEGG pathway shows its genes and a note, with no diagram', async () => {
	freshDocument();
	globalThis.fetch = async () => ok([
		row('00010', 'Glycolysis / Gluconeogenesis', 5, 'FBgn1', 'Hex-A'),
		row('00010', 'Glycolysis / Gluconeogenesis', 6, 'FBgn2', 'Pfk')
	]);
	const el = document.createElement('div');
	mount(el);
	await tick();
	assert.ok(el.textContent.includes('00010 is not a Reactome pathway'));
	assert.ok(el.textContent.includes('Pfk'));
	assert.strictEqual(el.find('iframe').length, 0);
	assert.strictEqual(el.find('img').length, 0);
	assert.ok(!byText(el, /Highlight/));
});

test('main posts to the given service root with the bearer token', async () => {
	freshDocument();
	let url, headers;
	globalThis.fetch = async (u, o) => { url = u; headers = o.headers; return ok([]); };
	mount(document.createElement('div'), { root: 'http://h/mine/', token: 'abc' });
	await tick();
	assert.strictEqual(url, 'http://h/mine/service/query/results');
	assert.strictEqual(headers.Authorization, 'Bearer abc');
});

test('loading, empty and error messages carry the shared classes', async () => {
	freshDocument();
	globalThis.fetch = () => new Promise(() => {});
	const loading = document.createElement('div');
	mount(loading);
	assert.strictEqual(loading.find('span')[0].className, 'agr-loading');
	assert.strictEqual(loading.find('span')[0].attrs.role, 'status');
	globalThis.fetch = async () => ok([]);
	const empty = document.createElement('div');
	mount(empty);
	await tick();
	assert.strictEqual(empty.find('span')[0].className, 'agr-empty');
	globalThis.fetch = async () => ({ ok: false, status: 502 });
	const failed = document.createElement('div');
	mount(failed);
	await tick();
	assert.strictEqual(failed.find('span')[0].className, 'agr-error');
	assert.strictEqual(failed.find('span')[0].attrs.role, 'alert');
});

test('429 is retried with backoff and then succeeds', async () => {
	freshDocument();
	let calls = 0;
	globalThis.fetch = async () => (++calls < 3 ? { ok: false, status: 429 } : ok(dmeRows()));
	const el = document.createElement('div');
	mount(el);
	await new Promise((r) => setTimeout(r, 40));
	assert.strictEqual(calls, 3);
	assert.ok(el.textContent.includes('arm'));
});

test('persistent 429 shows the status and a Retry button that reloads', async () => {
	freshDocument();
	let calls = 0;
	let limited = true;
	globalThis.fetch = async () => { calls++; return limited ? { ok: false, status: 429 } : ok(dmeRows()); };
	const el = document.createElement('div');
	mount(el);
	await new Promise((r) => setTimeout(r, 40));
	assert.strictEqual(calls, 4);
	assert.ok(el.textContent.includes('HTTP 429'));
	limited = false;
	byText(el, /Retry/).listeners.click();
	await new Promise((r) => setTimeout(r, 20));
	assert.ok(el.textContent.includes('Aven'));
});

test('a stalled request times out with a visible message', async () => {
	freshDocument();
	tool.timing.requestMs = 20;
	globalThis.fetch = () => new Promise(() => {});
	const el = document.createElement('div');
	mount(el);
	await new Promise((r) => setTimeout(r, 60));
	assert.ok(el.textContent.includes('timeout'));
	assert.ok(byText(el, /Retry/));
});

test('a result above the cap is cut and the summary says so', async () => {
	freshDocument();
	const n = tool.MAX_GENES + 1;
	const rows = [];
	for (let i = 0; i < n; i++) rows.push(row('R-HSA-162582', 'Signal Transduction', i + 1, 'HGNC:' + i, 'G' + String(i).padStart(5, '0')));
	globalThis.fetch = async (u, o) => {
		assert.ok(o.body.includes('size=' + n));
		return ok(rows);
	};
	const el = document.createElement('div');
	mount(el);
	await tick();
	assert.ok(el.textContent.includes('first ' + tool.MAX_GENES + ' genes'));
	assert.ok(el.textContent.includes('more than ' + tool.MAX_GENES + ' genes'));
});

test('a pathway at the cap is not reported as truncated', async () => {
	freshDocument();
	const rows = [];
	for (let i = 0; i < tool.MAX_GENES; i++) rows.push(row('R-HSA-1', 'P', i + 1, 'HGNC:' + i, 'G' + i));
	globalThis.fetch = async () => ok(rows);
	const el = document.createElement('div');
	mount(el);
	await tick();
	assert.ok(!el.textContent.includes('more than'));
});

test('a pathway with no genes shows the diagram and no table controls', async () => {
	freshDocument();
	globalThis.fetch = async () => ok([row('R-HSA-1', 'P', null, null, null)]);
	const el = document.createElement('div');
	mount(el);
	await tick();
	assert.ok(el.textContent.includes('0 genes'));
	assert.strictEqual(el.find('table').length, 0);
	assert.strictEqual(el.find('iframe').length, 1);
});

test('the table shows one page, Show all expands it and the filter narrows it', async () => {
	freshDocument();
	const rows = [];
	for (let i = 0; i < tool.PAGE_SIZE + 50; i++) rows.push(row('R-HSA-1', 'P', i + 1, 'HGNC:' + i, 'G' + String(i).padStart(4, '0')));
	globalThis.fetch = async () => ok(rows);
	const el = document.createElement('div');
	mount(el);
	await tick();
	assert.strictEqual(el.find('tbody')[0].children.length, tool.PAGE_SIZE);
	byText(el, /Show all 250/).listeners.click();
	assert.strictEqual(el.find('tbody')[0].children.length, 250);
	const input = el.find('input')[0];
	input.value = 'g0007';
	input.listeners.input();
	assert.strictEqual(el.find('tbody')[0].children.length, 1);
	assert.ok(byText(el, /Copy 1 symbol$/));
});

test('Save as a list calls context.saveList with the filtered gene ids', async () => {
	freshDocument();
	globalThis.fetch = async () => ok(dmeRows());
	let args;
	const context = { saveList: async (a) => { args = a; return 'Apoptosis genes_1'; } };
	const el = document.createElement('div');
	mount(el, undefined, context);
	await tick();
	const input = el.find('input')[0];
	input.value = 'a';
	input.listeners.input();
	byText(el, /Save 4 genes/).listeners.click();
	await tick();
	assert.strictEqual(args.class, 'Gene');
	assert.deepStrictEqual(args.ids, [44348597, 44323365, 44326963, 44320090]);
	assert.ok(el.textContent.includes('as Apoptosis genes_1'));
});

test('Save is hidden without context.saveList and a rejected save shows the reason', async () => {
	freshDocument();
	globalThis.fetch = async () => ok(dmeRows());
	const plain = document.createElement('div');
	mount(plain);
	await tick();
	assert.ok(!byText(plain, /Save/));
	const el = document.createElement('div');
	mount(el, undefined, { saveList: async () => { throw new Error('login required'); } });
	await tick();
	byText(el, /Save/).listeners.click();
	await tick();
	assert.ok(el.textContent.includes('login required'));
});

test('Copy symbols writes one symbol per line', async () => {
	freshDocument();
	globalThis.fetch = async () => ok(dmeRows());
	let text;
	Object.defineProperty(globalThis, 'navigator', { value: { clipboard: { writeText: async (t) => { text = t; } } }, configurable: true });
	const el = document.createElement('div');
	mount(el);
	await tick();
	byText(el, /Copy/).listeners.click();
	await tick();
	delete globalThis.navigator;
	assert.strictEqual(text, 'Acn\nApc\nAven\narm');
});

test('human highlight passes gene symbols in the diagram URL', async () => {
	freshDocument();
	globalThis.fetch = async () => ok([row('R-HSA-1', 'P', 1, 'HGNC:1', 'ABC'), row('R-HSA-1', 'P', 2, 'HGNC:2', 'ZED')]);
	const el = document.createElement('div');
	mount(el);
	await tick();
	byText(el, /Highlight 2/).listeners.click();
	await tick();
	assert.strictEqual(el.find('iframe')[0].src, 'https://reactome.org/PathwayBrowser/#/R-HSA-1&FLG=ABC,ZED');
	assert.ok(el.textContent.includes('2 of 2 genes'));
});

test('fly highlight queries UniProt accessions, strips isoforms and dedupes', async () => {
	freshDocument();
	const bodies = [];
	globalThis.fetch = async (u, o) => {
		bodies.push(o.body);
		return bodies.length === 1 ? ok(dmeRows()) : ok(fixture('dme-proteins.json').results);
	};
	const el = document.createElement('div');
	mount(el);
	await tick();
	byText(el, /Highlight 4/).listeners.click();
	await tick();
	const q = decodeURIComponent(bodies[1].split('query=')[1]);
	assert.ok(q.includes('Gene.proteins.primaryAccession'));
	assert.ok(q.includes('<value>44320090</value>'));
	assert.strictEqual(
		el.find('iframe')[0].src,
		'https://reactome.org/PathwayBrowser/#/R-DME-109581&FLG=P18824,A0A126GV30,P91667,Q9VAS9,Q9VYK8,Q8MRH4,Q9VJ12'
	);
	assert.ok(el.textContent.includes('4 of 4 genes'));
});

test('highlight reports genes without a UniProt accession', async () => {
	freshDocument();
	let calls = 0;
	globalThis.fetch = async () => (++calls === 1 ? ok(dmeRows()) : ok([[44320090, 'P18824-2']]));
	const el = document.createElement('div');
	mount(el);
	await tick();
	byText(el, /Highlight 4/).listeners.click();
	await tick();
	assert.ok(el.textContent.includes('1 of 4 genes'));
});

test('accessionsOf drops isoform suffixes, nulls and repeats', () => {
	assert.deepStrictEqual(tool.accessionsOf([[1, 'P1-2'], [1, 'P1'], [2, null], [2, 'Q9']]), ['P1', 'Q9']);
});

test('toGenes keeps one entry per gene id', () => {
	const genes = tool.toGenes([row('R-HSA-1', 'P', 1, 'a', 'A'), row('R-HSA-1', 'P', 1, 'a', 'A')]);
	assert.strictEqual(genes.length, 1);
});

test('a stale response after a remount is ignored', async () => {
	freshDocument();
	let release;
	globalThis.fetch = () => new Promise((r) => { release = () => r(ok([row('R-HSA-1', 'Old', 1, 'a', 'OLD')])); });
	const el = document.createElement('div');
	mount(el);
	globalThis.fetch = async () => ok([row('R-HSA-2', 'New', 2, 'b', 'NEW')]);
	mount(el);
	await tick();
	release();
	await tick();
	assert.ok(el.textContent.includes('NEW'));
	assert.ok(!el.textContent.includes('OLD'));
});


test('a gene link navigates to its report', async () => {
	freshDocument();
	globalThis.fetch = async () => ok([row('R-HSA-1', 'P', 9, 'HGNC:1', 'ABC')]);
	const el = document.createElement('div');
	const calls = [];
	tool.main(el, { root: 'http://h/mine' }, { Pathway: { value: '7' } }, {}, {}, (...a) => calls.push(a));
	await tick();
	const link = el.find('a').find((a) => a.textContent === 'ABC');
	link.listeners.click({ preventDefault() {} });
	assert.deepStrictEqual(calls[0], ['report', { type: 'Gene', id: 9 }]);
});

test('main reports a failed request', async () => {
	freshDocument();
	globalThis.fetch = async () => ({ ok: false, status: 502 });
	const el = document.createElement('div');
	tool.main(el, { root: 'http://h/mine' }, { Pathway: { value: '7' } }, {}, {}, () => {});
	await tick();
	assert.ok(el.textContent.includes('Could not load'));
	assert.ok(el.textContent.includes('HTTP 502'));
});
