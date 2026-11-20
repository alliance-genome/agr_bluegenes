const test = require('node:test');
const assert = require('node:assert');
const { install } = require('./dom-stub.js');
const tr = require('../dist/bundle.js');

const classes = {
  Gene: {
    attributes: { id: {}, symbol: {} },
    references: { organism: { referencedType: 'Organism' } },
    collections: { alleles: { referencedType: 'Allele' }, homologues: { referencedType: 'Homologue' } }
  },
  Allele: { attributes: { symbol: {} }, references: { gene: { referencedType: 'Gene' } } },
  Organism: { attributes: { shortName: {} } },
  Homologue: { attributes: {} }
};
const service = { root: 'https://m.org/mine', model: { classes } };

function template(over) {
  return Object.assign({
    name: 'T', title: 'Title', description: 'Desc', tags: ['im:public'],
    select: ['Gene.symbol', 'Gene.organism.shortName'],
    where: [{ path: 'Gene', op: 'LOOKUP', value: 'zen', code: 'A', editable: true }],
    orderBy: [{ 'Gene.symbol': 'ASC' }]
  }, over);
}

test('templatesUrl builds the templates endpoint', () => {
  assert.strictEqual(tr.templatesUrl('https://m.org/mine/'), 'https://m.org/mine/service/templates?format=json');
});

test('typeOfPath follows references and collections', () => {
  assert.strictEqual(tr.typeOfPath(classes, 'Gene'), 'Gene');
  assert.strictEqual(tr.typeOfPath(classes, 'Allele.gene'), 'Gene');
  assert.strictEqual(tr.typeOfPath(classes, 'Gene.alleles'), 'Allele');
  assert.strictEqual(tr.typeOfPath(classes, 'Gene.nope'), null);
});

test('classify accepts a public template with one Gene lookup', () => {
  const c = tr.classify(template(), service);
  assert.strictEqual(c.status, 'run');
  assert.strictEqual(c.lookup.path, 'Gene');
});

test('classify accepts a lookup on a reference that is a Gene', () => {
  const t = template({ select: ['Allele.symbol'], where: [{ path: 'Allele.gene', op: 'LOOKUP', value: 'x', code: 'A', editable: true }] });
  assert.strictEqual(tr.classify(t, service).status, 'run');
});

test('classify hides non public templates', () => {
  assert.strictEqual(tr.classify(template({ tags: ['im:aspect:Genome'] }), service).status, 'hide');
  assert.strictEqual(tr.classify(template({ tags: undefined }), service).status, 'hide');
});

test('classify hides templates without an editable Gene lookup', () => {
  assert.strictEqual(tr.classify(template({ where: [{ path: 'Gene.symbol', op: '=', value: 'a', editable: true }] }), service).status, 'hide');
  assert.strictEqual(tr.classify(template({ where: [{ path: 'Gene', op: 'LOOKUP', value: 'a', code: 'A', editable: false }] }), service).status, 'hide');
  const alleleLookup = template({ select: ['Allele.symbol'], where: [{ path: 'Allele', op: 'LOOKUP', value: 'a', code: 'A', editable: true }] });
  assert.strictEqual(tr.classify(alleleLookup, service).status, 'hide');
});

test('classify hides templates with two editable lookups', () => {
  const where = [
    { path: 'Gene', op: 'LOOKUP', value: 'a', code: 'A', editable: true },
    { path: 'Gene.alleles', op: 'LOOKUP', value: 'b', code: 'B', editable: true }
  ];
  assert.strictEqual(tr.classify(template({ where }), service).status, 'hide');
});

test('classify hides templates whose paths the model lacks', () => {
  assert.strictEqual(tr.classify(template({ select: ['Gene.nope'] }), service).status, 'hide');
  const w = template({ where: [{ path: 'Gene', op: 'LOOKUP', value: 'a', code: 'A', editable: true }, { path: 'Gene.zzz', op: '=', value: '1', code: 'B' }] });
  assert.strictEqual(tr.classify(w, service).status, 'hide');
  assert.strictEqual(tr.classify(template({ orderBy: [{ 'Gene.zzz': 'ASC' }] }), service).status, 'hide');
  assert.strictEqual(tr.classify(template({ where: [{ path: 'Gene', type: 'Missing' }, { path: 'Gene', op: 'LOOKUP', value: 'a', code: 'A', editable: true }] }), service).status, 'hide');
});

test('classify skips a lookup with extraValue and gives the reason', () => {
  const t = template({ where: [{ path: 'Gene', op: 'LOOKUP', value: 'a', extraValue: 'S. cerevisiae', code: 'A', editable: true }] });
  const c = tr.classify(t, service);
  assert.strictEqual(c.status, 'skip');
  assert.match(c.reason, /S\. cerevisiae/);
});

test('classify works without a model for a plain Gene lookup', () => {
  assert.strictEqual(tr.classify(template(), { root: 'x' }).status, 'run');
  const t = template({ where: [{ path: 'Gene.alleles', op: 'LOOKUP', value: 'a', code: 'A', editable: true }] });
  assert.strictEqual(tr.classify(t, { root: 'x' }).status, 'hide');
});

test('rewriteQuery turns the lookup into ONE OF on path.id', () => {
  const t = template({ constraintLogic: 'A and B', where: [
    { path: 'Gene', op: 'LOOKUP', value: 'zen', code: 'A', editable: true, switchable: false },
    { path: 'Gene.symbol', op: 'IS NOT NULL', code: 'B' }
  ] });
  const q = tr.rewriteQuery(t, t.where[0], { ids: [1, 2] });
  assert.strictEqual(q.from, 'Gene');
  assert.deepStrictEqual(q.select, t.select);
  assert.strictEqual(q.constraintLogic, 'A and B');
  assert.deepStrictEqual(q.where[0], { path: 'Gene.id', op: 'ONE OF', values: ['1', '2'], code: 'A' });
  assert.deepStrictEqual(q.where[1], t.where[1]);
  assert.deepStrictEqual(q.orderBy, [{ path: 'Gene.symbol', direction: 'ASC' }]);
});

test('rewriteQuery keeps the lookup path prefix', () => {
  const t = template({ select: ['Allele.symbol'], where: [{ path: 'Allele.gene', op: 'LOOKUP', value: 'x', code: 'A', editable: true }] });
  const q = tr.rewriteQuery(t, t.where[0], { ids: [7] });
  assert.strictEqual(q.from, 'Allele');
  assert.strictEqual(q.where[0].path, 'Allele.gene.id');
});

test('rewriteQuery uses IN on the saved list when a list is given', () => {
  const t = template();
  const q = tr.rewriteQuery(t, t.where[0], { ids: [1], listName: 'my_genes' });
  assert.deepStrictEqual(q.where[0], { path: 'Gene', op: 'IN', value: 'my_genes', code: 'A' });
});

test('rewriteQuery does not change the template', () => {
  const t = template();
  const copy = JSON.parse(JSON.stringify(t));
  tr.rewriteQuery(t, t.where[0], { ids: [1] });
  assert.deepStrictEqual(t, copy);
});

test('partition returns runnable and skipped templates sorted by title', () => {
  const b = template({ name: 'B', title: 'Beta' });
  const a = template({ name: 'A', title: 'Alpha' });
  const s = template({ name: 'S', title: 'Sk', where: [{ path: 'Gene', op: 'LOOKUP', value: 'a', extraValue: 'X', code: 'A', editable: true }] });
  const h = template({ name: 'H', tags: [] });
  const p = tr.partition({ B: b, A: a, S: s, H: h }, service);
  assert.deepStrictEqual(p.runnable.map((r) => r.template.name), ['A', 'B']);
  assert.deepStrictEqual(p.skipped.map((r) => r.template.name), ['S']);
});

test('geneIds reads ids from the entity', () => {
  assert.deepStrictEqual(tr.geneIds({ Gene: { value: 5 } }), ['5']);
  assert.deepStrictEqual(tr.geneIds({ Gene: { value: [1, '', null, 2] } }), ['1', '2']);
  assert.deepStrictEqual(tr.geneIds({}), []);
});

test('listName returns the list name only for a Gene list', () => {
  assert.strictEqual(tr.listName({ list: { name: 'l', type: 'Gene' } }), 'l');
  assert.strictEqual(tr.listName({ list: { name: 'l', type: 'Protein' } }), null);
  assert.strictEqual(tr.listName(undefined), null);
});

function flush() { return new Promise((r) => setImmediate(r)); }

test('main lists templates and run opens the query with navigate', async () => {
  const Node = install();
  const el = new Node('div');
  const store = { templates: { T: template({ title: 'Gene things', description: 'Shows <b>things</b>' }) } };
  globalThis.fetch = async (url) => { assert.match(url, /\/service\/templates\?format=json$/); return { ok: true, json: async () => store }; };
  const calls = [];
  tr.main(el, service, { Gene: { value: [3, 4] } }, {}, {}, (page, q) => calls.push([page, q]), undefined);
  await flush();
  assert.match(el.textContent, /Gene things/);
  assert.match(el.textContent, /Shows <b>things<\/b>/);
  const buttons = el.find('button');
  assert.strictEqual(buttons.length, 1);
  buttons[0].listeners.click({ preventDefault() {} });
  assert.strictEqual(calls[0][0], 'query');
  assert.deepStrictEqual(calls[0][1].where[0], { path: 'Gene.id', op: 'ONE OF', values: ['3', '4'], code: 'A' });
});

test('main uses the saved list from context', async () => {
  const Node = install();
  const el = new Node('div');
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ templates: { T: template() } }) });
  const calls = [];
  tr.main(el, service, { Gene: { value: [3, 4] } }, {}, {}, (p, q) => calls.push(q), { list: { name: 'L', type: 'Gene' } });
  await flush();
  el.find('button')[0].listeners.click();
  assert.deepStrictEqual(calls[0].where[0], { path: 'Gene', op: 'IN', value: 'L', code: 'A' });
});

test('main shows skipped templates with the reason', async () => {
  const Node = install();
  const el = new Node('div');
  const s = template({ title: 'Sk', where: [{ path: 'Gene', op: 'LOOKUP', value: 'a', extraValue: 'S. cerevisiae', code: 'A', editable: true }] });
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ templates: { S: s } }) });
  tr.main(el, service, { Gene: { value: 1 } }, {}, {}, () => {});
  await flush();
  assert.strictEqual(el.find('button').length, 0);
  assert.match(el.textContent, /Sk/);
  assert.match(el.textContent, /S\. cerevisiae/);
});

test('main reports a fetch failure', async () => {
  const Node = install();
  const el = new Node('div');
  globalThis.fetch = async () => ({ ok: false, status: 502 });
  tr.main(el, service, { Gene: { value: 1 } }, {}, {}, () => {});
  await flush();
  assert.match(el.textContent, /Could not load templates/);
});

test('main shows a message when no gene is given', () => {
  const Node = install();
  const el = new Node('div');
  tr.main(el, service, { Gene: { value: [] } }, {}, {}, () => {});
  assert.match(el.textContent, /No genes/);
});
