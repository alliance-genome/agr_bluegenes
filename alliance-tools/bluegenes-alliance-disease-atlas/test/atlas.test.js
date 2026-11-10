'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { install } = require('./dom-stub.js');
const atlas = require('../dist/bundle.js');

install();

const ROOT = 'http://localhost:9999/alliancetestmine';

// Rows: [geneId, symbol, pid, organism, termIdent, termName, qualifier, code]
const ANN = [
	[1, 'Brca1', 'MGI:1', 'M. musculus', 'DOID:162', 'cancer', 'is_implicated_in', 'ECO:1'],
	[1, 'Brca1', 'MGI:1', 'M. musculus', 'DOID:162', 'cancer', 'is_implicated_in', 'ECO:2'],
	[1, 'Brca1', 'MGI:1', 'M. musculus', 'DOID:219', 'colon cancer', 'implicated_via_orthology', null],
	[2, 'TP53', 'HGNC:2', 'H. sapiens', 'DOID:162', 'cancer', 'is_marker_for', 'ECO:3'],
	[3, 'Atm', 'MGI:3', 'M. musculus', 'DOID:162', 'cancer', 'is_not_implicated_in', 'ECO:4'],
	[2, 'TP53', 'HGNC:2', 'H. sapiens', 'DOID:162', 'cancer', 'is_not_implicated_in', null]
];
const MODELS = [
	[4, 'Egfr', 'FB:4', 'D. melanogaster', 'DOID:162', 'cancer', 'Egfr model', 'is_model_of'],
	[1, 'Brca1', 'MGI:1', 'M. musculus', 'DOID:162', 'cancer', 'Brca1 KO', 'is_model_of']
];

test('classifies qualifiers', () => {
	assert.strictEqual(atlas.isNegated('is_not_implicated_in'), true);
	assert.strictEqual(atlas.isNegated('implicated_via_orthology'), false);
	assert.strictEqual(atlas.isNegated('biomarker_via_orthology'), false);
	assert.strictEqual(atlas.isViaOrthology('biomarker_via_orthology'), true);
	assert.strictEqual(atlas.isViaOrthology('is_marker_for'), false);
});

test('group splits evidence, counts per organism, lists NOT separately', () => {
	const g = atlas.group(ANN, MODELS);
	assert.deepStrictEqual(g.organisms.map((o) => o.name), ['D. melanogaster', 'H. sapiens', 'M. musculus']);
	const mouse = g.organisms[2];
	assert.deepStrictEqual(mouse.genes.map((x) => x.symbol), ['Brca1']);
	assert.deepStrictEqual(mouse.notGenes.map((x) => x.symbol), ['Atm']);
	const brca1 = mouse.genes[0];
	assert.deepStrictEqual(Object.values(brca1.direct)[0].codes, ['ECO:1', 'ECO:2']);
	assert.strictEqual(Object.keys(brca1.orthology).length, 1);
	assert.strictEqual(Object.keys(brca1.models).length, 1);
	// TP53 has a direct and a NOT annotation: counted and listed as NOT.
	const human = g.organisms[1];
	assert.strictEqual(human.genes.length, 1);
	assert.strictEqual(human.notGenes.length, 1);
	assert.strictEqual(g.geneCount, 3);
	assert.strictEqual(g.notCount, 2);
});

test('geneQueryObject is a PathQuery on Gene.id', () => {
	const q = atlas.geneQueryObject([{ id: 7 }, { id: 9 }]);
	assert.strictEqual(q.from, 'Gene');
	assert.deepStrictEqual(q.where, [{ path: 'Gene.id', op: 'ONE OF', values: ['7', '9'] }]);
});

test('queries escape values and constrain children by parents', () => {
	assert.match(atlas.childTermsQuery('1"><x/>'), /DOTerm\.parents\.id" op="=" value="1&quot;&gt;&lt;x\/&gt;"/);
	assert.match(atlas.annotationQuery(['DOID:1', 'a&b']), /<value>a&amp;b<\/value>/);
	assert.match(atlas.annotationQuery(['DOID:1']), /Gene\.diseaseAnnotation\.ontologyTerm\.identifier" op="ONE OF"/);
	assert.match(atlas.modelQuery(['DOID:1']), /Gene\.diseaseModels\.disease\.identifier" op="ONE OF"/);
});

function stubFetch(handlers) {
	const calls = [];
	globalThis.fetch = async (url, opts) => {
		const params = new URLSearchParams(opts.body);
		const q = params.get('query');
		calls.push({ url, method: opts.method, query: q });
		const h = handlers.find((x) => x.when.test(q));
		return { ok: true, json: async () => ({ results: h ? h.rows : [] }) };
	};
	return calls;
}

const tick = () => new Promise((r) => setTimeout(r, 20));

function fakeEl() {
	const el = document.createElement('div');
	return el;
}

function findAll(node, tag, out = []) {
	return node.find(tag, out);
}

test('main loads the term, annotations and models and renders per organism', async () => {
	const calls = stubFetch([
		{ when: /DOTerm\.id" op="="/, rows: [[10, 'DOID:162', 'cancer']] },
		{ when: /Gene\.diseaseModels/, rows: MODELS },
		{ when: /diseaseAnnotation/, rows: ANN }
	]);
	const el = fakeEl();
	const nav = [];
	atlas.main(el, { root: ROOT }, { DOTerm: { class: 'DOTerm', format: 'id', value: 10 } }, {}, {}, (...a) => nav.push(a));
	await tick();
	assert.ok(calls.every((c) => c.url === ROOT + '/service/query/results' && c.method === 'POST'));
	assert.strictEqual(calls.length, 3);
	const text = el.textContent;
	assert.match(text, /3 genes in 3 organisms annotated to cancer/);
	assert.match(text, /2 genes annotated NOT/);
	assert.match(text, /M\. musculus \(1 genes\)/);
	assert.match(text, /is_implicated_in \(ECO:1, ECO:2\)/);
	assert.match(text, /Annotated NOT \(1\): Atm/);
	const buttons = findAll(el, 'button');
	assert.strictEqual(buttons.length, 3);
	buttons[2].listeners.click();
	assert.strictEqual(nav[0][0], 'query');
	assert.strictEqual(nav[0][1].where[0].values[0], '1');
	const links = findAll(el, 'a').filter((a) => a.textContent === 'TP53');
	links[0].listeners.click({ preventDefault() {} });
	assert.deepStrictEqual(nav[1], ['report', { type: 'Gene', id: 2 }]);
});

test('include child terms queries descendants and uses their identifiers', async () => {
	const calls = stubFetch([
		{ when: /DOTerm\.parents\.id/, rows: [[11, 'DOID:219', 'colon cancer'], [10, 'DOID:162', 'cancer']] },
		{ when: /DOTerm\.id" op="="/, rows: [[10, 'DOID:162', 'cancer']] },
		{ when: /Gene\.diseaseModels/, rows: [] },
		{ when: /diseaseAnnotation/, rows: ANN }
	]);
	const el = fakeEl();
	atlas.main(el, { root: ROOT + '/service' }, { DOTerm: { value: 10 } }, {}, {}, () => {});
	await tick();
	assert.strictEqual(calls.length, 3);
	const box = findAll(el, 'input')[0];
	box.checked = true;
	box.listeners.change();
	await tick();
	const annCall = calls.filter((c) => /diseaseAnnotation/.test(c.query)).pop();
	assert.match(annCall.query, /<value>DOID:162<\/value><value>DOID:219<\/value>/);
	assert.match(el.textContent, /annotated to cancer and 1 child terms/);
	assert.match(el.textContent, /is_implicated_in \(ECO:1, ECO:2\) - cancer/);
});

test('a failed request shows a message and logs', async () => {
	globalThis.fetch = async () => ({ ok: false, status: 500, json: async () => ({}) });
	const errors = [];
	const orig = console.error;
	console.error = (...a) => errors.push(a);
	const el = fakeEl();
	atlas.main(el, { root: ROOT }, { DOTerm: { value: 10 } }, {}, {}, () => {});
	await tick();
	console.error = orig;
	assert.strictEqual(errors.length, 1);
	assert.match(el.textContent, /Could not load genes/);
});

test('an older response does not overwrite a newer one', async () => {
	let release;
	const gate = new Promise((r) => { release = r; });
	let n = 0;
	globalThis.fetch = async (url, opts) => {
		const q = new URLSearchParams(opts.body).get('query');
		if (/DOTerm\.id" op="="/.test(q)) {
			const mine = ++n;
			if (mine === 1) await gate;
			return { ok: true, json: async () => ({ results: [[10, 'DOID:' + mine, mine === 1 ? 'old' : 'new']] }) };
		}
		return { ok: true, json: async () => ({ results: [] }) };
	};
	const el = fakeEl();
	const entity = { DOTerm: { value: 10 } };
	atlas.main(el, { root: ROOT }, entity, {}, {}, () => {});
	atlas.main(el, { root: ROOT }, entity, {}, {}, () => {});
	await tick();
	release();
	await tick();
	assert.match(el.textContent, /new/);
	assert.doesNotMatch(el.textContent, /old/);
});

test('missing entity value shows a message', () => {
	const el = fakeEl();
	atlas.main(el, { root: ROOT }, { DOTerm: { value: '' } }, {}, {}, () => {});
	assert.match(el.textContent, /No disease term/);
});
