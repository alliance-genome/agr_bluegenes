'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { install } = require('./dom-stub.js');
install();
const tool = require('../dist/bundle.js');
const mine = require('./mine-stub.js');
const { MOUSE, WORM, HUMAN, tick, run, button, geneRows, geneTable } = mine;

const SERVICE = { root: 'http://h/mine', model: mine.model };
const ALL = [MOUSE, WORM, HUMAN];
const symbols = (el) => geneRows(el).map((r) => r.find('a')[0].textContent);

test('clicking a column header sorts, and clicking again reverses', async () => {
	mine.install();
	const el = await run(tool, SERVICE, ALL);
	await tick();
	assert.deepStrictEqual(symbols(el), ['daf-16', 'TP53', 'Trp53']);
	const header = (label) => geneTable(el).find('th').map((th) => th.find('button')[0]).find((b) => b.textContent.startsWith(label));
	header('Gene').listeners.click();
	assert.deepStrictEqual(symbols(el), ['daf-16', 'TP53', 'Trp53']);
	header('Gene').listeners.click();
	assert.deepStrictEqual(symbols(el), ['Trp53', 'TP53', 'daf-16']);
	header('Alleles').listeners.click();
	assert.strictEqual(symbols(el)[0], 'TP53');
	assert.strictEqual(geneTable(el).find('th').find((th) => /^Alleles/.test(th.textContent)).getAttribute('aria-sort'), 'ascending');
});

test('clicking a bar filters the table to the genes without that type in that organism', async () => {
	mine.install();
	const el = await run(tool, SERVICE, ALL, { saveList: async () => 'x' });
	await tick();
	const bars = el.find('button').filter((b) => /^Show genes without Alleles in /.test(b.getAttribute('title') || ''));
	assert.strictEqual(bars.length, 3);
	button(el, /^Show genes without Alleles in H\. sapiens/).listeners.click();
	assert.deepStrictEqual(symbols(el), ['TP53']);
	const [orgSelect, modeSelect] = el.find('select');
	assert.strictEqual(orgSelect.value, 'H. sapiens');
	assert.strictEqual(modeSelect.value, 'alleles');
	assert.ok(button(el, /^Save 1 gene without Alleles in H\. sapiens as list/));
});

test('an organism with no annotation of a type across 20 or more genes reads none in mine', async () => {
	const rows = mine.genes(20, 'H. sapiens', 1);
	const ids = rows.map((r) => r[0]);
	mine.install({ info: rows, present: { goAnnotation: ids, diseaseAnnotation: ids, phenotypeAnnotations: ids, publications: ids, alleles: [] } });
	const el = await run(tool, SERVICE, ids);
	await tick();
	assert.ok(el.textContent.includes('none in mine'));
	assert.ok(!el.textContent.includes('0 of 20 (0%)'));
	assert.ok(el.textContent.includes('20 of 20 (100%)'));
});

test('the table shows 100 genes per page', async () => {
	const rows = mine.genes(250, 'D. rerio', 1);
	const ids = rows.map((r) => r[0]);
	mine.install({ info: rows, present: {} });
	const el = await run(tool, SERVICE, ids);
	await tick(200);
	assert.strictEqual(geneRows(el).length, 100);
	assert.ok(el.textContent.includes('Genes 1 to 100 of 250'));
	button(el, /^Next$/).listeners.click();
	button(el, /^Next$/).listeners.click();
	assert.strictEqual(geneRows(el).length, 50);
	assert.ok(el.textContent.includes('Genes 201 to 250 of 250'));
	assert.strictEqual(button(el, /^Next$/).disabled, true);
});

test('the organism selector narrows the table and the saved list name carries the organism', async () => {
	mine.install();
	let sent;
	const el = await run(tool, SERVICE, ALL, { saveList: async (a) => { sent = a; return a.name; } });
	await tick();
	const [orgSelect, modeSelect] = el.find('select');
	orgSelect.value = 'C. elegans';
	orgSelect.listeners.change();
	assert.deepStrictEqual(symbols(el), ['daf-16']);
	modeSelect.value = 'any';
	modeSelect.listeners.change();
	assert.ok(button(el, /^Save 0 genes missing at least one type in C\. elegans/).disabled);
	orgSelect.value = 'H. sapiens';
	orgSelect.listeners.change();
	button(el, /^Save 1 gene missing at least one type in H\. sapiens/).listeners.click();
	await tick();
	assert.match(sent.name, /^genes_missing_any_annotation_type_h_sapiens_\d{14}$/);
	assert.deepStrictEqual(sent.ids, [HUMAN]);
});

test('Export CSV writes the shown genes and revokes the blob URL after the click', async () => {
	mine.install();
	const el = await run(tool, SERVICE, ALL);
	await tick();
	button(el, /^Show genes without Alleles in H\. sapiens/).listeners.click();
	let blobText;
	const origBlob = globalThis.Blob;
	globalThis.Blob = class { constructor(parts) { blobText = parts.join(''); } };
	const origCreate = URL.createObjectURL;
	const origRevoke = URL.revokeObjectURL;
	const revoked = [];
	URL.createObjectURL = () => 'blob:x';
	URL.revokeObjectURL = (u) => revoked.push(u);
	const origEl = document.createElement;
	let clicked = 0;
	document.createElement = (t) => { const n = origEl(t); if (t === 'a') n.click = () => { clicked += 1; assert.strictEqual(revoked.length, 0); }; return n; };
	tool.settings.revokeMs = 10;
	button(el, /^Export CSV$/).listeners.click();
	assert.strictEqual(clicked, 1);
	assert.strictEqual(revoked.length, 0);
	await tick(40);
	Object.assign(globalThis, { Blob: origBlob });
	URL.createObjectURL = origCreate;
	URL.revokeObjectURL = origRevoke;
	document.createElement = origEl;
	assert.deepStrictEqual(revoked, ['blob:x']);
	assert.strictEqual(blobText, 'Gene,Symbol,Organism,GO,Disease,Phenotype,Publications,Alleles\r\nHGNC:11998,TP53,H. sapiens,yes,yes,yes,yes,no\r\n');
});
