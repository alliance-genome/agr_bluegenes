'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { install } = require('./dom-stub.js');
install();
const tool = require('../dist/bundle.js');

const tick = () => new Promise((r) => setTimeout(r, 10));

function stub(opts) {
	globalThis.fetch = async (url, init) => {
		const q = decodeURIComponent(init.body.split('query=')[1]);
		if (opts.phenotypesStatus && q.includes('PhenotypeAnnotation')) {
			return { ok: false, status: opts.phenotypesStatus };
		}
		let results = [];
		if (q.includes('view="Organism.shortName"')) {
			results = [['H. sapiens'], ['M. musculus'], ['A. flavus NRRL3357'], ['S. cerevisiae']];
		} else if (q.includes('view="Gene.id')) results = [[1, 'HGNC:1', 'TP53', 'H. sapiens']];
		else if (q.includes('Homologue.gene.id')) results = [[1, 2, 'Trp53', 'MGI:2', 'M. musculus']];
		else if (q.includes('PhenotypeAnnotation')) results = [[2, 'abnormal x']];
		else if (q.includes('DiseaseAnnotation')) results = [[1, 'is_implicated_in', 'cancer']];
		return { ok: true, json: async () => ({ results }) };
	};
}

test('columns are the organisms with a gene or ortholog, not every organism of the mine', async () => {
	stub({});
	const el = document.createElement('div');
	tool.main(el, { root: 'http://h/mine' }, { Gene: { value: [1] } }, {}, {}, () => {});
	await tick();
	assert.deepStrictEqual(el.find('th').map((c) => c.textContent), ['Gene', 'H. sapiens', 'M. musculus']);
});

test('phenotype query rejected with HTTP 400 leaves disease counts and a note', async () => {
	stub({ phenotypesStatus: 400 });
	const el = document.createElement('div');
	tool.main(el, { root: 'http://h/mine' }, { Gene: { value: [1] } }, {}, {}, () => {});
	await tick();
	assert.deepStrictEqual(el.find('button').map((b) => b.textContent), ['1', '0']);
	assert.ok(el.textContent.includes('This mine has no phenotype annotations'));
	assert.ok(!el.textContent.includes('Phenotype ontologies differ'));
});

test('phenotype query failing with HTTP 500 still fails the tool', async () => {
	stub({ phenotypesStatus: 500 });
	const orig = console.error;
	console.error = () => {};
	const el = document.createElement('div');
	tool.main(el, { root: 'http://h/mine' }, { Gene: { value: [1] } }, {}, {}, () => {});
	await tick();
	console.error = orig;
	assert.ok(el.textContent.includes('Could not load the species matrix'));
});
