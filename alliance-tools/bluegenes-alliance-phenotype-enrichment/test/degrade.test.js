'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { install } = require('./dom-stub.js');
install();
const tool = require('../dist/bundle.js');

const tick = () => new Promise((r) => setTimeout(r, 10));

// Gene-level phenotype paths answer; any query on Gene.alleles is rejected with HTTP 400.
function noAlleleFetch(log) {
	return async (url, init) => {
		const body = decodeURIComponent(init.body);
		log.push(body);
		if (body.includes('Gene.alleles.')) return { ok: false, status: 400 };
		let results;
		if (body.includes('summaryPath=')) results = [['H. sapiens', 100]];
		else if (body.includes('view="Gene.id Gene.organism.shortName"') && body.includes('path="Gene.id"')) {
			results = [[1, 'H. sapiens'], [2, 'H. sapiens']];
		} else if (body.includes('path="Gene.organism.shortName"')) {
			results = [[1, 'MP:1'], [2, 'MP:1'], [3, 'MP:1']];
		} else {
			results = [[1, 10, 901, 'MP:1', 'term a'], [2, 11, 901, 'MP:1', 'term a']];
		}
		return { ok: true, json: async () => ({ results }) };
	};
}

test('allele path rejected with HTTP 400 falls back to gene annotations with a note', async () => {
	const log = [];
	globalThis.fetch = noAlleleFetch(log);
	const el = document.createElement('div');
	tool.main(el, { root: 'http://h/mine' }, { Gene: { value: ['1', '2'] } }, {}, {}, () => {});
	await tick();
	const box = el.find('input')[1];
	box.checked = true;
	box.listeners.change();
	await tick();
	await tick();
	assert.ok(log.some((b) => b.includes('Gene.alleles.')));
	const text = el.textContent;
	assert.ok(text.includes('This mine has no allele phenotype annotations'));
	assert.ok(text.includes('term a'));
	assert.strictEqual(el.find('input')[1].disabled, true);
	assert.strictEqual(el.find('input')[1].checked, false);
});

test('gene phenotype path rejected with HTTP 400 still fails the tool', async () => {
	globalThis.fetch = async () => ({ ok: false, status: 400 });
	const orig = console.error;
	console.error = () => {};
	const el = document.createElement('div');
	tool.main(el, { root: 'http://h/mine' }, { Gene: { value: ['1'] } }, {}, {}, () => {});
	await tick();
	console.error = orig;
	assert.ok(el.textContent.includes('Could not compute phenotype enrichment'));
});
