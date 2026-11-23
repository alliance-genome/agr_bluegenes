'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { install } = require('./dom-stub.js');
install();
const tool = require('../dist/bundle.js');
const live = require('./fixtures/live.json');
const model = require('./fixtures/model.json');
const config = require('../config.json');

tool.settings.delayMs = 1;

test('serviceRoot appends /service and keeps an existing one', () => {
	assert.strictEqual(tool.serviceRoot('https://h/alliancemine/'), 'https://h/alliancemine/service');
	assert.strictEqual(tool.serviceRoot('https://h/alliancemine/service'), 'https://h/alliancemine/service');
});

test('buildQuery escapes ids, uses ONE OF for several and sorts for paging', () => {
	assert.ok(tool.buildQuery('1"><x/>').includes('value="1&quot;&gt;&lt;x/&gt;"'));
	const q = tool.buildQuery(['1', '2']);
	assert.ok(q.includes('op="ONE OF"') && q.includes('<value>2</value>'));
	assert.ok(q.includes('Gene.expressionAnnotations.anatomy.name'));
	assert.ok(q.includes('Gene.expressionAnnotations.stageTerm'));
	assert.ok(q.includes('Gene.expressionAnnotations.source') && q.includes('Gene.organism.shortName'));
	assert.ok(q.includes('sortOrder="Gene.id asc Gene.expressionAnnotations.id asc"'));
});

test('requestBody is form encoded with a page size and start', () => {
	assert.ok(/^format=json&size=\d+&start=0&query=/.test(tool.requestBody(['1'])));
	assert.ok(tool.requestBody(['1'], 30).includes('&start=30&'));
	assert.ok(/^format=json&size=3&query=/.test(tool.geneRequestBody([1, 2, 3])));
	assert.ok(!tool.buildGeneQuery([1, 2]).includes('expressionAnnotations'));
});

const pathsOf = (xml) => (/view="([^"]+)"/.exec(xml)[1]).split(' ');
const resolves = (p) => {
	const parts = p.split('.');
	let cls = model[parts[0]];
	for (let i = 1; i < parts.length; i++) {
		const name = parts[i];
		const last = i === parts.length - 1;
		if (last && cls.attributes[name]) return true;
		const ref = cls.references[name] || cls.collections[name];
		if (!ref || last) return false;
		cls = model[ref.referencedType];
		if (!cls) return false;
	}
	return false;
};

test('every view and depends path exists in the saved AllianceMine model', () => {
	const paths = pathsOf(tool.buildQuery([1])).concat(pathsOf(tool.buildGeneQuery([1])), config.depends);
	paths.forEach((p) => assert.ok(resolves(p), p));
});

test('config.json names a group and depends on the paths the view uses', () => {
	assert.strictEqual(config.group, 'Annotation');
	pathsOf(tool.buildQuery([1])).forEach((p) => assert.ok(config.depends.includes(p), p));
});

const tick = () => new Promise((r) => setTimeout(r, 15));
const isPage = (body) => decodeURIComponent(body).includes('Gene.expressionAnnotations.id');
const startOf = (body) => Number(/&start=(\d+)&/.exec(body)[1]);

// Answers gene queries from info and annotation queries from pages, as the mine does.
function mine({ info, annotations }) {
	const calls = [];
	globalThis.fetch = async (u, i) => {
		calls.push({ url: u, init: i, body: i.body });
		const results = isPage(i.body) ? annotations.slice(startOf(i.body), startOf(i.body) + tool.settings.pageSize) : info;
		return { ok: true, status: 200, json: async () => ({ results }) };
	};
	return calls;
}
const all = live.page1.concat(live.page2);

const headers = (el) => el.find('thead')[0].find('th').map((th) => th.find('button')[0] && th.find('button')[0].textContent);

test('main loads genes and rows from service.root and renders every requested gene', async () => {
	const calls = mine({ info: live.info, annotations: all });
	const el = document.createElement('div');
	tool.main(el, { root: 'https://h/alliancemine' }, { Gene: { value: [44551229, 44178454, 44224468], class: 'Gene' } }, {}, {}, () => {});
	await tick();
	assert.strictEqual(calls[0].url, 'https://h/alliancemine/service/query/results');
	assert.strictEqual(calls[0].init.method, 'POST');
	assert.strictEqual(el.find('table').length, 1);
	assert.deepStrictEqual(headers(el), ['Anatomy term', 'TP53', 'Pax6', 'Pax6', 'Genes ▼', 'Total']);
	assert.ok(/No expression annotations in this mine for TP53 \(H\. sapiens\), Pax6 \(R\. norvegicus\)\./.test(el.textContent));
	const spans = el.find('thead')[0].find('span').map((s) => s.textContent);
	assert.deepStrictEqual(spans, ['H. sapiens', 'M. musculus', 'R. norvegicus']);
});

test('pages through the results until a short page and reports no truncation', async () => {
	tool.settings.pageSize = 3;
	const calls = mine({ info: live.info, annotations: all });
	const el = document.createElement('div');
	tool.main(el, { root: 'https://h/m' }, { Gene: { value: [44551229, 44178454, 44224468] } });
	await tick();
	tool.settings.pageSize = 10000;
	const starts = calls.filter((c) => isPage(c.body)).map((c) => startOf(c.body));
	assert.deepStrictEqual(starts, [0, 3, 6]);
	assert.strictEqual(el.find('tbody')[0].find('tr').length, 5);
	assert.ok(!/Stopped after/.test(el.textContent));
});

test('stops at the row limit and names the genes cut off', async () => {
	tool.settings.pageSize = 4;
	tool.settings.maxRows = 4;
	mine({ info: live.info, annotations: all });
	const el = document.createElement('div');
	tool.main(el, { root: 'https://h/m' }, { Gene: { value: [44551229, 44178454, 44224468] } });
	await tick();
	tool.settings.pageSize = 10000;
	tool.settings.maxRows = 100000;
	assert.ok(/Stopped after 4 annotation rows/.test(el.textContent));
	assert.ok(/Counts for Pax6 \(M\. musculus\) may be incomplete/.test(el.textContent));
	assert.ok(/No rows loaded for TP53 \(H\. sapiens\), Pax6 \(R\. norvegicus\)/.test(el.textContent));
});

test('postJson retries 429 and gives up with a visible error', async () => {
	let n = 0;
	globalThis.fetch = async () => (++n < 3 ? { ok: false, status: 429 } : { ok: true, status: 200, json: async () => ({ results: [] }) });
	assert.deepStrictEqual(await tool.postJson('u', 'b'), { results: [] });
	assert.strictEqual(n, 3);
	globalThis.fetch = async () => ({ ok: false, status: 429 });
	const el = document.createElement('div');
	tool.main(el, { root: 'https://h/m' }, { Gene: { value: 1 } });
	await new Promise((r) => setTimeout(r, 60));
	assert.ok(/Could not load expression annotations from the mine \(HTTP 429\)/.test(el.textContent));
});

test('postJson aborts a request that exceeds the timeout', async () => {
	tool.settings.timeoutMs = 10;
	globalThis.fetch = (u, i) => new Promise((resolve, reject) => {
		i.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
	});
	await assert.rejects(tool.postJson('u', 'b'), /timed out after 0 s/);
	tool.settings.timeoutMs = 30000;
});

test('main tolerates a missing context and shows no save button', async () => {
	mine({ info: live.info, annotations: all });
	const el = document.createElement('div');
	tool.main(el, { root: 'https://h/m' }, { Gene: { value: 1 } }, {}, {}, () => {}, undefined);
	await tick();
	assert.ok(!el.find('button').some((b) => /^Save/.test(b.textContent)));
});

test('a save button per term calls context.saveList with the gene internal ids', async () => {
	mine({ info: live.info, annotations: all });
	const saved = [];
	const context = { saveList: (arg) => { saved.push(arg); return Promise.resolve(arg.name); } };
	const el = document.createElement('div');
	tool.main(el, { root: 'https://h/m' }, { Gene: { value: [44551229, 44178454, 44224468] } }, {}, {}, () => {}, context);
	await tick();
	const btn = el.find('button').filter((b) => /^Save 1 gene$/.test(b.textContent))[0];
	btn.listeners.click();
	await tick();
	assert.strictEqual(saved.length, 1);
	assert.strictEqual(saved[0].class, 'Gene');
	assert.deepStrictEqual(saved[0].ids, [44178454]);
	assert.ok(/^Expression: /.test(saved[0].name));
	assert.ok(/Saved list Expression: /.test(el.textContent));
});

test('main reports an empty id list and a failed request', async () => {
	const el = document.createElement('div');
	tool.main(el, { root: 'https://h/m' }, { Gene: { value: [] } });
	assert.ok(/No expression/.test(el.textContent));
	globalThis.fetch = async () => ({ ok: false, status: 502 });
	const el2 = document.createElement('div');
	tool.main(el2, { root: 'https://h/m' }, { Gene: { value: 1 } });
	await tick();
	assert.ok(/Could not load/.test(el2.textContent) && /HTTP 502/.test(el2.textContent));
});

test('main shows an empty message when the genes have no annotations', async () => {
	mine({ info: live.info, annotations: [] });
	const el = document.createElement('div');
	tool.main(el, { root: 'https://h/m' }, { Gene: { value: 1 } });
	await tick();
	assert.ok(/No expression annotations/.test(el.textContent));
});

test('a stale response does not overwrite a newer one', async () => {
	let n = 0;
	globalThis.fetch = async (u, i) => {
		const mineCall = ++n;
		if (mineCall <= 2) await new Promise((r) => setTimeout(r, 20));
		const results = isPage(i.body) ? (mineCall <= 2 ? [] : all) : live.info;
		return { ok: true, status: 200, json: async () => ({ results }) };
	};
	const el = document.createElement('div');
	tool.main(el, { root: 'https://h/m' }, { Gene: { value: 1 } });
	tool.main(el, { root: 'https://h/m' }, { Gene: { value: 2 } });
	await new Promise((r) => setTimeout(r, 80));
	assert.strictEqual(el.find('table').length, 1);
});

const termOrder = (el) => el.find('tbody')[0].find('tr').map((tr) => tr.find('th')[0].textContent);

test('clicking a sort header and the stage select re-renders the table', async () => {
	const g = (gene, ann, name, aid, stage) => [gene, gene.toLowerCase(), ann, name, aid, stage, ann < 4 ? 1 : 2, 'S', 'M. musculus'];
	const rowsData = [
		g('G1', 1, 'liver', 'U:1', 'adult'),
		g('G1', 2, 'liver', 'U:1', 'adult'),
		g('G1', 3, 'brain', 'U:2', 'embryo'),
		g('G2', 4, 'brain', 'U:2', 'embryo'),
		g('G2', 5, 'brain', 'U:2', 'embryo')
	];
	mine({ info: [['G1', 'g1', 1, 'M. musculus'], ['G2', 'g2', 2, 'M. musculus']], annotations: rowsData });
	const el = document.createElement('div');
	tool.main(el, { root: 'https://h/m' }, { Gene: { value: [1, 2] } });
	await tick();
	assert.deepStrictEqual(headers(el).slice(0, 3), ['Anatomy term', 'g1', 'g2']);
	assert.deepStrictEqual(termOrder(el), ['brain', 'liver']);
	const nameBtn = el.find('thead')[0].find('button')[0];
	nameBtn.listeners.click();
	assert.deepStrictEqual(termOrder(el), ['brain', 'liver']);
	assert.strictEqual(el.find('thead')[0].find('th')[0].getAttribute('aria-sort'), 'ascending');
	nameBtn.listeners.click();
	assert.deepStrictEqual(termOrder(el), ['liver', 'brain']);
	const select = el.find('select')[0];
	select.value = 'adult';
	select.listeners.change();
	assert.deepStrictEqual(termOrder(el), ['liver']);
	select.value = 'bucket:embryo';
	select.listeners.change();
	assert.deepStrictEqual(termOrder(el), ['brain']);
});

test('cells carry an aria-label, headers a scope, and a legend shows the bin edges', async () => {
	mine({ info: live.info, annotations: all });
	const el = document.createElement('div');
	tool.main(el, { root: 'https://h/m' }, { Gene: { value: [44551229, 44178454, 44224468] } });
	await tick();
	const cell = el.find('td').filter((td) => /Pax6 \(M\. musculus\): 1 annotation from MGI$/.test(td.getAttribute('aria-label') || ''))[0];
	assert.ok(cell, 'labelled cell');
	assert.strictEqual(cell.getAttribute('aria-label'), cell.title);
	assert.ok(el.find('tbody')[0].find('th').every((th) => th.getAttribute('scope') === 'row'));
	assert.ok(el.find('thead')[0].find('th').every((th) => th.getAttribute('scope') === 'col'));
	assert.ok(/Annotation records:1/.test(el.textContent));
	const region = el.find('div').filter((d) => d.getAttribute('role') === 'region')[0];
	assert.strictEqual(region.getAttribute('tabindex'), '0');
});

test('the metric select changes the legend title and the cell counts', async () => {
	const dup = [
		['MGI:97490', 'Pax6', 59725747, 'brain', 'EMAPA:1', 'TS17', 44178454, 'MGI', 'M. musculus'],
		['MGI:97490', 'Pax6', 59725748, 'brain', 'EMAPA:1', 'TS17', 44178454, 'MGI', 'M. musculus']
	];
	mine({ info: live.info.slice(1, 2), annotations: dup });
	const el = document.createElement('div');
	tool.main(el, { root: 'https://h/m' }, { Gene: { value: 44178454 } });
	await tick();
	const cellText = () => el.find('tbody')[0].find('td')[0].textContent;
	assert.strictEqual(cellText(), '2');
	const metric = el.find('select').filter((s) => s.getAttribute('aria-label') === 'Cell value')[0];
	metric.value = 'stages';
	metric.listeners.change();
	assert.strictEqual(cellText(), '1');
	assert.ok(/Distinct stages:1/.test(el.textContent));
});

test('show more, term search and hide generic terms re-render the table', async () => {
	const many = [];
	for (let i = 0; i < 50; i++) many.push(['MGI:97490', 'Pax6', i + 1, 'term' + i, 'T:' + i, 'TS02', 44178454, 'MGI', 'M. musculus']);
	many.push(['MGI:97490', 'Pax6', 99, 'C. elegans anatomical entity', 'W:1', 'TS02', 44178454, 'MGI', 'M. musculus']);
	mine({ info: live.info.slice(1, 2), annotations: many });
	const el = document.createElement('div');
	tool.main(el, { root: 'https://h/m' }, { Gene: { value: 44178454 } });
	await tick();
	assert.strictEqual(termOrder(el).length, 40);
	el.find('button').filter((b) => /^Show 11 more terms$/.test(b.textContent))[0].listeners.click();
	assert.strictEqual(termOrder(el).length, 51);
	const input = el.find('input');
	const search = input.filter((i) => i.type === 'search')[0];
	search.value = 'anatomical';
	search.listeners.input();
	assert.deepStrictEqual(termOrder(el), ['C. elegans anatomical entity']);
	search.value = '';
	search.listeners.input();
	const hide = input.filter((i) => i.type === 'checkbox')[0];
	hide.checked = true;
	hide.listeners.change();
	assert.ok(!termOrder(el).includes('C. elegans anatomical entity'));
});

test('Download CSV exports every term, names the stage and revokes the URL later', async () => {
	const many = [];
	for (let i = 0; i < 45; i++) many.push(['MGI:97490', 'Pax6', i + 1, 'term' + i, 'T:' + i, 'TS02', 44178454, 'MGI', 'M. musculus']);
	many.push(['MGI:97490', 'Pax6', 99, '=cmd', 'T:x', 'TS02', 44178454, 'MGI', 'M. musculus']);
	many.push(['MGI:97490', 'Pax6', 100, 'other stage term', 'T:y', 'TS03', 44178454, 'MGI', 'M. musculus']);
	mine({ info: live.info.slice(1, 2), annotations: many });
	const el = document.createElement('div');
	tool.main(el, { root: 'https://h/m' }, { Gene: { value: 44178454 } });
	await tick();
	const blobs = [];
	const revoked = [];
	const origCreate = URL.createObjectURL;
	const origRevoke = URL.revokeObjectURL;
	URL.createObjectURL = (b) => { blobs.push(b); return 'blob:x'; };
	URL.revokeObjectURL = (u) => revoked.push(u);
	let anchor;
	document.body.appendChild = (a) => { anchor = a; return a; };
	document.body.removeChild = () => {};
	const select = el.find('select')[0];
	select.value = 'TS02';
	select.listeners.change();
	el.find('button').filter((b) => b.textContent === 'Download CSV')[0].onclick();
	try {
		assert.strictEqual(anchor.download, 'expression-heatmap-ts02.csv');
		assert.strictEqual(anchor.clicks, 1);
		assert.deepStrictEqual(revoked, []);
		const lines = (await blobs[0].text()).split('\r\n');
		assert.strictEqual(lines.length, 47);
		assert.ok(lines.some((l) => l.startsWith("'=cmd,")));
		await new Promise((r) => setTimeout(r, 1100));
		assert.deepStrictEqual(revoked, ['blob:x']);
	} finally {
		URL.createObjectURL = origCreate;
		URL.revokeObjectURL = origRevoke;
		delete document.body.appendChild;
		delete document.body.removeChild;
	}
});

test('the footnote credits the Legume Information System', async () => {
	mine({ info: live.info, annotations: all });
	const el = document.createElement('div');
	tool.main(el, { root: 'https://h/m' }, { Gene: { value: 1 } });
	await tick();
	assert.ok(/Legume Information System/.test(el.textContent));
	assert.ok(el.find('a').some((a) => a.href === 'https://github.com/legumeinfo/lis-expression-heatmap'));
});

test('style.css keeps the term column sticky and defines five heat levels', () => {
	const css = fs.readFileSync(path.join(__dirname, '../dist/style.css'), 'utf8');
	assert.ok(/position: sticky/.test(css));
	for (let i = 1; i <= 5; i++) assert.ok(css.includes('-l' + i + ' '), 'l' + i);
});

test('package.json is bumped and the credit is stated once', () => {
	const pkg = require('../package.json');
	assert.strictEqual(pkg.version, '0.1.1');
	assert.strictEqual(pkg.description.split('legumeinfo/lis-expression-heatmap').length - 1, 1);
});
