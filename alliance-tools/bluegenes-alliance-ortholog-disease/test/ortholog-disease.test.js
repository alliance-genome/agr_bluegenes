'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { install } = require('./dom-stub.js');
install();
const tool = require('../dist/bundle.js');

const ROOT = 'http://localhost:9999/alliancetestmine';

// Row order: Gene.id, Gene.primaryIdentifier, symbol, ortholog id, species, term id, term name, qualifier, code.
const ROWS = [
	[1, 'MGI:1', 'Nf1', 'FB:FBgn1', 'D. melanogaster', 'DOID:1', 'alpha disease', 'is_implicated_in', 'ECO:7'],
	[1, 'MGI:1', 'nf1', 'ZFIN:Z1', 'D. rerio', 'DOID:1', 'alpha disease', 'is_implicated_in', 'ECO:7'],
	[1, 'MGI:1', 'Nf1', 'FB:FBgn1', 'D. melanogaster', 'DOID:1', 'alpha disease', 'is_implicated_in', 'ECO:9'],
	[1, 'MGI:1', 'Nf1', 'FB:FBgn1', 'D. melanogaster', 'DOID:2', 'beta disease', 'is_marker_for', 'ECO:1'],
	[1, 'MGI:1', 'Nf1', 'FB:FBgn1', 'D. melanogaster', 'DOID:3', 'aaa disease', 'is_implicated_in', 'ECO:7'],
	[1, 'MGI:1', 'Nf1', 'FB:FBgn1', 'D. melanogaster', 'DOID:4', 'zzz disease', 'is_implicated_in', 'ECO:7'],
	[1, 'MGI:1', 'nf1', 'ZFIN:Z1', 'D. rerio', 'DOID:4', 'zzz disease', 'is_implicated_in', 'ECO:7'],
	[1, 'MGI:1', 'Gx', 'WB:G', 'C. elegans', null, null, null, null]
];

function stubFetch(responses, calls) {
	globalThis.fetch = async (url, opts) => {
		calls.push({ url, opts });
		const body = String(opts.body);
		const isOwn = decodeURIComponent(body).indexOf('Gene.diseaseAnnotation.ontologyTerm.identifier') !== -1 &&
			decodeURIComponent(body).indexOf('homologues') === -1;
		const r = isOwn ? responses.own : responses.main;
		if (r instanceof Error) throw r;
		return { ok: r.ok !== false, status: r.status || 200, json: async () => ({ results: r.results }) };
	};
}

function text(el) { return el.textContent; }
const tick = () => new Promise((r) => setTimeout(r, 5));

test('groupRows sorts by species count then name and marks own terms', () => {
	const groups = tool.groupRows(ROWS.map(tool.toRow), { 'DOID:2': true });
	assert.deepStrictEqual(groups.map((g) => g.name), ['alpha disease', 'zzz disease', 'aaa disease', 'beta disease']);
	assert.deepStrictEqual(groups.map((g) => g.species.length), [2, 2, 1, 1]);
	assert.deepStrictEqual(groups.map((g) => g.own), [false, false, false, true]);
	const alpha = groups[0];
	assert.strictEqual(alpha.orthologs.length, 2);
	assert.deepStrictEqual(alpha.orthologs[0].codes, ['ECO:7', 'ECO:9']);
});

test('main posts to the service root with a form body and renders terms', async () => {
	const calls = [];
	stubFetch({ main: { results: ROWS }, own: { results: [[1, 'DOID:2']] } }, calls);
	const el = document.createElement('div');
	tool.main(el, { root: ROOT }, { Gene: { class: 'Gene', format: 'ids', value: 1 } }, {}, {}, () => {});
	await tick();
	assert.strictEqual(calls.length, 2);
	calls.forEach((c) => {
		assert.strictEqual(c.url, ROOT + '/service/query/results');
		assert.strictEqual(c.opts.method, 'POST');
		assert.match(c.opts.body, /^format=json&size=\d+&query=/);
	});
	const out = text(el);
	assert.match(out, /4 disease terms on orthologs/);
	assert.match(out, /also annotated to this gene/);
	assert.match(out, /Nf1 \(D\. melanogaster\); is_implicated_in; evidence ECO:7, ECO:9/);
	assert.ok(!/Gx/.test(out));
	const links = el.find('a');
	assert.strictEqual(links[0].href, 'https://disease-ontology.org/?id=DOID:1');
});

test('empty result shows the empty state', async () => {
	stubFetch({ main: { results: [[1, 'MGI:1', 'Gx', 'WB:G', 'C. elegans', null, null, null, null]] }, own: { results: [] } }, []);
	const el = document.createElement('div');
	tool.main(el, { root: ROOT }, { Gene: { value: 1 } }, {}, {}, () => {});
	await tick();
	assert.strictEqual(text(el), 'No disease annotations on orthologs');
});

test('failure of the main query shows a short message and logs', async () => {
	const logged = [];
	const orig = console.error;
	console.error = (...a) => logged.push(a);
	try {
		stubFetch({ main: { ok: false, status: 500, results: [] }, own: { results: [] } }, []);
		const el = document.createElement('div');
		tool.main(el, { root: ROOT }, { Gene: { value: 1 } }, {}, {}, () => {});
		await tick();
		assert.strictEqual(text(el), 'Could not load disease annotations from the mine');
		assert.ok(logged.length >= 1);
	} finally {
		console.error = orig;
	}
});

test('failure of the own-annotation query keeps the terms without badges', async () => {
	const orig = console.error;
	console.error = () => {};
	try {
		stubFetch({ main: { results: ROWS }, own: new Error('down') }, []);
		const el = document.createElement('div');
		tool.main(el, { root: ROOT }, { Gene: { value: 1 } }, {}, {}, () => {});
		await tick();
		assert.match(text(el), /4 disease terms/);
		assert.ok(!/also annotated/.test(text(el)));
	} finally {
		console.error = orig;
	}
});

test('a stale response does not overwrite a newer one', async () => {
	let n = 0;
	globalThis.fetch = (url, opts) => {
		const mine = ++n;
		const slow = mine <= 2;
		return new Promise((resolve) =>
			setTimeout(() => resolve({ ok: true, status: 200, json: async () => ({ results: slow ? ROWS : [] }) }), slow ? 30 : 1)
		);
	};
	const el = document.createElement('div');
	tool.main(el, { root: ROOT }, { Gene: { value: 1 } }, {}, {}, () => {});
	tool.main(el, { root: ROOT }, { Gene: { value: 2 } }, {}, {}, () => {});
	await new Promise((r) => setTimeout(r, 80));
	assert.strictEqual(text(el), 'No disease annotations on orthologs');
});

test('terms collapse after 25 and the button reveals the rest', () => {
	const rows = [];
	for (let i = 0; i < 30; i++) {
		const n = String(i).padStart(2, '0');
		rows.push([1, 'MGI:1', 'S', 'X:' + n, 'D. rerio', 'DOID:' + (100 + i), 'term ' + n, 'q', 'ECO:1']);
	}
	const el = document.createElement('div');
	tool.render(el, rows.map(tool.toRow), {}, false, false);
	const items = el.find('li').filter((li) => li.className === 'alliance-ortholog-disease-term');
	assert.strictEqual(items.length, 30);
	assert.strictEqual(items.filter((li) => li.style && li.style.display === 'none').length, 5);
	const btn = el.find('button')[0];
	assert.strictEqual(btn.textContent, 'Show all 30 terms');
	btn.listeners.click();
	assert.strictEqual(items.filter((li) => li.style && li.style.display === 'none').length, 0);
});

test('list input uses ONE OF and shows the source gene', async () => {
	const calls = [];
	stubFetch({ main: { results: ROWS.slice(0, 1) }, own: { results: [] } }, calls);
	const el = document.createElement('div');
	tool.main(el, { root: ROOT }, { Gene: { value: [1, 2] } }, {}, {}, () => {});
	await tick();
	assert.match(decodeURIComponent(calls[0].opts.body), /op="ONE OF"/);
	assert.match(text(el), /ortholog of MGI:1/);
});

test('main query excludes inferred and NOT qualifiers, own query excludes NOT', async () => {
	const calls = [];
	stubFetch({ main: { results: ROWS }, own: { results: [] } }, calls);
	const el = document.createElement('div');
	tool.main(el, { root: ROOT }, { Gene: { value: 1 } }, {}, {}, () => {});
	await tick();
	const bodies = calls.map((c) => decodeURIComponent(c.opts.body));
	const main = bodies.find((b) => b.indexOf('homologues') !== -1);
	const own = bodies.find((b) => b.indexOf('homologues') === -1);
	const nonePart = /path="Gene\.homologues\.homologue\.diseaseAnnotation\.qualifier" op="NONE OF">(.*?)<\/constraint>/.exec(main);
	assert.ok(nonePart, 'main query has a NONE OF qualifier constraint');
	['implicated_via_orthology', 'biomarker_via_orthology', 'is_not_implicated_in'].forEach((q) =>
		assert.ok(nonePart[1].indexOf('<value>' + q + '</value>') !== -1, q)
	);
	const ownPart = /path="Gene\.diseaseAnnotation\.qualifier" op="NONE OF">(.*?)<\/constraint>/.exec(own);
	assert.ok(ownPart && ownPart[1] === '<value>is_not_implicated_in</value>');
});

test('buildQuery escapes qualifier values into a NONE OF constraint', () => {
	const q = tool.buildQuery(1, ['Gene.id'], null, 'Gene.diseaseAnnotation.qualifier', ['a<b']);
	assert.match(q, /op="NONE OF"><value>a&lt;b<\/value><\/constraint>/);
});

test('serviceRoot appends /service once', () => {
	assert.strictEqual(tool.serviceRoot(ROOT), ROOT + '/service');
	assert.strictEqual(tool.serviceRoot(ROOT + '/service/'), ROOT + '/service');
});
