'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { install } = require('./dom-stub.js');
install();
const tool = require('../dist/bundle.js');

const tick = () => new Promise((r) => setTimeout(r, 100));
const GO = 'Gene.goAnnotation.id';

function idsIn(q) {
	return (q.match(/<value>[^<]*<\/value>/g) || []).map((v) => Number(v.replace(/<\/?value>/g, '')));
}

// Gene ids at or below `heavy` have more annotations than the row cap; others have one.
function stub(heavy, queries, perGene) {
	globalThis.fetch = async (url, init) => {
		const q = decodeURIComponent(init.body.split('query=')[1]);
		const ids = idsIn(q);
		if (q.includes('Gene.primaryIdentifier')) {
			return { ok: true, json: async () => ({ results: ids.map((i) => [i, 'G' + i, 's' + i, 'Fly']) }) };
		}
		if (!q.includes(GO)) return { ok: true, json: async () => ({ results: [] }) };
		const start = Number(init.body.match(/start=(\d+)/)[1]);
		if (start === 0) queries.push(ids);
		const rows = [];
		ids.forEach((id) => {
			const n = id <= heavy ? (perGene || 200000) : 1;
			for (let k = 0; k < n; k++) rows.push([id, k]);
		});
		return { ok: true, json: async () => ({ results: rows.slice(start, start + 5000) }) };
	};
}

async function run(ids, context) {
	const el = document.createElement('div');
	tool.main(el, { root: 'http://h/mine', model: { classes: { Gene: { attributes: { id: {} }, collections: { goAnnotation: { referencedType: 'A' } }, references: { organism: { referencedType: 'O' } } }, A: { attributes: { id: {} } }, O: { attributes: { shortName: {} } } } } }, { Gene: { value: ids } }, {}, {}, () => {}, context);
	await tick();
	return el;
}

test('a full chunk is halved until each part fits, so no gene is miscounted', async () => {
	const queries = [];
	stub(4, queries, 30000);
	const el = await run([1, 2, 3, 4], { saveList: async () => 'x' });
	assert.deepStrictEqual(queries.map((q) => q.length), [4, 2, 2]);
	assert.ok(!el.textContent.includes('Incomplete'));
	assert.ok(el.textContent.includes('4 of 4 (100%)'));
	assert.ok(el.find('button').some((b) => /^Save 0 genes without GO/.test(b.textContent)));
});

test('a single gene over the row cap marks the type incomplete and disables saving', async () => {
	const queries = [];
	stub(1, queries);
	const el = await run([1, 2], { saveList: async () => 'x' });
	assert.ok(queries.some((q) => q.length === 1 && q[0] === 1));
	assert.ok(el.textContent.includes('Incomplete: a single gene exceeds 100000 rows for GO'));
	const button = el.find('button').find((b) => /^Cannot save/.test(b.textContent));
	assert.ok(button);
	assert.strictEqual(button.disabled, true);
});

test('genes other than the heavy one keep exact counts after the split', async () => {
	const queries = [];
	stub(1, queries);
	await run([1, 2, 3, 4], undefined);
	assert.ok(queries.some((q) => q.length === 2 && q.includes(3)));
});
