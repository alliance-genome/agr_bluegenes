'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { install } = require('./dom-stub.js');
install();
const tool = require('../dist/bundle.js');

const tick = () => new Promise((r) => setTimeout(r, 10));

// Two list genes linked at identity 90. Annotation collections named in status are rejected.
function stub(status) {
	globalThis.fetch = async (url, init) => {
		const q = decodeURIComponent(init.body.split('query=')[1]);
		for (const k of Object.keys(status)) {
			if (q.includes('Gene.' + k + '.id') && !q.includes('Gene.paralogues')) return { ok: false, status: status[k] };
		}
		let results = [];
		if (q.includes('Gene.primaryIdentifier')) {
			results = [[1, 'FB:1', 'aaa', 'D. melanogaster'], [2, 'FB:2', 'bbb', 'D. melanogaster']];
		} else if (q.includes('Gene.paralogues.paralogue.id')) results = [[1, 2, 90, 95, 1]];
		else if (q.includes('Gene.paralogues.id')) results = [[1, 'D. melanogaster']];
		else if (q.includes('Gene.diseaseAnnotation.id')) results = [[2, 10], [2, 11]];
		else if (q.includes('Gene.phenotypeAnnotations.id')) results = [[1, 20]];
		return { ok: true, json: async () => ({ results }) };
	};
}

async function keepOne() {
	const el = document.createElement('div');
	tool.main(el, { root: 'http://h/mine' }, { Gene: { value: [1, 2] } }, {}, {}, () => {});
	await tick();
	const btn = el.find('button').find((b) => b.textContent === 'Keep one per family');
	btn.listeners.click();
	await tick();
	return el;
}

test('with both collections the count uses disease plus phenotype rows', async () => {
	stub({});
	const el = await keepOne();
	assert.ok(el.textContent.includes('the member with the most disease plus phenotype annotation rows'));
	assert.strictEqual(el.find('textarea')[0].value, 'FB:2');
});

test('a phenotype collection rejected with HTTP 400 leaves disease counts and a note', async () => {
	stub({ phenotypeAnnotations: 400 });
	const el = await keepOne();
	assert.ok(el.textContent.includes('the member with the most disease annotation rows'));
	assert.ok(el.textContent.includes('This mine has no phenotype annotations.'));
	assert.strictEqual(el.find('textarea')[0].value, 'FB:2');
});

test('both collections rejected falls back to first by symbol', async () => {
	stub({ phenotypeAnnotations: 400, diseaseAnnotation: 400 });
	const el = await keepOne();
	assert.ok(el.textContent.includes('annotation counts unavailable'));
	assert.strictEqual(el.find('textarea')[0].value, 'FB:1');
});

test('an annotation query failing with HTTP 500 falls back to first by symbol', async () => {
	stub({ diseaseAnnotation: 500 });
	const orig = console.error;
	console.error = () => {};
	const el = await keepOne();
	console.error = orig;
	assert.ok(el.textContent.includes('annotation counts unavailable'));
});
