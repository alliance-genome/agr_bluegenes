'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { install } = require('./dom-stub.js');
install();
const tool = require('../dist/bundle.js');

const tick = () => new Promise((r) => setTimeout(r, 10));
const attrs = (...names) => Object.fromEntries(names.map((n) => [n, {}]));

// Models shaped like service.model.classes, reduced to the fields the tool queries.
// AllianceMine has everything; FlyMine has alleles and paralogues but no disease models
// and no allele type or category; YeastMine has alleles with fewer fields and nothing else.
function model(kind) {
	const alleleAttrs = { alliance: ['id', 'primaryIdentifier', 'alleleSymbol', 'symbol', 'alleleType', 'category'], fly: ['id', 'primaryIdentifier', 'alleleSymbol', 'symbol'], yeast: ['id', 'primaryIdentifier', 'symbol'] }[kind];
	const gene = { attributes: attrs('id', 'primaryIdentifier', 'symbol'), collections: { alleles: { referencedType: 'Allele' } }, references: { organism: { referencedType: 'Organism' } } };
	const classes = {
		Gene: gene,
		Organism: { attributes: attrs('shortName') },
		Allele: { attributes: attrs(...alleleAttrs), collections: {} }
	};
	if (kind !== 'yeast') {
		classes.Allele.collections = {
			phenotypeAnnotations: { referencedType: 'PhenotypeAnnotation' },
			diseaseAnnotations: { referencedType: 'DiseaseAnnotation' }
		};
		classes.PhenotypeAnnotation = { attributes: attrs('id') };
		classes.DiseaseAnnotation = { attributes: attrs('id') };
		gene.collections.paralogues = { referencedType: 'Paralogue' };
		classes.Paralogue = {
			attributes: attrs('id', 'identity', 'similarity', 'rank', 'predictionMethodsMatched', 'predictionMethodsNotMatched'),
			references: { paralogue: { referencedType: 'Gene' } }
		};
	}
	if (kind === 'alliance') {
		gene.collections.diseaseModels = { referencedType: 'DiseaseModel' };
		classes.DiseaseModel = {
			attributes: attrs('id', 'modelName', 'associationType', 'dataProvider'),
			references: { disease: { referencedType: 'Disease' } }
		};
		classes.Disease = { attributes: attrs('name') };
	}
	return { classes };
}

test('availableTabs: AllianceMine has all three, FlyMine alleles and paralogs, YeastMine alleles only', () => {
	const keys = (kind) => tool.availableTabs({ model: model(kind) }).map((t) => t.key);
	assert.deepStrictEqual(keys('alliance'), ['alleles', 'models', 'paralogs']);
	assert.deepStrictEqual(keys('fly'), ['alleles', 'paralogs']);
	assert.deepStrictEqual(keys('yeast'), ['alleles']);
	assert.deepStrictEqual(tool.availableTabs({}).map((t) => t.key), ['alleles', 'models', 'paralogs'], 'no model passed');
});

test('alleleColumns follows the model', () => {
	const c = (kind) => tool.alleleColumns({ model: model(kind) });
	assert.deepStrictEqual([c('alliance').type, c('alliance').category, c('alliance').phenotypes, c('alliance').diseases], [true, true, true, true]);
	assert.deepStrictEqual([c('fly').type, c('fly').category, c('fly').phenotypes, c('fly').diseases], [false, false, true, true]);
	assert.deepStrictEqual([c('yeast').type, c('yeast').category, c('yeast').phenotypes, c('yeast').diseases], [false, false, false, false]);
	assert.strictEqual(c('yeast').view.length, 4);
	assert.ok(!c('yeast').view.includes('Gene.alleles.alleleSymbol'));
});

test('toAlleleRow reads a reduced view by column name', () => {
	const view = ['Gene.primaryIdentifier', 'Gene.alleles.id', 'Gene.alleles.primaryIdentifier', 'Gene.alleles.symbol'];
	const r = tool.toAlleleRow(['S000001', 7, 'YAL001W-a1', 'tfc3-1'], {}, {}, view);
	assert.deepStrictEqual([r.source, r.id, r.identifier, r.symbol, r.type, r.category], ['S000001', 7, 'YAL001W-a1', 'tfc3-1', '', '']);
});

test('main in a FlyMine-like model sends no disease model query and shows two tabs', async () => {
	const queries = [];
	globalThis.fetch = async (url, init) => {
		const body = new URLSearchParams(init.body);
		queries.push(body.get('query'));
		if (body.get('format') === 'count') return { ok: true, text: async () => '0' };
		return { ok: true, json: async () => ({ results: [] }) };
	};
	const el = document.createElement('div');
	tool.main(el, { root: 'http://h/mine', model: model('fly') }, { Gene: { value: '42' } }, {}, {}, () => {});
	await tick();
	assert.ok(queries.length > 0);
	assert.ok(!queries.some((q) => q.includes('diseaseModels')));
	assert.ok(queries.some((q) => q.includes('Gene.paralogues.id')));
	assert.deepStrictEqual(el.find('button').map((b) => b.textContent.replace(/ \(\d+\)/, '')), ['Alleles', 'Paralogs']);
});

test('main in a YeastMine-like model sends only the allele query and shows one tab', async () => {
	const queries = [];
	globalThis.fetch = async (url, init) => {
		const body = new URLSearchParams(init.body);
		queries.push(body.get('query'));
		if (body.get('format') === 'count') return { ok: true, text: async () => '0' };
		return { ok: true, json: async () => ({ results: [] }) };
	};
	const el = document.createElement('div');
	tool.main(el, { root: 'http://h/mine', model: model('yeast') }, { Gene: { value: '42' } }, {}, {}, () => {});
	await tick();
	assert.ok(queries.length > 0);
	assert.ok(queries.every((q) => !/paralogues|diseaseModels|phenotypeAnnotations|diseaseAnnotations|alleleType|alleleSymbol/.test(q)));
	assert.deepStrictEqual(el.find('button').map((b) => b.textContent.replace(/ \(\d+\)/, '')), ['Alleles']);
});
