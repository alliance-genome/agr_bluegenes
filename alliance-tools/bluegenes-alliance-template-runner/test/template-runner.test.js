const test = require('node:test');
const assert = require('node:assert');
const { install } = require('./dom-stub.js');
const tr = require('../dist/bundle.js');
const liveTemplates = require('./fixtures/templates.json').templates;
const liveService = { root: 'https://alliancemine.alliancegenome.org/alliancemine', model: require('./fixtures/model.json') };

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
  const partial = tr.classify(template({ select: ['Gene.symbol', 'Gene.nope'] }), service);
  assert.strictEqual(partial.status, 'run');
  assert.deepStrictEqual(partial.template.select, ['Gene.symbol']);
  assert.deepStrictEqual(partial.dropped, ['Gene.nope']);
  const w = template({ where: [{ path: 'Gene', op: 'LOOKUP', value: 'a', code: 'A', editable: true }, { path: 'Gene.zzz', op: '=', value: '1', code: 'B' }] });
  assert.strictEqual(tr.classify(w, service).status, 'hide');
  const ordered = tr.classify(template({ orderBy: [{ 'Gene.zzz': 'ASC' }] }), service);
  assert.strictEqual(ordered.status, 'run');
  assert.deepStrictEqual(ordered.template.orderBy, []);
  assert.strictEqual(tr.classify(template({ where: [{ path: 'Gene', type: 'Missing' }, { path: 'Gene', op: 'LOOKUP', value: 'a', code: 'A', editable: true }] }), service).status, 'hide');
});

test('classify keeps a lookup with extraValue and records its organism limit', () => {
  const t = template({ where: [{ path: 'Gene', op: 'LOOKUP', value: 'a', extraValue: 'S. cerevisiae', code: 'A', editable: true }] });
  const c = tr.classify(t, service);
  assert.strictEqual(c.status, 'run');
  assert.deepStrictEqual(c.limits, [['S. cerevisiae']]);
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
  const p = tr.partition({ B: b, A: a, S: s, H: h }, service, ['H. sapiens']);
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

// Routes /templates and /query/results; organisms is a list of names, an Error, or undefined for none.
function mockFetch(templates, organisms) {
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push({ url, init });
    if (/\/templates\?/.test(url)) return { ok: true, status: 200, json: async () => ({ templates }) };
    if (organisms instanceof Error) throw organisms;
    return { ok: true, status: 200, json: async () => ({ results: (organisms || []).map((o) => [o, 1]) }) };
  };
  return seen;
}

function reset() {
  tr.clearCache();
  tr.settings.backoffMs = [0, 0, 0];
  tr.settings.timeoutMs = 20000;
}

test('main lists templates and run opens the query with navigate', async () => {
  reset();
  const Node = install();
  const el = new Node('div');
  mockFetch({ T: template({ title: 'Gene things', description: 'Shows <b>things</b>' }) }, ['H. sapiens']);
  const calls = [];
  tr.main(el, service, { Gene: { value: [3, 4] } }, {}, {}, (page, q) => calls.push([page, q]), undefined);
  await flush();
  assert.match(el.textContent, /Gene things/);
  assert.match(el.textContent, /Shows things/);
  assert.doesNotMatch(el.textContent, /<b>/);
  const buttons = el.find('button');
  assert.strictEqual(buttons.length, 1);
  buttons[0].listeners.click({ preventDefault() {} });
  assert.strictEqual(calls[0][0], 'query');
  assert.deepStrictEqual(calls[0][1].where[0], { path: 'Gene.id', op: 'ONE OF', values: ['3', '4'], code: 'A' });
});

test('main uses the saved list from context', async () => {
  reset();
  const Node = install();
  const el = new Node('div');
  const seen = mockFetch({ T: template() }, ['H. sapiens']);
  const calls = [];
  tr.main(el, service, { Gene: { value: [3, 4] } }, {}, {}, (p, q) => calls.push(q), { list: { name: 'L', type: 'Gene' } });
  await flush();
  el.find('button')[0].listeners.click();
  assert.deepStrictEqual(calls[0].where[0], { path: 'Gene', op: 'IN', value: 'L', code: 'A' });
  const post = seen.find((r) => r.init && r.init.method === 'POST');
  assert.match(new URLSearchParams(post.init.body).get('query'), /op="IN" value="L"/);
});

test('main asks for the organisms of the ids with one POST', async () => {
  reset();
  const Node = install();
  const el = new Node('div');
  const seen = mockFetch({ T: template() }, ['H. sapiens']);
  tr.main(el, service, { Gene: { value: [3, 4] } }, {}, {}, () => {});
  await flush();
  const posts = seen.filter((r) => r.init && r.init.method === 'POST');
  assert.strictEqual(posts.length, 1);
  assert.match(posts[0].url, /\/service\/query\/results$/);
  const body = new URLSearchParams(posts[0].init.body);
  assert.strictEqual(body.get('summaryPath'), 'Gene.organism.shortName');
  assert.match(body.get('query'), /<value>3<\/value><value>4<\/value>/);
});

test('main moves templates that cannot match the genes to the not-run section with the reason', async () => {
  reset();
  const Node = install();
  const el = new Node('div');
  const s = template({ title: 'Sk', where: [
    { path: 'Gene', op: 'LOOKUP', value: 'a', code: 'A', editable: true },
    { path: 'Gene.organism.shortName', op: '=', value: 'S. cerevisiae', code: 'B', editable: false }
  ] });
  mockFetch({ S: s, T: template({ title: 'Plain' }) }, ['H. sapiens', 'M. musculus']);
  tr.main(el, service, { Gene: { value: 1 } }, {}, {}, () => {});
  await flush();
  assert.strictEqual(el.find('button').length, 1);
  assert.match(el.textContent, /Not run: Limited to S\. cerevisiae\. Your genes are in H\. sapiens, M\. musculus\./);
  assert.match(el.textContent, /1 template to run/);
  assert.match(el.textContent, /1 template not run/);
});

test('main shows every template and says so when the organisms cannot be read', async () => {
  reset();
  const Node = install();
  const el = new Node('div');
  const s = template({ title: 'Sk', where: [
    { path: 'Gene', op: 'LOOKUP', value: 'a', code: 'A', editable: true },
    { path: 'Gene.organism.shortName', op: '=', value: 'S. cerevisiae', code: 'B', editable: false }
  ] });
  mockFetch({ S: s }, new Error('offline'));
  tr.main(el, service, { Gene: { value: 1 } }, {}, {}, () => {});
  await flush();
  assert.strictEqual(el.find('button').length, 1);
  assert.match(el.textContent, /Could not read the organisms of your genes \(offline\)/);
});

test('main reports a fetch failure with the status and a Retry button that tries again', async () => {
  reset();
  const Node = install();
  const el = new Node('div');
  globalThis.fetch = async () => ({ ok: false, status: 502 });
  tr.main(el, service, { Gene: { value: 1 } }, {}, {}, () => {});
  await flush();
  assert.match(el.textContent, /Could not load templates from the mine \(HTTP 502\)/);
  assert.strictEqual(el.find('p')[0].getAttribute('role'), 'alert');
  mockFetch({ T: template() }, ['H. sapiens']);
  el.find('button')[0].listeners.click({ preventDefault() {} });
  await flush();
  assert.strictEqual(el.find('button')[0].getAttribute('aria-label'), 'Run Title');
});

test('main shows a message when no gene is given', () => {
  reset();
  const Node = install();
  const el = new Node('div');
  tr.main(el, service, { Gene: { value: [] } }, {}, {}, () => {});
  assert.match(el.textContent, /No genes/);
});

test('templates are fetched once per mine and again after a failure', async () => {
  reset();
  const Node = install();
  const seen = mockFetch({ T: template() }, ['H. sapiens']);
  const count = () => seen.filter((r) => /\/templates\?/.test(r.url)).length;
  tr.main(new Node('div'), service, { Gene: { value: 1 } }, {}, {}, () => {});
  await flush();
  tr.main(new Node('div'), service, { Gene: { value: 1 } }, {}, {}, () => {});
  await flush();
  assert.strictEqual(count(), 1);
  reset();
  let fail = true;
  globalThis.fetch = async (url) => {
    if (/\/templates\?/.test(url)) {
      if (fail) { fail = false; return { ok: false, status: 500 }; }
      return { ok: true, status: 200, json: async () => ({ templates: { T: template() } }) };
    }
    return { ok: true, status: 200, json: async () => ({ results: [['H. sapiens', 1]] }) };
  };
  const el = new Node('div');
  tr.main(el, service, { Gene: { value: 1 } }, {}, {}, () => {});
  await flush();
  tr.main(el, service, { Gene: { value: 1 } }, {}, {}, () => {});
  await flush();
  assert.strictEqual(el.find('button').length, 1);
});

test('a 429 is retried after the backoff and then succeeds', async () => {
  reset();
  const Node = install();
  let calls = 0;
  globalThis.fetch = async (url) => {
    if (/\/templates\?/.test(url)) {
      calls++;
      if (calls < 3) return { ok: false, status: 429 };
      return { ok: true, status: 200, json: async () => ({ templates: { T: template() } }) };
    }
    return { ok: true, status: 200, json: async () => ({ results: [] }) };
  };
  const el = new Node('div');
  tr.main(el, service, { Gene: { value: 1 } }, {}, {}, () => {});
  await new Promise((r) => setTimeout(r, 30));
  assert.strictEqual(calls, 3);
  assert.strictEqual(el.find('button').length, 1);
});

test('a 429 that outlasts the backoff is shown as a failure', async () => {
  reset();
  tr.settings.backoffMs = [0, 0];
  const Node = install();
  let calls = 0;
  globalThis.fetch = async () => { calls++; return { ok: false, status: 429 }; };
  const el = new Node('div');
  tr.main(el, service, { Gene: { value: 1 } }, {}, {}, () => {});
  await new Promise((r) => setTimeout(r, 30));
  assert.strictEqual(calls, 3 + 3);
  assert.match(el.textContent, /HTTP 429/);
});

test('a request that exceeds the timeout is aborted and reported', async () => {
  reset();
  tr.settings.timeoutMs = 10;
  const Node = install();
  globalThis.fetch = (url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; reject(e); });
  });
  const el = new Node('div');
  tr.main(el, service, { Gene: { value: 1 } }, {}, {}, () => {});
  await new Promise((r) => setTimeout(r, 60));
  assert.match(el.textContent, /timed out after 0\.01 s/);
});

test('headings use the singular for one template', async () => {
  reset();
  const Node = install();
  const mk = (n) => { const o = {}; for (let i = 0; i < n; i++) o['T' + i] = template({ name: 'T' + i, title: 'T' + i }); return o; };
  let el = new Node('div');
  mockFetch(mk(1), ['H. sapiens']);
  tr.main(el, service, { Gene: { value: 1 } }, {}, {}, () => {});
  await flush();
  assert.match(el.textContent, /1 template to run/);
  assert.doesNotMatch(el.textContent, /1 templates/);
  reset();
  el = new Node('div');
  mockFetch(mk(2), ['H. sapiens']);
  tr.main(el, service, { Gene: { value: 1 } }, {}, {}, () => {});
  await flush();
  assert.match(el.textContent, /2 templates to run/);
});

test('buttons name their template and messages carry a role', async () => {
  reset();
  const Node = install();
  const el = new Node('div');
  mockFetch({ T: template({ title: 'Gene things' }) }, ['H. sapiens']);
  tr.main(el, service, { Gene: { value: 1 } }, {}, {}, () => {});
  assert.strictEqual(el.find('p')[0].getAttribute('role'), 'status');
  await flush();
  assert.strictEqual(el.find('button')[0].getAttribute('aria-label'), 'Run Gene things');
  const h = el.find('h4')[0];
  assert.strictEqual(el.find('ul')[0].getAttribute('aria-labelledby'), h.getAttribute('id'));
});

// Live shapes: trimmed copies of /templates and the model of alliancemine.alliancegenome.org.

test('live templates: yeast-limited ones are not run for human and mouse genes', () => {
  const p = tr.partition(liveTemplates, liveService, ['H. sapiens', 'M. musculus']);
  assert.deepStrictEqual(p.runnable.map((e) => e.template.name), ['Gene_DOTerm', 'Gene_GOTerms', 'Gene_Orthologs']);
  assert.deepStrictEqual(p.skipped.map((e) => e.template.name), ['Gene_Homologs', 'Gene_Protein_Half_Life', 'Gene_Transcript', 'Gene_GenomicDNA']);
  assert.match(p.skipped[0].reason, /Limited to S\. cerevisiae\. Your genes are in H\. sapiens, M\. musculus\./);
});

test('live templates: every template runs when the organisms are unknown or include yeast', () => {
  const names = (p) => p.runnable.map((e) => e.template.name);
  assert.strictEqual(tr.partition(liveTemplates, liveService, null).runnable.length, 7);
  const yeast = tr.partition(liveTemplates, liveService, ['S. cerevisiae', 'H. sapiens']);
  assert.strictEqual(yeast.skipped.length, 0);
  assert.ok(names(yeast).includes('Gene_Homologs'));
});

test('live templates: Gene_DOTerm runs without the column the model lacks', () => {
  const p = tr.partition(liveTemplates, liveService, null);
  const e = p.runnable.find((x) => x.template.name === 'Gene_DOTerm');
  assert.ok(e);
  assert.deepStrictEqual(e.dropped, ['Gene.diseaseAnnotation.evidence.withText']);
  assert.strictEqual(e.template.select.length, 9);
  assert.ok(!e.template.select.includes('Gene.diseaseAnnotation.evidence.withText'));
  assert.strictEqual(liveTemplates.Gene_DOTerm.select.length, 10);
});

test('live templates: Gene_Transcript shows its dropped columns; a missing where path hides and is counted', () => {
  const p = tr.partition(liveTemplates, liveService, null);
  assert.strictEqual(p.hidden.length, 0);
  const tx = p.runnable.find((x) => x.template.name === 'Gene_Transcript');
  assert.deepStrictEqual(tx.dropped.sort(), ['Gene.transcripts.in_gal', 'Gene.transcripts.in_ypd']);
  const broken = JSON.parse(JSON.stringify(liveTemplates.Gene_GOTerms));
  broken.name = 'Broken';
  broken.where.push({ path: 'Gene.nope', op: '=', value: 'x', code: 'B' });
  const q = tr.partition({ Broken: broken }, liveService, null);
  assert.strictEqual(q.runnable.length, 0);
  assert.deepStrictEqual(q.hidden.map((h) => [h.template.name, h.missing]), [['Broken', ['Gene.nope']]]);
});

test('main says how many templates are hidden and names them on hover', async () => {
  reset();
  const Node = install();
  const el = new Node('div');
  const broken = template({ name: 'Broken', title: 'Broken one', where: [
    { path: 'Gene', op: 'LOOKUP', value: 'a', code: 'A', editable: true },
    { path: 'Gene.zzz', op: '=', value: '1', code: 'B' }
  ] });
  mockFetch({ T: template(), B: broken }, ['H. sapiens']);
  tr.main(el, service, { Gene: { value: 1 } }, {}, {}, () => {});
  await flush();
  assert.match(el.textContent, /1 template hidden: the mine model lacks paths it uses\./);
  const note = el.find('p').find((p) => /hidden/.test(p.textContent));
  assert.match(note.getAttribute('title'), /Broken one \(Gene\.zzz\)/);
});

test('live Gene_GenomicDNA keeps its yeast limit as an extra constraint inside the logic', () => {
  const t = liveTemplates.Gene_GenomicDNA;
  const lookup = t.where.find((c) => c.op === 'LOOKUP');
  const q = tr.rewriteQuery(t, lookup, { ids: [1, 2] });
  assert.strictEqual(q.constraintLogic, '((C or D) and E) and A');
  assert.deepStrictEqual(q.where.find((c) => c.code === 'A'), { path: 'Gene.organism.shortName', op: '=', value: 'S. cerevisiae', code: 'A' });
  assert.deepStrictEqual(q.where.find((c) => c.code === 'E'), { path: 'Gene.id', op: 'ONE OF', values: ['1', '2'], code: 'E' });
  assert.ok(q.where.every((c) => !('extraValue' in c)));
});

test('extraValue without constraint logic adds the constraint and no logic', () => {
  const t = template({ where: [{ path: 'Gene', op: 'LOOKUP', value: 'a', extraValue: 'S. cerevisiae', code: 'A', editable: true }] });
  const q = tr.rewriteQuery(t, t.where[0], { ids: [1] });
  assert.strictEqual(q.constraintLogic, undefined);
  assert.deepStrictEqual(q.where[1], { path: 'Gene.organism.shortName', op: '=', value: 'S. cerevisiae', code: 'B' });
});

test('live Gene_Homologs keeps its locked yeast constraint and logic', () => {
  const t = liveTemplates.Gene_Homologs;
  const lookup = t.where.find((c) => c.op === 'LOOKUP');
  const q = tr.rewriteQuery(t, lookup, { ids: [44549531] });
  assert.strictEqual(q.constraintLogic, 'A and B and D');
  assert.deepStrictEqual(q.orderBy, [{ path: 'Gene.homologues.homologue.organism.shortName', direction: 'ASC' }]);
  assert.strictEqual(q.where.find((c) => c.code === 'B').value, 'S. cerevisiae');
});

test('constraints switched OFF are dropped with their codes', () => {
  const t = template({ constraintLogic: 'A and (B or C)', where: [
    { path: 'Gene', op: 'LOOKUP', value: 'a', code: 'A', editable: true },
    { path: 'Gene.symbol', op: '=', value: 'x', code: 'B', switched: 'OFF' },
    { path: 'Gene.symbol', op: '=', value: 'y', code: 'C', switched: 'ON' }
  ] });
  const q = tr.rewriteQuery(t, t.where[0], { ids: [1] });
  assert.deepStrictEqual(q.where.map((c) => c.code), ['A', 'C']);
  assert.strictEqual(q.constraintLogic, 'A and C');
});

test('pruneLogic removes codes and keeps the needed parentheses', () => {
  assert.strictEqual(tr.pruneLogic('A and B', ['B']), 'A');
  assert.strictEqual(tr.pruneLogic('A or (B and C)', ['A']), 'B and C');
  assert.strictEqual(tr.pruneLogic('(A or B) and C', ['C']), 'A or B');
  assert.strictEqual(tr.pruneLogic('A and (B or C) and D', ['B']), 'A and C and D');
  assert.strictEqual(tr.pruneLogic('A and B', ['A', 'B']), null);
});

test('rewriteQuery without OFF constraints leaves the logic unchanged', () => {
  const t = template({ constraintLogic: '(A or B) and C', where: [
    { path: 'Gene', op: 'LOOKUP', value: 'a', code: 'C', editable: true },
    { path: 'Gene.symbol', op: '=', value: 'x', code: 'A' },
    { path: 'Gene.symbol', op: '=', value: 'y', code: 'B' }
  ] });
  assert.strictEqual(tr.rewriteQuery(t, t.where[0], { ids: [1] }).constraintLogic, '(A or B) and C');
});
