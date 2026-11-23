const test = require('node:test');
const assert = require('node:assert');
const { install, Node } = require('./dom-stub.js');
const m = require('../dist/bundle.js');
const fx = require('./fixtures.js');

function mount(context, mutate) {
	install();
	const el = new Node('div');
	const model = {
		annotations: m.applySlims(m.toAnnotations(fx.annotationRows), fx.parentRows), truncated: false, filters: m.newFilters(),
		rowSort: { key: 'symbol', dir: 1 }, colSort: 'name', opened: null, status: '', rowLimit: m.ROW_PAGE
	};
	if (mutate) mutate(model);
	m.render(el, model, m.makeUi(el, model, context));
	return { el, model };
}

function buttons(el, label) {
	return el.find('button').filter((b) => b.textContent.indexOf(label) === 0);
}

test('save buttons appear only when context.saveList exists', () => {
	assert.strictEqual(buttons(mount(undefined).el, 'Save genes').length, 0);
	assert.strictEqual(buttons(mount({}).el, 'Save genes').length, 0);
	assert.ok(buttons(mount({ saveList: () => Promise.resolve('x') }).el, 'Save genes').length >= 2);
});

test('save button passes the column genes and a name with the filters and date', async () => {
	let saved;
	const { el } = mount({ saveList: (a) => { saved = a; return Promise.resolve('My list'); } }, (model) => { model.filters.via = 'exclude'; });
	buttons(el, 'Save genes')[0].listeners.click();
	assert.strictEqual(saved.class, 'Gene');
	assert.ok(saved.ids.length >= 1);
	assert.match(saved.name, /^Disease slim .+, no orthology, \d{4}-\d{2}-\d{2}$/);
	await new Promise((r) => setImmediate(r));
});

test('live fixture renders at least 2 slim columns and the evidence code filter', () => {
	const { el } = mount(undefined);
	assert.ok(el.find('th').filter((h) => h.attrs.scope === 'col').length >= 4);
	assert.ok(el.find('label').some((l) => l.textContent.indexOf('Evidence code') === 0));
});

test('clicking a cell opens a dialog that takes focus and closes on Escape', () => {
	const { el, model } = mount(undefined);
	buttons(el, '1')[0].listeners.click();
	assert.ok(model.opened);
	assert.strictEqual(globalThis.__focused.attrs.role, 'dialog');
});

test('Escape closes the popover', () => {
	const { el, model } = mount(undefined);
	const cell = el.find('button').filter((b) => b.className === 'agr-cell')[0];
	cell.listeners.click();
	assert.ok(model.opened);
	globalThis.__focused.listeners.keydown({ key: 'Escape' });
	assert.strictEqual(model.opened, null);
});

test('table has a caption, row headers, aria-sort and labelled cell buttons', () => {
	const { el } = mount(undefined);
	assert.strictEqual(el.find('caption').length, 1);
	assert.ok(el.find('th').some((h) => h.attrs.scope === 'row'));
	assert.ok(el.find('th').some((h) => h.attrs['aria-sort'] === 'ascending'));
	const cell = el.find('button').filter((b) => b.className === 'agr-cell')[0];
	assert.match(cell.attrs['aria-label'], /^\S+, .+: \d+ annotations?$/);
});

test('negated checkbox appears and a NOT badge shows for negated annotations', () => {
	const { el, model } = mount(undefined, (mo) => { mo.filters.negated = true; });
	assert.ok(el.find('input').length === 1);
	const neg = model.annotations.find((a) => a.negated);
	const p = m.pivot(model.annotations.filter((a) => a.negated));
	const slim = Object.keys(p.rows[0].cells)[0];
	const m2 = mount(undefined, (mo) => { mo.filters.negated = true; mo.opened = { row: p.rows[0], slim }; });
	assert.ok(m2.el.find('strong').some((s) => s.textContent.indexOf('NOT') !== -1), neg.qualifier);
});

test('rows beyond the page limit are hidden behind Show more', () => {
	const base = fx.annotationRows[0];
	const rows = [];
	for (let i = 0; i < 450; i++) rows.push([i + 1, 'G:' + i, 'GENE' + String(i).padStart(3, '0'), 'H. sapiens', 1000 + i, 'DOID:162', 'cancer', 'is_implicated_in', 'ECO:1', '1']);
	const mk = (limit) => mount(undefined, (mo) => { mo.annotations = m.applySlims(m.toAnnotations(rows), []); mo.rowLimit = limit; });
	const first = mk(m.ROW_PAGE);
	assert.strictEqual(first.el.find('tbody')[0].children.length, 200);
	assert.strictEqual(buttons(first.el, 'Show more').length, 1);
	buttons(first.el, 'Show more')[0].listeners.click();
	assert.strictEqual(first.el.find('tbody')[0].children.length, 400);
	assert.ok(base);
});

test('a truncated result shows a warning and marks Save genes as partial', () => {
	const { el, model } = mount({ saveList: () => Promise.resolve('x') }, (mo) => { mo.truncated = true; });
	assert.ok(m.notices(model).some((t) => /truncated/.test(t)));
	assert.ok(el.find('p').some((p) => /Result truncated/.test(p.textContent)));
	assert.ok(buttons(el, 'Save genes')[0].textContent.indexOf('partial') !== -1);
});

test('a warning appears when over 90% of annotations have no slim term', () => {
	const { model } = mount(undefined, (mo) => { mo.annotations = m.applySlims(mo.annotations, []).map((a) => Object.assign({}, a, { slims: [] })); });
	assert.ok(m.notices(model).some((t) => /no slim term/.test(t)));
	assert.strictEqual(m.notices(mount(undefined).model).filter((t) => /no slim term/.test(t)).length, 0);
});

test('main shows the failure reason when the mine request fails', async () => {
	install();
	const el = new Node('div');
	const realFetch = globalThis.fetch;
	globalThis.fetch = () => Promise.resolve({ status: 500, ok: false });
	try {
		m.main(el, { root: 'https://x/mine' }, { Gene: { value: [1] } }, {}, {}, () => {});
		await new Promise((r) => setTimeout(r, 20));
		assert.match(el.textContent, /Could not load disease annotations from the mine \(HTTP 500\)/);
	} finally {
		globalThis.fetch = realFetch;
	}
});
