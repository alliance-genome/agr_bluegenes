'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { install } = require('./dom-stub.js');
const Node = install();
const tool = require('../dist/bundle.js');

const row = (id, name, geneId, pid, symbol) => [id, name, geneId, pid, symbol];
const tick = () => new Promise((r) => setTimeout(r, 5));
const ok = (results) => ({ ok: true, json: async () => ({ results }) });

function freshDocument() {
	const head = new Node('head');
	document.head = head;
	delete globalThis.Reactome;
	return head;
}

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

test('main shows a non-Reactome message and loads no script', async () => {
	const head = freshDocument();
	globalThis.fetch = async () => ok([row('GLYSYN-THR-PWY', 'glycine biosynthesis IV', 5, 'YER1', 'SHM1')]);
	const el = document.createElement('div');
	tool.main(el, { root: 'http://h/mine' }, { Pathway: { value: '7' } }, {}, {}, () => {});
	await tick();
	assert.ok(el.textContent.includes('Not a Reactome pathway'));
	assert.strictEqual(head.find('script').length, 0);
	assert.strictEqual(el.find('img').length, 0);
});

test('main posts to the given service root', async () => {
	freshDocument();
	let url;
	globalThis.fetch = async (u) => { url = u; return ok([]); };
	tool.main(document.createElement('div'), { root: 'http://h/mine/' }, { Pathway: { value: '7' } }, {}, {}, () => {});
	await tick();
	assert.strictEqual(url, 'http://h/mine/service/query/results');
});

test('main falls back to the static image when the viewer script fails', async () => {
	const head = freshDocument();
	globalThis.fetch = async () => ok([row('R-HSA-109581', 'Apoptosis', 1, 'HGNC:10019', 'RIPK1')]);
	const el = document.createElement('div');
	tool.main(el, { root: 'http://h/mine' }, { Pathway: { value: '7' } }, {}, {}, () => {});
	await tick();
	const scripts = head.find('script');
	assert.strictEqual(scripts.length, 1);
	assert.ok(scripts[0].src.includes('reactome.org/DiagramJs/diagram/diagram.nocache.js'));
	scripts[0].onerror();
	const imgs = el.find('img');
	assert.strictEqual(imgs.length, 1);
	assert.strictEqual(imgs[0].src, 'https://reactome.org/ContentService/exporter/diagram/R-HSA-109581.png');
	assert.ok(el.textContent.includes('RIPK1'));
	assert.ok(el.find('a').some((a) => a.href === 'https://reactome.org/PathwayBrowser/#/R-HSA-109581'));
});

test('main creates the viewer and flags the genes when the script loads', async () => {
	const head = freshDocument();
	globalThis.fetch = async () => ok([
		row('R-HSA-109581', 'Apoptosis', 1, 'HGNC:10019', 'RIPK1'),
		row('R-HSA-109581', 'Apoptosis', 2, 'HGNC:10251', 'ROCK1')
	]);
	const calls = { loaded: null, flagged: null, opts: null };
	globalThis.Reactome = {
		Diagram: {
			create(opts) {
				calls.opts = opts;
				return { loadDiagram: (id) => { calls.loaded = id; }, flagItems: (t) => { calls.flagged = t; } };
			}
		}
	};
	const el = document.createElement('div');
	tool.main(el, { root: 'http://h/mine' }, { Pathway: { value: '7' } }, {}, {}, () => {});
	await tick();
	assert.strictEqual(head.find('script').length, 0);
	assert.strictEqual(calls.loaded, 'R-HSA-109581');
	assert.strictEqual(calls.flagged, 'RIPK1,ROCK1');
	assert.ok(calls.opts.placeHolder);
	assert.strictEqual(el.find('img').length, 0);
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
});
