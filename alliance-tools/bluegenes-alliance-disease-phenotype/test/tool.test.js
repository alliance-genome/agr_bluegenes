'use strict';
const test = require('node:test');
const assert = require('node:assert');

// Minimal DOM: enough for createElement, appendChild, removeChild, textContent, addEventListener.
class FakeNode {
	constructor(tag) {
		this.tag = tag;
		this.children = [];
		this.listeners = {};
		this._text = '';
		this.className = '';
	}
	get firstChild() {
		return this.children[0] || null;
	}
	appendChild(c) {
		this.children.push(c);
		return c;
	}
	removeChild(c) {
		this.children.splice(this.children.indexOf(c), 1);
		return c;
	}
	set textContent(v) {
		this.children = [];
		this._text = String(v);
	}
	get textContent() {
		return this._text + this.children.map((c) => c.textContent).join('');
	}
	addEventListener(name, fn) {
		this.listeners[name] = fn;
	}
	find(tag, out = []) {
		if (this.tag === tag) out.push(this);
		this.children.forEach((c) => c.find(tag, out));
		return out;
	}
}
global.document = { createElement: (tag) => new FakeNode(tag) };

const tool = require('../dist/bundle.js');

function service() {
	return { root: 'http://mine.test/service/' };
}
function stubFetch(handler) {
	const calls = [];
	global.fetch = (url, opts) => {
		calls.push({ url, opts });
		return handler(url, opts, calls.length);
	};
	return calls;
}
function ok(results) {
	return Promise.resolve({ ok: true, json: () => Promise.resolve({ results }) });
}
const tick = () => new Promise((r) => setTimeout(r, 5));

// gene id, pid, symbol, annotation id, term id, term name, qualifier, evidence code, dataset
const D = (aid, code, set, term = 'DOID:1', name = 'asthma', q = 'is_implicated_in', gene = 1) => [
	gene, 'HGNC:' + gene, 'G' + gene, aid, term, name, q, code, set
];
// gene id, pid, symbol, annotation id, statement, pmid
const P = (aid, stmt, pmid, gene = 1) => [gene, 'HGNC:' + gene, 'G' + gene, aid, stmt, pmid];

test('query building: single id, many ids, escaping, outer joins', () => {
	const one = tool.buildDiseaseQuery([42]);
	assert.match(one, /<constraint path="Gene.id" op="=" value="42"\/>/);
	assert.match(one, /Gene.diseaseAnnotation.ontologyTerm.identifier/);
	assert.match(one, /<join path="Gene.diseaseAnnotation.evidence" style="OUTER"\/>/);
	const many = tool.buildPhenotypeQuery([1, 2, '3"<']);
	assert.match(many, /op="ONE OF"><value>1<\/value><value>2<\/value><value>3&quot;&lt;<\/value>/);
	assert.match(many, /Gene.phenotypeAnnotations.phenotypeStatement/);
	assert.doesNotMatch(many, /ontologyTerm.name/);
});

test('entityIds handles scalar, array, duplicates and empty', () => {
	assert.deepStrictEqual(tool.entityIds({ Gene: { value: 7 } }), [7]);
	assert.deepStrictEqual(tool.entityIds({ Gene: { value: [1, 2, 2, null] } }), [1, 2]);
	assert.deepStrictEqual(tool.entityIds({ Gene: { value: '' } }), []);
	assert.deepStrictEqual(tool.entityIds({}), []);
});

test('groupDisease merges annotations with same term and evidence, unions sources', () => {
	const rows = [
		D(10, 'ECO:1', 'MGI'),
		D(10, 'ECO:2', 'MGI'),
		D(11, 'ECO:2', 'RGD'),
		D(11, 'ECO:1', 'RGD'),
		D(12, 'ECO:1', 'MGI'),
		D(13, 'ECO:9', 'MGI', 'DOID:2', 'anemia'),
		[1, 'HGNC:1', 'G1', null, null, null, null, null, null]
	];
	const g = tool.groupDisease(rows);
	assert.strictEqual(g.length, 3);
	assert.strictEqual(g[0].termName, 'anemia');
	const both = g.find((x) => x.codes.join() === 'ECO:1,ECO:2');
	assert.strictEqual(both.count, 2);
	assert.deepStrictEqual(both.sources, ['MGI', 'RGD']);
	const one = g.find((x) => x.codes.join() === 'ECO:1');
	assert.strictEqual(one.count, 1);
});

test('groupDisease keeps genes and qualifiers apart', () => {
	const g = tool.groupDisease([
		D(1, 'ECO:1', 'S', 'DOID:1', 'a', 'is_implicated_in', 1),
		D(2, 'ECO:1', 'S', 'DOID:1', 'a', 'is_marker_for', 1),
		D(3, 'ECO:1', 'S', 'DOID:1', 'a', 'is_implicated_in', 2)
	]);
	assert.strictEqual(g.length, 3);
});

test('groupPhenotype counts annotations and merges publications', () => {
	const g = tool.groupPhenotype([
		P(1, 'small', '111'),
		P(1, 'small', '222'),
		P(2, 'small', '111'),
		P(3, 'large', null),
		[1, 'HGNC:1', 'G1', null, null, null]
	]);
	assert.strictEqual(g.length, 2);
	const small = g.find((x) => x.statement === 'small');
	assert.strictEqual(small.count, 2);
	assert.deepStrictEqual(small.pubs, ['111', '222']);
	assert.deepStrictEqual(g.find((x) => x.statement === 'large').pubs, []);
});

test('main renders both sections with links, text only', async () => {
	const calls = stubFetch((url, opts) =>
		/phenotypeAnnotations/.test(opts.body)
			? ok([P(1, 'abnormal <b>x</b>', '555')])
			: ok([D(1, 'ECO:0000315', 'MGI Data', 'DOID:10652', "Alzheimer's disease")])
	);
	const el = new FakeNode('div');
	tool.main(el, service(), { Gene: { value: 5 } });
	await tick();
	assert.strictEqual(calls.length, 2);
	assert.strictEqual(calls[0].url, 'http://mine.test/service/query/results');
	assert.strictEqual(calls[0].opts.method, 'POST');
	const text = el.textContent;
	assert.match(text, /Disease \(1\)/);
	assert.match(text, /Alzheimer's disease/);
	assert.match(text, /is implicated in/);
	assert.match(text, /ECO:0000315/);
	assert.match(text, /MGI Data/);
	assert.match(text, /Phenotype \(1\)/);
	assert.match(text, /abnormal <b>x<\/b>/);
	const hrefs = el.find('a').map((a) => a.href);
	assert.ok(hrefs.includes('https://disease-ontology.org/?id=DOID:10652'));
	assert.ok(hrefs.includes('https://pubmed.ncbi.nlm.nih.gov/555/'));
	assert.strictEqual(el.find('th').some((t) => t.textContent === 'Gene'), false);
});

test('main shows a Gene column for lists', async () => {
	stubFetch((url, opts) => (/phenotypeAnnotations/.test(opts.body) ? ok([]) : ok([D(1, 'E', 'S', 'DOID:1', 'a', null, 1), D(2, 'E', 'S', 'DOID:1', 'a', null, 2)])));
	const el = new FakeNode('div');
	tool.main(el, service(), { Gene: { value: [1, 2] } });
	await tick();
	assert.ok(el.find('th').some((t) => t.textContent === 'Gene'));
	assert.match(el.textContent, /G1/);
	assert.match(el.textContent, /G2/);
});

test('empty states per section', async () => {
	stubFetch(() => ok([]));
	const el = new FakeNode('div');
	tool.main(el, service(), { Gene: { value: 5 } });
	await tick();
	assert.match(el.textContent, /No disease annotations/);
	assert.match(el.textContent, /No phenotype annotations/);
});

test('missing id shows empty states without fetching', () => {
	const calls = stubFetch(() => ok([]));
	const el = new FakeNode('div');
	tool.main(el, service(), { Gene: { value: '' } });
	assert.strictEqual(calls.length, 0);
	assert.match(el.textContent, /No disease annotations/);
});

test('error in one section leaves the other intact', async () => {
	stubFetch((url, opts) =>
		/phenotypeAnnotations/.test(opts.body)
			? Promise.resolve({ ok: false, status: 500 })
			: ok([D(1, 'E', 'S')])
	);
	const el = new FakeNode('div');
	tool.main(el, service(), { Gene: { value: 5 } });
	await tick();
	assert.match(el.textContent, /asthma/);
	assert.match(el.textContent, /Could not load phenotype annotations from the mine/);
});

test('collapses after 25 rows and Show all expands', async () => {
	const rows = [];
	for (let i = 0; i < 30; i++) rows.push(P(i, 'phenotype ' + String(i).padStart(2, '0'), '1'));
	stubFetch((url, opts) => (/phenotypeAnnotations/.test(opts.body) ? ok(rows) : ok([])));
	const el = new FakeNode('div');
	tool.main(el, service(), { Gene: { value: 5 } });
	await tick();
	const bodyRows = () => el.find('tbody').flatMap((b) => b.children).length;
	assert.strictEqual(bodyRows(), 25);
	const btn = el.find('button')[0];
	assert.match(btn.textContent, /Show all 30/);
	btn.listeners.click();
	assert.strictEqual(bodyRows(), 30);
	assert.strictEqual(el.find('button').length, 0);
});

test('exactly 25 rows shows no button', async () => {
	const rows = [];
	for (let i = 0; i < 25; i++) rows.push(P(i, 'p' + i, '1'));
	stubFetch((url, opts) => (/phenotypeAnnotations/.test(opts.body) ? ok(rows) : ok([])));
	const el = new FakeNode('div');
	tool.main(el, service(), { Gene: { value: 5 } });
	await tick();
	assert.strictEqual(el.find('button').length, 0);
});

test('stale response is ignored', async () => {
	let release;
	const slow = new Promise((r) => (release = r));
	stubFetch((url, opts, n) => {
		if (n <= 2) return slow.then(() => ok([D(1, 'E', 'S', 'DOID:1', 'OLD')]));
		return ok([D(1, 'E', 'S', 'DOID:2', 'NEW')]);
	});
	const el = new FakeNode('div');
	tool.main(el, service(), { Gene: { value: 1 } });
	tool.main(el, service(), { Gene: { value: 2 } });
	await tick();
	release();
	await tick();
	assert.match(el.textContent, /NEW/);
	assert.doesNotMatch(el.textContent, /OLD/);
});

test('main rejects bad signature', () => {
	assert.throws(() => tool.main(null, service(), {}), /correct signature/);
});
