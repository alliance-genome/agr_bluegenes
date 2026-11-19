'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { install } = require('./dom-stub.js');
install();
const tool = require('../dist/bundle.js');

test('serviceRoot appends /service and keeps an existing one', () => {
	assert.strictEqual(tool.serviceRoot('https://h/alliancemine/'), 'https://h/alliancemine/service');
	assert.strictEqual(tool.serviceRoot('https://h/alliancemine/service'), 'https://h/alliancemine/service');
});

test('buildQuery escapes ids and uses ONE OF for several', () => {
	assert.ok(tool.buildQuery('1"><x/>').includes('value="1&quot;&gt;&lt;x/&gt;"'));
	const q = tool.buildQuery(['1', '2']);
	assert.ok(q.includes('op="ONE OF"') && q.includes('<value>2</value>'));
	assert.ok(q.includes('Gene.expressionAnnotations.anatomy.name'));
	assert.ok(q.includes('Gene.expressionAnnotations.stageTerm'));
});

test('requestBody is form encoded with a row cap', () => {
	assert.ok(/^format=json&size=\d+&query=/.test(tool.requestBody(['1'])));
});

const tick = () => new Promise((r) => setTimeout(r, 5));
const results = [
	['G1', 's1', 1, 'liver', 'U:1', 'adult'],
	['G2', 's2', 2, 'liver', 'U:1', 'embryo']
];

test('main loads rows from service.root and renders a table', async () => {
	let url;
	let init;
	globalThis.fetch = async (u, i) => { url = u; init = i; return { ok: true, json: async () => ({ results }) }; };
	const el = document.createElement('div');
	tool.main(el, { root: 'https://h/alliancemine' }, { Gene: { value: [1, 2], class: 'Gene' } }, {}, {}, () => {});
	await tick();
	assert.strictEqual(url, 'https://h/alliancemine/service/query/results');
	assert.strictEqual(init.method, 'POST');
	assert.strictEqual(el.find('table').length, 1);
	assert.ok(el.find('th').some((th) => th.textContent === 'G1' || th.textContent.indexOf('s1') !== -1));
});

test('main shows no save button and tolerates a missing context', async () => {
	globalThis.fetch = async () => ({ ok: true, json: async () => ({ results }) });
	const el = document.createElement('div');
	tool.main(el, { root: 'https://h/m' }, { Gene: { value: 1 } }, {}, {}, () => {}, undefined);
	await tick();
	assert.ok(!el.find('button').some((b) => /save/i.test(b.textContent)));
});

test('main reports an empty id list and a failed request', async () => {
	const el = document.createElement('div');
	tool.main(el, { root: 'https://h/m' }, { Gene: { value: [] } });
	assert.ok(/No expression/.test(el.textContent));
	globalThis.fetch = async () => ({ ok: false, status: 502 });
	const el2 = document.createElement('div');
	tool.main(el2, { root: 'https://h/m' }, { Gene: { value: 1 } });
	await tick();
	assert.ok(/Could not load/.test(el2.textContent));
});

test('main shows an empty message when the genes have no annotations', async () => {
	globalThis.fetch = async () => ({ ok: true, json: async () => ({ results: [] }) });
	const el = document.createElement('div');
	tool.main(el, { root: 'https://h/m' }, { Gene: { value: 1 } });
	await tick();
	assert.ok(/No expression annotations/.test(el.textContent));
});

test('a stale response does not overwrite a newer one', async () => {
	let n = 0;
	globalThis.fetch = async () => {
		const mine = ++n;
		if (mine === 1) await new Promise((r) => setTimeout(r, 20));
		return { ok: true, json: async () => ({ results: mine === 1 ? [] : results }) };
	};
	const el = document.createElement('div');
	tool.main(el, { root: 'https://h/m' }, { Gene: { value: 1 } });
	tool.main(el, { root: 'https://h/m' }, { Gene: { value: 2 } });
	await new Promise((r) => setTimeout(r, 40));
	assert.strictEqual(el.find('table').length, 1);
});

const termOrder = (el) => el.find('tbody')[0].find('tr').map((tr) => tr.find('th')[0].textContent);

test('clicking a sort header and the stage select re-renders the table', async () => {
	const rowsData = [
		['G1', 's1', 1, 'liver', 'U:1', 'adult'],
		['G1', 's1', 2, 'liver', 'U:1', 'adult'],
		['G1', 's1', 3, 'brain', 'U:2', 'embryo'],
		['G2', 's2', 4, 'brain', 'U:2', 'embryo'],
		['G2', 's2', 5, 'brain', 'U:2', 'embryo']
	];
	globalThis.fetch = async () => ({ ok: true, json: async () => ({ results: rowsData }) });
	const el = document.createElement('div');
	tool.main(el, { root: 'https://h/m' }, { Gene: { value: [1, 2] } });
	await tick();
	assert.deepStrictEqual(termOrder(el), ['brain', 'liver']);
	const nameBtn = el.find('thead')[0].find('button')[0];
	nameBtn.listeners.click();
	assert.deepStrictEqual(termOrder(el), ['brain', 'liver']);
	nameBtn.listeners.click();
	assert.deepStrictEqual(termOrder(el), ['liver', 'brain']);
	const select = el.find('select')[0];
	select.value = 'adult';
	select.listeners.change();
	assert.deepStrictEqual(termOrder(el), ['liver']);
});
