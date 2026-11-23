'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { install } = require('./dom-stub.js');
install();
const tool = require('../dist/bundle.js');
const mine = require('./mine-stub.js');
const { tick, run, button, geneRows } = mine;

tool.settings.retryMs = 0;
const SERVICE = { root: 'http://h/mine' };

test('1000 genes cost 5 info requests and 5 per type, each a single short page', async () => {
	const rows = mine.genes(1000, 'H. sapiens', 1);
	const ids = rows.map((r) => r[0]);
	const { requests, stats } = mine.install({ info: rows, present: { goAnnotation: ids, diseaseAnnotation: ids, phenotypeAnnotations: ids, publications: ids, alleles: [] } });
	const el = await run(tool, SERVICE, ids);
	await tick(400);
	assert.strictEqual(requests.length, 5 + 5 * 5);
	assert.ok(requests.every((r) => r.start === 0 && r.ids.length <= 200));
	assert.ok(stats.maxInFlight <= 2, 'in flight ' + stats.maxInFlight);
	assert.ok(el.textContent.includes('1000 genes'));
});

test('a type with a heavy gene still shows its bar and keeps saving enabled', async () => {
	const rows = mine.genes(4, 'M. musculus', 1);
	mine.install({ info: rows, present: { goAnnotation: [1], diseaseAnnotation: [], phenotypeAnnotations: [], publications: [], alleles: [] } });
	const el = await run(tool, SERVICE, [1, 2, 3, 4], { saveList: async () => 'x' });
	await tick();
	assert.ok(el.textContent.includes('1 of 4 (25%)'));
	[...el.find('select')][1].value = 'go';
	el.find('select')[1].listeners.change();
	assert.strictEqual(button(el, /^Save 3 genes without GO/).disabled, false);
	assert.ok(!el.textContent.includes('incomplete'));
});

test('a response at the page cap is reported instead of being used', async () => {
	mine.install({ respond: (req) => (req.collection === 'goAnnotation' ? mine.ok(Array.from({ length: 5000 }, (_, i) => [i])) : undefined) });
	const orig = console.error;
	console.error = () => {};
	const el = await run(tool, SERVICE, [mine.MOUSE]);
	await tick();
	console.error = orig;
	assert.ok(el.textContent.includes('Could not load (result truncated at 5000 rows)'));
});

test('the gene table and the other columns render before a slow type finishes', async () => {
	let release;
	const gate = new Promise((r) => { release = r; });
	mine.install({ respond: (req) => (req.collection === 'goAnnotation' ? gate.then(() => undefined) : undefined) });
	const el = await run(tool, SERVICE, [mine.MOUSE, mine.WORM, mine.HUMAN]);
	await tick();
	assert.strictEqual(geneRows(el).length, 3);
	assert.ok(el.textContent.includes('Loading...') || el.textContent.includes('Loading, '));
	assert.ok(el.textContent.includes('1 of 1 (100%)'));
	assert.deepStrictEqual(geneRows(el)[0].find('td')[2].textContent, '...');
	release();
	await tick();
	assert.deepStrictEqual(geneRows(el)[0].find('td')[2].textContent, 'Yes');
	assert.ok(!el.textContent.includes('Loading'));
});

test('progress names the request count while a type loads in several chunks', async () => {
	const rows = mine.genes(450, 'D. rerio', 1);
	const ids = rows.map((r) => r[0]);
	let release;
	const gate = new Promise((r) => { release = r; });
	mine.install({ info: rows, present: { goAnnotation: ids }, respond: (req, all) => (req.collection === 'goAnnotation' && all.filter((r) => r.collection === 'goAnnotation').length === 2 ? gate.then(() => undefined) : undefined) });
	const el = await run(tool, SERVICE, ids);
	await tick();
	assert.ok(el.textContent.includes('Loading, 1 of 3 requests'));
	release();
	await tick();
});
