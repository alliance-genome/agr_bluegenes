const test = require('node:test');
const assert = require('node:assert');
const m = require('../dist/bundle.js');
const fx = require('./fixtures.js');

// view order: gene id, identifier, symbol, organism, annotation id, DOID, term, qualifier, code, pmid
function live() {
	return m.applySlims(m.toAnnotations(fx.annotationRows), fx.parentRows);
}

function row(id, symbol, termId, qualifier, org) {
	return [id < 100 ? 1 : 2, 'G:' + symbol, symbol, org || 'H. sapiens', id, termId, 't' + id, qualifier, 'ECO:1', '1'];
}

test('live fixture: annotations get at least 2 slim columns and the filters are not empty', () => {
	const a = live();
	const p = m.pivot(m.filterAnnotations(a, m.newFilters()));
	assert.ok(p.cols.length >= 2, 'columns: ' + p.cols.map((c) => c.slim).join(','));
	assert.ok(p.cols.some((c) => c.slim === 'cancer'));
	assert.ok(m.evidenceCodes(a).length > 1);
	assert.ok(a.some((x) => x.slims.length > 0));
});

test('an annotation whose disease term is itself a slim term lands in that column', () => {
	const a = m.applySlims(m.toAnnotations([row(1, 'AAA', 'DOID:162', 'is_implicated_in')]), []);
	assert.deepStrictEqual(a[0].slims, ['cancer']);
});

test('ancestors outside the slim list add no column, and unknown terms stay without slim', () => {
	const a = m.applySlims(
		m.toAnnotations([row(1, 'AAA', 'DOID:3748', 'is_implicated_in'), row(2, 'AAA', 'DOID:9', 'is_implicated_in')]),
		[['DOID:3748', 'DOID:4', 'disease'], ['DOID:3748', 'DOID:863', 'nervous system disease']]
	);
	assert.deepStrictEqual(a[0].slims, ['nervous system disease']);
	assert.deepStrictEqual(a[1].slims, []);
	assert.deepStrictEqual(m.pivot(a).cols.map((c) => c.slim), ['nervous system disease', m.NO_SLIM]);
});

test('every slim DOID is unique and has a name', () => {
	const ids = m.SLIMS.map((s) => s[0]);
	assert.strictEqual(new Set(ids).size, ids.length);
	m.SLIMS.forEach((s) => assert.ok(/^DOID:\d+$/.test(s[0]) && s[1]));
});

test('toAnnotations merges rows of one annotation and collects codes and PMIDs', () => {
	const a = m.toAnnotations([
		[1, 'HGNC:1', 'AAA', 'H. sapiens', 10, 'DOID:1', 'x', 'is_implicated_in', 'ECO:1', '111'],
		[1, 'HGNC:1', 'AAA', 'H. sapiens', 10, 'DOID:1', 'x', 'is_implicated_in', 'ECO:2', '111'],
		[1, 'HGNC:1', 'AAA', 'H. sapiens', 10, 'DOID:1', 'x', 'is_implicated_in', 'ECO:1', '222'],
		[1, 'HGNC:1', 'AAA', 'H. sapiens', 11, 'DOID:2', 'y', null, null, null]
	]);
	assert.strictEqual(a.length, 2);
	assert.deepStrictEqual(a[0].codes, ['ECO:1', 'ECO:2']);
	assert.deepStrictEqual(a[0].pmids, ['111', '222']);
	assert.strictEqual(a[0].organism, 'H. sapiens');
});

test('negated annotations are recognised and dropped by default', () => {
	const a = live();
	const neg = a.filter((x) => x.negated);
	assert.ok(neg.length >= 1);
	neg.forEach((x) => assert.match(x.qualifier, /^is_not_/));
	const kept = m.filterAnnotations(a, m.newFilters());
	assert.strictEqual(kept.length, a.length - neg.length);
	const withNeg = m.filterAnnotations(a, Object.assign(m.newFilters(), { negated: true }));
	assert.strictEqual(withNeg.length, a.length);
	const total = m.pivot(kept).rows.reduce((n, r) => n + r.total, 0);
	assert.strictEqual(total, kept.length);
});

test('isViaOrthology reads the qualifier only', () => {
	assert.strictEqual(m.isViaOrthology({ qualifier: 'implicated_via_orthology' }), true);
	assert.strictEqual(m.isViaOrthology({ qualifier: 'biomarker_via_orthology' }), true);
	assert.strictEqual(m.isViaOrthology({ qualifier: 'is_implicated_in' }), false);
	assert.strictEqual(m.isViaOrthology({ qualifier: null }), false);
});

test('live fixture: orthology filter splits the annotations', () => {
	const a = m.filterAnnotations(live(), m.newFilters());
	const only = m.filterAnnotations(a, Object.assign(m.newFilters(), { via: 'only' }));
	const excl = m.filterAnnotations(a, Object.assign(m.newFilters(), { via: 'exclude' }));
	assert.ok(only.length > 0 && excl.length > 0);
	assert.strictEqual(only.length + excl.length, a.length);
});

test('evidence code filter keeps annotations that carry the code', () => {
	const a = live();
	const codes = m.evidenceCodes(a);
	assert.ok(codes.indexOf('ECO:0000270') !== -1 || codes.length > 1);
	const f = m.filterAnnotations(a, Object.assign(m.newFilters(), { code: codes[0], negated: true }));
	assert.ok(f.length > 0 && f.length <= a.length);
	f.forEach((x) => assert.ok(x.codes.indexOf(codes[0]) !== -1));
	const none = m.toAnnotations([[1, 'G', 'AAA', 'H. sapiens', 1, 'DOID:1', 't', 'is_implicated_in', null, null]]);
	assert.deepStrictEqual(m.evidenceCodes(none), [m.NO_VALUE]);
	assert.strictEqual(m.filterAnnotations(none, Object.assign(m.newFilters(), { code: m.NO_VALUE })).length, 1);
});

test('species filter and list', () => {
	const a = m.toAnnotations([row(1, 'AAA', 'DOID:1', 'is_implicated_in'), row(2, 'Aaa', 'DOID:1', 'is_implicated_in', 'M. musculus')]);
	assert.deepStrictEqual(m.organisms(a), ['H. sapiens', 'M. musculus']);
	assert.strictEqual(m.filterAnnotations(a, Object.assign(m.newFilters(), { organism: 'M. musculus' })).length, 1);
});

test('pivot counts annotations per gene and slim term, once in each slim column', () => {
	const a = m.applySlims(m.toAnnotations([row(1, 'AAA', 'DOID:162', 'is_implicated_in'), row(2, 'AAA', 'DOID:7', 'is_implicated_in')]),
		[['DOID:7', 'DOID:863', 'x'], ['DOID:7', 'DOID:162', 'y']]);
	const p = m.pivot(a);
	assert.strictEqual(p.rows[0].total, 2);
	assert.strictEqual(p.rows[0].cells.cancer.length, 2);
	assert.strictEqual(p.rows[0].cells['nervous system disease'].length, 1);
});

test('sortRows and sortCols', () => {
	const a = m.applySlims(m.toAnnotations([row(1, 'AAA', 'DOID:162', 'q'), row(200, 'BBB', 'DOID:162', 'q'), row(201, 'BBB', 'DOID:863', 'q')]), []);
	const p = m.pivot(a);
	assert.deepStrictEqual(m.sortRows(p.rows, 'symbol', -1).map((r) => r.symbol), ['BBB', 'AAA']);
	assert.deepStrictEqual(m.sortRows(p.rows, m.TOTAL, -1).map((r) => r.symbol), ['BBB', 'AAA']);
	assert.deepStrictEqual(m.sortCols(p.cols, 'name').map((c) => c.slim), ['cancer', 'nervous system disease']);
	assert.deepStrictEqual(m.sortCols(p.cols, 'count').map((c) => c.slim), ['cancer', 'nervous system disease']);
});

test('toCsv escapes fields, lists species and counts per column', () => {
	const a = m.applySlims(m.toAnnotations([[1, 'HGNC:1', 'A,"B"', 'H. sapiens', 1, 'DOID:162', 't', 'q', null, null]]), []);
	const p = m.pivot(a);
	assert.strictEqual(m.toCsv(p.rows, p.cols), 'Gene,Identifier,Species,Total,cancer\r\n"A,""B""",HGNC:1,H. sapiens,1,1\r\n');
});

test('toLongCsv has one line per annotation with term, qualifier, codes and PMIDs', () => {
	const a = m.applySlims(m.toAnnotations([
		[1, 'HGNC:1', 'AAA', 'H. sapiens', 1, 'DOID:162', 'cancer', 'is_implicated_in', 'ECO:1', '11'],
		[1, 'HGNC:1', 'AAA', 'H. sapiens', 1, 'DOID:162', 'cancer', 'is_implicated_in', 'ECO:2', '12']
	]), []);
	assert.strictEqual(m.toLongCsv(a),
		'Gene,Identifier,Species,Disease term,DOID,Slim terms,Qualifier,Evidence codes,PMIDs\r\n' +
		'AAA,HGNC:1,H. sapiens,cancer,DOID:162,cancer,is_implicated_in,ECO:1; ECO:2,11; 12\r\n');
	assert.strictEqual(m.toLongCsv(live()).split('\r\n').length, live().length + 2);
});

test('withBom prefixes a byte order mark', () => {
	assert.strictEqual(m.withBom('a')[0], '﻿');
});

test('exportName and listName record the active filters', () => {
	const f = Object.assign(m.newFilters(), { via: 'exclude', negated: true, code: 'ECO:0000270' });
	assert.strictEqual(m.exportName('matrix', m.newFilters(), false), 'disease-matrix.csv');
	assert.strictEqual(m.exportName('matrix', f, false), 'disease-matrix_code-eco:0000270-no-orthology-with-negated.csv');
	assert.strictEqual(m.exportName('annotations', m.newFilters(), true), 'disease-matrix-annotations_partial.csv');
	assert.strictEqual(m.listName('cancer', f, '2026-11-23'), 'Disease slim cancer, code ECO:0000270, no orthology, with negated, 2026-11-23');
	assert.notStrictEqual(m.listName('cancer', f, 'd'), m.listName('cancer', m.newFilters(), 'd'));
});

test('cellDetails lists term, DOID, qualifier, codes and PMIDs', () => {
	const a = m.applySlims(m.toAnnotations([[1, 'HGNC:1', 'AAA', 'H. sapiens', 1, 'DOID:162', 'cancer', 'is_not_implicated_in', 'ECO:1', '11']]), []);
	const p = m.pivot(m.filterAnnotations(a, Object.assign(m.newFilters(), { negated: true })));
	assert.deepStrictEqual(m.cellDetails(p.rows[0], 'cancer'),
		[{ term: 'cancer', termId: 'DOID:162', qualifier: 'is_not_implicated_in', negated: true, codes: ['ECO:1'], pmids: ['11'] }]);
});

test('queries ask for ancestors apart from annotations and use only joins on collections', () => {
	const q = m.buildQuery([1, 2]);
	assert.match(q, /Gene\.id" op="ONE OF"/);
	assert.doesNotMatch(q, /slimTerms|parents|evidenceType|viaOrthologyOrder/);
	assert.match(q, /<join path="Gene\.diseaseAnnotation\.evidence\.publications" style="OUTER"\/>/);
	assert.match(m.buildQuery(7), /op="=" value="7"/);
	const pq = m.buildParentsQuery(['DOID:1', 'DOID:2']);
	assert.match(pq, /<join path="DOTerm\.parents" style="OUTER"\/>/);
	assert.match(pq, /DOTerm\.identifier" op="ONE OF"/);
});

function resolve(model, cls, name) {
	for (let c = model[cls]; c; c = model[c.extends[0]]) {
		if (name in c.references) return { ref: c.references[name] };
		if (name in c.collections) return { ref: c.collections[name] };
		if (c.attributes.indexOf(name) !== -1) return { attr: true };
		if (!c.extends.length) break;
	}
	return null;
}

function pathExists(model, path) {
	const parts = path.split('.');
	let cls = parts[0];
	for (let i = 1; i < parts.length; i++) {
		const hit = resolve(model, cls, parts[i]);
		if (!hit) return false;
		if (hit.attr) return i === parts.length - 1;
		cls = hit.ref;
	}
	return false;
}

test('every view path exists in the recorded AllianceMine model', () => {
	m.VIEW.concat(m.PARENT_VIEW).forEach((p) => assert.ok(pathExists(fx.model, p), p));
	assert.ok(!pathExists(fx.model, 'Gene.diseaseAnnotation.nope'));
});

test('config depends lists the view paths', () => {
	const cfg = require('../config.json');
	m.VIEW.filter((p) => p !== 'Gene.id').forEach((p) => assert.ok(cfg.depends.indexOf(p) !== -1, p));
});

test('serviceRoot appends /service once', () => {
	assert.strictEqual(m.serviceRoot('https://x/mine/'), 'https://x/mine/service');
	assert.strictEqual(m.serviceRoot('https://x/mine/service'), 'https://x/mine/service');
});

function reply(status, json, headers) {
	return { status, ok: status >= 200 && status < 300, json: () => Promise.resolve(json), headers: { get: (k) => (headers || {})[k] || null } };
}

function bodyQuery(init) {
	return decodeURIComponent(init.body.split('&query=')[1]);
}

test('fetchAnnotations retries HTTP 429 with backoff and then succeeds', async () => {
	const waits = [];
	let calls = 0;
	const r = await m.fetchAnnotations('https://x/mine', [1], {
		sleep: (ms) => { waits.push(ms); return Promise.resolve(); },
		fetch: (u, init) => {
			calls++;
			if (/DOTerm/.test(bodyQuery(init))) return Promise.resolve(reply(200, { results: fx.parentRows }));
			return Promise.resolve(calls < 3 ? reply(429, {}) : reply(200, { results: fx.annotationRows }));
		}
	});
	assert.deepStrictEqual(waits, [1000, 2000]);
	assert.ok(r.annotations.length > 0);
	assert.ok(r.annotations.some((a) => a.slims.length));
});

test('fetchAnnotations honours Retry-After and gives up after 3 retries with a clear error', async () => {
	const waits = [];
	await assert.rejects(
		m.fetchAnnotations('https://x/mine', [1], {
			sleep: (ms) => { waits.push(ms); return Promise.resolve(); },
			fetch: () => Promise.resolve(reply(429, {}, { 'Retry-After': '5' }))
		}),
		/HTTP 429 after 4 attempts/
	);
	assert.deepStrictEqual(waits, [5000, 5000, 5000]);
});

test('fetchAnnotations aborts a request that exceeds the timeout', async () => {
	const realSet = globalThis.setTimeout;
	globalThis.setTimeout = (f, ms) => realSet(f, ms >= 30000 ? 5 : ms);
	try {
		await assert.rejects(
			m.fetchAnnotations('https://x/mine', [1], {
				fetch: (u, init) => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(Object.assign(new Error('a'), { name: 'AbortError' }))))
			}),
			/timed out after 30 s/
		);
	} finally {
		globalThis.setTimeout = realSet;
	}
});

test('fetchAnnotations sends genes in chunks of 100, one request at a time, and flags a full result', async () => {
	const ids = Array.from({ length: 250 }, (_, i) => i + 1);
	let active = 0;
	let maxActive = 0;
	const sizes = [];
	const r = await m.fetchAnnotations('https://x/mine', ids, {
		fetch: (u, init) => {
			const q = bodyQuery(init);
			active++;
			maxActive = Math.max(maxActive, active);
			if (/DOTerm/.test(q)) {
				return Promise.resolve().then(() => { active--; return reply(200, { results: [] }); });
			}
			sizes.push((q.match(/<value>/g) || []).length);
			const rows = sizes.length === 2 ? new Array(50000).fill(fx.annotationRows[0]) : fx.annotationRows.slice(0, 3);
			return Promise.resolve().then(() => { active--; return reply(200, { results: rows }); });
		}
	});
	assert.deepStrictEqual(sizes, [100, 100, 50]);
	assert.strictEqual(maxActive, 1);
	assert.strictEqual(r.truncated, true);
});
