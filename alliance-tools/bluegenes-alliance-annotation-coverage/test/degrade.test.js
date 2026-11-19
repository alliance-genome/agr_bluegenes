'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { install } = require('./dom-stub.js');
install();
const tool = require('../dist/bundle.js');

const tick = () => new Promise((r) => setTimeout(r, 20));

const model = (collections) => ({
	classes: {
		Gene: {
			attributes: { id: {}, primaryIdentifier: {}, symbol: {} },
			collections: Object.fromEntries(collections.map((c) => [c, { referencedType: 'Ann' }])),
			references: { organism: { referencedType: 'Organism' } }
		},
		Ann: { attributes: { id: {} } },
		Organism: { attributes: { shortName: {} } }
	}
});

test('typesFor keeps all types without a model', () => {
	assert.strictEqual(tool.typesFor({}).length, 5);
});

test('typesFor drops types whose collection is missing from the model', () => {
	const keys = tool.typesFor({ model: model(['goAnnotation', 'publications']) }).map((t) => t.key);
	assert.deepStrictEqual(keys, ['go', 'publications']);
});

function stub(queries) {
	globalThis.fetch = async (url, init) => {
		const q = decodeURIComponent(init.body.split('query=')[1]);
		queries.push(q);
		if (q.includes('Gene.primaryIdentifier')) return { ok: true, json: async () => ({ results: [[1, 'FB:1', 'a', 'Fly'], [2, 'FB:2', 'b', 'Fly']] }) };
		return { ok: true, json: async () => ({ results: [[1, 10]] }) };
	};
}

async function run(service, context) {
	const el = document.createElement('div');
	tool.main(el, service, { Gene: { value: [1, 2] } }, {}, {}, () => {}, context);
	await tick();
	return el;
}

test('missing collections are never queried and are named in a note', async () => {
	const queries = [];
	stub(queries);
	const el = await run({ root: 'http://h/mine', model: model(['goAnnotation', 'alleles']) });
	assert.ok(!queries.some((q) => q.includes('diseaseAnnotation') || q.includes('phenotypeAnnotations') || q.includes('Gene.publications')));
	assert.deepStrictEqual(el.find('th').map((t) => t.textContent).slice(0, 4), ['Organism', 'Genes', 'GO', 'Alleles']);
	assert.ok(el.textContent.includes('This mine has no annotations for: Disease, Phenotype, Publications.'));
});

test('a model with none of the collections shows the empty message', async () => {
	stub([]);
	const el = await run({ root: 'http://h/mine', model: model([]) });
	assert.ok(el.textContent.includes('No annotation coverage to show'));
});

test('without context the save controls are absent, with it they are shown', async () => {
	stub([]);
	const bare = await run({ root: 'http://h/mine' });
	assert.strictEqual(bare.find('select').length, 0);
	const withCtx = await run({ root: 'http://h/mine' }, { saveList: async () => 'x' });
	assert.strictEqual(withCtx.find('select').length, 1);
	const button = withCtx.find('button').find((b) => /^Save /.test(b.textContent));
	assert.strictEqual(button.textContent, 'Save 1 genes without GO as list');
});

test('save sends the ids of genes without the chosen type', async () => {
	stub([]);
	let sent;
	const el = await run({ root: 'http://h/mine' }, { saveList: async (a) => { sent = a; return a.name; } });
	const button = el.find('button').find((b) => /^Save /.test(b.textContent));
	button.listeners.click();
	await tick();
	assert.deepStrictEqual(sent.ids, [2]);
	assert.strictEqual(sent.class, 'Gene');
	assert.ok(el.textContent.includes('Saved list genes_without_go_annotations_'));
});

test('anonymous users get a login message when saving is rejected', async () => {
	stub([]);
	const el = await run({ root: 'http://h/mine' }, { saveList: () => Promise.reject(new Error('login required')) });
	el.find('button').find((b) => /^Save /.test(b.textContent)).listeners.click();
	await tick();
	assert.ok(el.textContent.includes('Log in to save lists'));
});

test('an HTTP 500 fails the whole tool', async () => {
	globalThis.fetch = async () => ({ ok: false, status: 500 });
	const orig = console.error;
	console.error = () => {};
	const el = await run({ root: 'http://h/mine' });
	console.error = orig;
	assert.ok(el.textContent.includes('Could not load annotation coverage'));
});
