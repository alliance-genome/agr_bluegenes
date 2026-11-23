'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { install } = require('./dom-stub.js');
install();
const tool = require('../dist/bundle.js');
const mine = require('./mine-stub.js');
const { MOUSE, WORM, HUMAN, tick, run, button, geneRows } = mine;

const quiet = async (fn) => {
	const orig = console.error;
	console.error = () => {};
	try { return await fn(); } finally { console.error = orig; }
};
const subModel = (collections) => ({
	classes: {
		...mine.model.classes,
		Gene: { ...mine.model.classes.Gene, collections: Object.fromEntries(Object.entries(mine.model.classes.Gene.collections).filter(([k]) => collections.includes(k))) }
	}
});
const SERVICE = { root: 'http://h/mine' };
const ALL = [MOUSE, WORM, HUMAN];
tool.settings.retryMs = 0;

test('typesFor keeps all types without a model and drops those missing from it', () => {
	assert.strictEqual(tool.typesFor({}).length, 5);
	assert.deepStrictEqual(tool.typesFor({ model: subModel(['goAnnotation', 'publications']) }).map((t) => t.key), ['go', 'publications']);
});

test('missing collections are never queried and are named in a note', async () => {
	const { requests } = mine.install();
	const el = await run(tool, { ...SERVICE, model: subModel(['goAnnotation', 'alleles']) }, ALL);
	await tick();
	assert.deepStrictEqual([...new Set(requests.filter((r) => r.collection).map((r) => r.collection))].sort(), ['alleles', 'goAnnotation']);
	assert.deepStrictEqual(el.find('th').map((t) => t.textContent).slice(0, 4), ['Organism', 'Genes', 'GO', 'Alleles']);
	assert.ok(el.textContent.includes('This mine has no annotations for: Disease, Phenotype, Publications.'));
});

test('each column reads its own collection: alleles are missing for the human gene only', async () => {
	mine.install();
	const el = await run(tool, { ...SERVICE, model: mine.model }, ALL);
	await tick();
	const human = geneRows(el).find((r) => r.textContent.startsWith('TP53'));
	assert.deepStrictEqual(human.find('td').slice(2).map((c) => c.textContent), ['Yes', 'Yes', 'Yes', 'Yes', 'No']);
	const mouse = geneRows(el).find((r) => r.textContent.startsWith('Trp53'));
	assert.deepStrictEqual(mouse.find('td').slice(2).map((c) => c.textContent), ['Yes', 'Yes', 'Yes', 'Yes', 'Yes']);
});

test('a model with none of the collections shows the empty message', async () => {
	mine.install();
	const el = await run(tool, { ...SERVICE, model: subModel([]) }, ALL);
	await tick();
	assert.ok(el.textContent.includes('No annotation coverage to show'));
});

test('duplicate input ids are queried once', async () => {
	const { requests } = mine.install();
	await run(tool, SERVICE, [MOUSE, String(MOUSE), WORM, WORM]);
	await tick();
	const info = requests.find((r) => r.kind === 'info');
	assert.deepStrictEqual(info.ids, [MOUSE, WORM]);
});

test('ids the mine does not return are reported', async () => {
	mine.install();
	const el = await run(tool, SERVICE, [MOUSE, 999]);
	await tick();
	assert.ok(el.textContent.includes('1 id not found in this mine.'));
});

test('without context the save button is absent, with it Save is offered once a filter is chosen', async () => {
	mine.install();
	const bare = await run(tool, SERVICE, ALL);
	await tick();
	assert.ok(!bare.find('button').some((b) => /^(Save|Choose)/.test(b.textContent)));
	const withCtx = await run(tool, SERVICE, ALL, { saveList: async () => 'x' });
	await tick();
	assert.strictEqual(button(withCtx, /^Choose which genes/).disabled, true);
});

function choose(el, mode, organism) {
	const [orgSelect, modeSelect] = el.find('select');
	if (organism !== undefined) { orgSelect.value = organism; orgSelect.listeners.change(); }
	modeSelect.value = mode;
	modeSelect.listeners.change();
}

test('save sends the ids of genes without the chosen type and names the list', async () => {
	mine.install();
	let sent;
	const el = await run(tool, SERVICE, ALL, { saveList: async (a) => { sent = a; return a.name; } });
	await tick();
	choose(el, 'alleles');
	const save = button(el, /^Save 1 gene without Alleles as list/);
	save.listeners.click();
	await tick();
	assert.deepStrictEqual(sent.ids, [HUMAN]);
	assert.strictEqual(sent.class, 'Gene');
	assert.ok(el.textContent.includes('Saved list genes_without_alleles_annotations_'));
});

test('after a save the button stays disabled until the selection changes', async () => {
	mine.install();
	let calls = 0;
	const el = await run(tool, SERVICE, ALL, { saveList: async (a) => { calls += 1; return a.name; } });
	await tick();
	choose(el, 'alleles');
	button(el, /^Save 1 gene/).listeners.click();
	await tick();
	const after = button(el, /^Save 1 gene/);
	assert.strictEqual(after.disabled, true);
	after.listeners.click();
	await tick();
	assert.strictEqual(calls, 1);
	choose(el, 'any');
	assert.strictEqual(button(el, /^Save 1 gene/).disabled, false);
});

test('anonymous users get a login message and can try again', async () => {
	mine.install();
	const el = await run(tool, SERVICE, ALL, { saveList: () => Promise.reject(new Error('login required')) });
	await tick();
	choose(el, 'alleles');
	button(el, /^Save 1 gene/).listeners.click();
	await tick();
	assert.ok(el.textContent.includes('Log in to save lists'));
	assert.strictEqual(button(el, /^Save 1 gene/).disabled, false);
});

test('an HTTP 500 on the gene query shows the status and fails the tool', async () => {
	mine.install({ respond: () => ({ ok: false, status: 500 }) });
	const el = await quiet(async () => { const e = await run(tool, SERVICE, ALL); await tick(); return e; });
	assert.ok(el.textContent.includes('Could not load annotation coverage from the mine (HTTP 500)'));
	assert.strictEqual(el.find('p')[0].getAttribute('role'), 'alert');
});

test('an HTTP 500 on one type fails that column only and Retry reloads it', async () => {
	let failGo = true;
	mine.install({ respond: (req) => (req.collection === 'goAnnotation' && failGo ? { ok: false, status: 500 } : undefined) });
	const el = await quiet(async () => { const e = await run(tool, SERVICE, ALL); await tick(); return e; });
	assert.ok(el.textContent.includes('Could not load (HTTP 500)'));
	assert.ok(el.textContent.includes('1 of 1 (100%)'));
	failGo = false;
	button(el, /^Retry$/).listeners.click();
	await tick();
	assert.ok(!el.textContent.includes('Could not load'));
});

test('saving names the failed type to retry instead of waiting forever', async () => {
	mine.install({ respond: (req) => (req.collection === 'goAnnotation' ? { ok: false, status: 500 } : undefined) });
	const el = await quiet(async () => { const e = await run(tool, SERVICE, ALL, { saveList: async (a) => a.name }); await tick(); return e; });
	choose(el, 'any');
	const save = button(el, /^Retry GO to save$/);
	assert.strictEqual(save.disabled, true);
});

test('a 429 is retried and the column loads', async () => {
	let seen = 0;
	const { requests } = mine.install({ respond: (req) => (req.collection === 'goAnnotation' && ++seen < 3 ? { ok: false, status: 429, headers: { get: () => null } } : undefined) });
	const el = await run(tool, SERVICE, ALL);
	await tick();
	assert.strictEqual(requests.filter((r) => r.collection === 'goAnnotation').length, 3);
	assert.ok(!el.textContent.includes('Could not load'));
});

test('a 429 that persists stops after 3 tries and says so', async () => {
	const { requests } = mine.install({ respond: (req) => (req.collection === 'goAnnotation' ? { ok: false, status: 429, headers: { get: () => null } } : undefined) });
	const el = await quiet(async () => { const e = await run(tool, SERVICE, ALL); await tick(); return e; });
	assert.strictEqual(requests.filter((r) => r.collection === 'goAnnotation').length, 3);
	assert.ok(el.textContent.includes('Could not load (HTTP 429)'));
});

test('Retry-After is honoured instead of the default backoff', async () => {
	const saved = tool.settings.retryMs;
	tool.settings.retryMs = 60000;
	let seen = 0;
	mine.install({ respond: (req) => (req.kind === 'info' && ++seen < 2 ? { ok: false, status: 429, headers: { get: () => '0.01' } } : undefined) });
	const el = await run(tool, SERVICE, ALL);
	await tick(150);
	tool.settings.retryMs = saved;
	assert.ok(el.textContent.includes('Trp53'));
});

test('a request that never answers times out with a visible message', async () => {
	const saved = tool.settings.timeoutMs;
	tool.settings.timeoutMs = 20;
	globalThis.fetch = (url, init) => new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))));
	const el = await quiet(async () => { const e = await run(tool, SERVICE, ALL); await tick(120); return e; });
	tool.settings.timeoutMs = saved;
	assert.ok(el.textContent.includes('Could not load annotation coverage from the mine (timed out after'));
});

test('loading and the save status are announced to screen readers', async () => {
	const saved = tool.settings.timeoutMs;
	tool.settings.timeoutMs = 20;
	mine.install({ respond: () => new Promise(() => {}) });
	const el = await run(tool, SERVICE, ALL);
	assert.strictEqual(el.find('p')[0].getAttribute('role'), 'status');
	await tick(60);
	tool.settings.timeoutMs = saved;
	mine.install();
	const done = await run(tool, SERVICE, ALL, { saveList: async () => 'x' });
	await tick();
	assert.ok(done.find('span').some((s) => s.getAttribute('role') === 'status'));
	assert.ok(done.find('table').every((t) => t.find('caption').length === 1));
	assert.ok(done.find('th').every((th) => th.getAttribute('scope') === 'col'));
});
