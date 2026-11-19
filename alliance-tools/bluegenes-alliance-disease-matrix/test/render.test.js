const test = require('node:test');
const assert = require('node:assert');
const { install } = require('./dom-stub.js');
const m = require('../dist/bundle.js');

const ROWS = [
	[1, 'HGNC:1', 'AAA', 10, 'breast cancer', 'cancer', 'IEA', null, 'is_implicated_in', 'ECO:1', '111'],
	[2, 'HGNC:2', 'BBB', 12, 'lung cancer', 'cancer', 'TAS', null, 'is_implicated_in', 'ECO:3', '333']
];

function mount(context) {
	install();
	const el = new (require('./dom-stub.js').Node)('div');
	const model = {
		annotations: m.toAnnotations(ROWS), truncated: false, filters: { evidenceType: '', via: 'all' },
		rowSort: { key: 'symbol', dir: 1 }, colSort: 'name', opened: null, status: ''
	};
	m.render(el, model, m.makeUi(el, model, context));
	return { el, model };
}

function buttons(el, label) {
	return el.find('button').filter((b) => b.textContent.indexOf(label) === 0);
}

test('save buttons appear only when context.saveList exists', () => {
	assert.strictEqual(buttons(mount(undefined).el, 'Save genes').length, 0);
	assert.strictEqual(buttons(mount({}).el, 'Save genes').length, 0);
	assert.strictEqual(buttons(mount({ saveList: () => Promise.resolve('x') }).el, 'Save genes').length, 1);
});

test('save button passes the genes of the column to saveList', async () => {
	let saved;
	const { el } = mount({ saveList: (a) => { saved = a; return Promise.resolve('My list'); } });
	buttons(el, 'Save genes')[0].listeners.click();
	assert.deepStrictEqual(saved.ids, [1, 2]);
	assert.strictEqual(saved.class, 'Gene');
	await new Promise((r) => setImmediate(r));
});

test('clicking a cell opens a popover with PMIDs', () => {
	const { el, model } = mount(undefined);
	buttons(el, '1')[0].listeners.click();
	assert.strictEqual(model.opened.slim, 'cancer');
});
