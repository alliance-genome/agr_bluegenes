'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { install } = require('./dom-stub.js');
install();
const tool = require('../dist/bundle.js');

const fixture = (name) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8'));
const RIBBON = fixture('ribbon-tp53-brca1.json');
const SLIMMER = fixture('slimmer-tp53-go0003824.json');

const ROOT = 'http://h/mine';
const tick = () => new Promise((r) => setTimeout(r, 10));
const fakeEl = () => document.createElement('div');
const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });

// Fake mine and API. Dispatches on URL; log keeps every request.
function fakeNet({ gene, orthologs = [], ribbon = RIBBON, slimmer = SLIMMER, log = [] } = {}) {
	return async (url, init) => {
		log.push({ url: String(url), init });
		if (String(url).startsWith(ROOT + '/service/query/results')) {
			const query = new URLSearchParams(init.body).get('query');
			if (query.includes('homologues')) return json({ results: orthologs });
			return json({ results: gene ? [gene] : [] });
		}
		if (String(url).includes('/ontology/ribbon/')) return typeof ribbon === 'function' ? ribbon(url) : json(ribbon);
		if (String(url).includes('/bioentityset/slimmer/')) return typeof slimmer === 'function' ? slimmer(url) : json(slimmer);
		throw new Error('unexpected ' + url);
	};
}

const TP53 = ['HGNC:11998', 'TP53', 'H. sapiens', '9606'];
const entity = (v) => ({ Gene: { class: 'Gene', value: v } });

test('serviceRoot appends /service to a mine root and keeps an existing one', () => {
	assert.strictEqual(tool.serviceRoot('http://localhost:9999/alliancetestmine'), 'http://localhost:9999/alliancetestmine/service');
	assert.strictEqual(tool.serviceRoot('http://localhost:9999/alliancetestmine/service/'), 'http://localhost:9999/alliancetestmine/service');
});

test('toAllianceCurie keeps curies from AllianceMine for all 7 species', () => {
	const c = tool.toAllianceCurie;
	assert.strictEqual(c('HGNC:11998', 'H. sapiens'), 'HGNC:11998');
	assert.strictEqual(c('MGI:104537', 'M. musculus'), 'MGI:104537');
	assert.strictEqual(c('RGD:2218', 'R. norvegicus'), 'RGD:2218');
	assert.strictEqual(c('ZFIN:ZDB-GENE-990415-8', 'D. rerio'), 'ZFIN:ZDB-GENE-990415-8');
	assert.strictEqual(c('FB:FBgn0003731', 'D. melanogaster'), 'FB:FBgn0003731');
	assert.strictEqual(c('WB:WBGene00001234', 'C. elegans'), 'WB:WBGene00001234');
	assert.strictEqual(c('SGD:S000002428', 'S. cerevisiae'), 'SGD:S000002428');
});

test('toAllianceCurie adds the prefix to bare ids from other mines, by name or taxon id', () => {
	const c = tool.toAllianceCurie;
	assert.strictEqual(c('11998', 'H. sapiens'), 'HGNC:11998');
	assert.strictEqual(c('104537', '10090'), 'MGI:104537');
	assert.strictEqual(c('2218', 'NCBITaxon:10116'), 'RGD:2218');
	assert.strictEqual(c('ZDB-GENE-990415-8', 'Danio rerio'), 'ZFIN:ZDB-GENE-990415-8');
	assert.strictEqual(c('FBgn0003731', 'D. melanogaster'), 'FB:FBgn0003731');
	assert.strictEqual(c('WBGene00001234', '6239'), 'WB:WBGene00001234');
	assert.strictEqual(c('S000002428', 'S. cerevisiae'), 'SGD:S000002428');
});

test('toAllianceCurie fixes MGI:MGI: and returns null when no curie can be made', () => {
	const c = tool.toAllianceCurie;
	assert.strictEqual(c('MGI:MGI:104537', 'M. musculus'), 'MGI:104537');
	assert.strictEqual(c('', 'H. sapiens'), null);
	assert.strictEqual(c(null, 'H. sapiens'), null);
	assert.strictEqual(c('ENSG00000141510', 'H. sapiens'), null);
	assert.strictEqual(c('FBgn0003731', 'H. sapiens'), null);
	assert.strictEqual(c('11998', 'X. laevis'), null);
	assert.strictEqual(c('11998', undefined), null);
});

test('buildColumns orders each aspect as all, terms, other and keys other groups apart', () => {
	const cols = tool.buildColumns(RIBBON.categories);
	const mf = cols.filter((x) => x.aspect === 'molecular_function');
	assert.strictEqual(mf[0].type, 'All');
	assert.strictEqual(mf[mf.length - 1].type, 'Other');
	assert.strictEqual(mf[mf.length - 1].key, 'GO:0003674-other');
	assert.strictEqual(mf[0].key, 'GO:0003674');
	assert.strictEqual(cols.length, 18 + 23 + 18);
	assert.deepStrictEqual([...new Set(cols.map((x) => x.aspect))], ['molecular_function', 'biological_process', 'cellular_component']);
});

test('countOf reads ALL annotations and level shades by count', () => {
	const cols = tool.buildColumns(RIBBON.categories);
	const tp53 = RIBBON.subjects[0];
	assert.strictEqual(tool.countOf(tp53, cols[0]), 107);
	assert.strictEqual(tool.countOf(tp53, { key: 'GO:none' }), 0);
	assert.strictEqual(tool.countOf(undefined, cols[0]), 0);
	assert.deepStrictEqual([0, 1, 2, 3, 9, 10, 29, 30, 500].map(tool.level), [0, 1, 1, 2, 2, 3, 3, 4, 4]);
});

test('slimsFor asks for the aspect, the term, or the terms of the other group', () => {
	const cols = tool.buildColumns(RIBBON.categories);
	const tp53 = RIBBON.subjects[0];
	assert.deepStrictEqual(tool.slimsFor(tp53, cols[0]), ['GO:0003674']);
	assert.deepStrictEqual(tool.slimsFor(tp53, cols[1]), [cols[1].id]);
	const other = cols.find((x) => x.key === 'GO:0005575-other');
	assert.deepStrictEqual(tool.slimsFor(tp53, other), ['GO:0005737']);
	assert.deepStrictEqual(tool.slimsFor(undefined, other), []);
});

test('toDetails keeps term, evidence code and reference, and drops protein binding and cross-aspect rows', () => {
	const rows = tool.toDetails(SLIMMER, 'molecular_function');
	assert.ok(rows.length >= 1);
	const first = rows[0];
	assert.ok(first.id.startsWith('GO:'));
	assert.ok(first.evidence.length >= 1);
	const merged = tool.toDetails(
		[{ assocs: [
			{ id: 'a', object: { id: 'GO:1', label: 'x', category: ['molecular_activity'] }, evidence_type: 'IDA', reference: ['PMID:1', 'UniProtKB:X'] },
			{ id: 'b', object: { id: 'GO:1', label: 'x', category: ['molecular_activity'] }, evidence_type: 'IMP', reference: ['PMID:2'] },
			{ id: 'b', object: { id: 'GO:1', label: 'x', category: ['molecular_activity'] }, evidence_type: 'IMP', reference: ['PMID:2'] },
			{ id: 'c', object: { id: 'GO:1', label: 'x', category: ['molecular_activity'] }, negated: true, evidence_type: 'IDA', reference: ['PMID:3'] },
			{ id: 'd', object: { id: 'GO:0005515', label: 'protein binding', category: ['molecular_activity'] }, evidence_type: 'IPI', reference: [] },
			{ id: 'e', object: { id: 'GO:2', label: 'y', category: ['biological_process'] }, evidence_type: 'IDA', reference: [] }
		] }],
		'molecular_function'
	);
	assert.strictEqual(merged.length, 2);
	assert.deepStrictEqual(merged[0].evidence, ['IDA', 'IMP']);
	assert.deepStrictEqual(merged[0].references, ['PMID:1', 'PMID:2']);
	assert.strictEqual(merged[1].negated, true);
	assert.deepStrictEqual(tool.toDetails(null, 'molecular_function'), []);
});

test('pickOrthologs takes one species in turn, up to the limit, without the focus gene or duplicates', () => {
	const mk = (id, sym, sp) => [id, sym, sp, ''];
	const rows = [];
	for (let i = 0; i < 5; i++) rows.push(mk('MGI:' + (100 + i), 'm' + i, 'M. musculus'));
	for (let i = 0; i < 5; i++) rows.push(mk('RGD:' + (200 + i), 'r' + i, 'R. norvegicus'));
	rows.push(mk('ZFIN:ZDB-GENE-1', 'z', 'D. rerio'), mk('ZFIN:ZDB-GENE-1', 'z', 'D. rerio'), mk('HGNC:1', 'self', 'H. sapiens'), mk('junk', 'j', 'X. laevis'));
	const r = tool.pickOrthologs(rows, 'HGNC:1', 8);
	assert.strictEqual(r.picked.length, 8);
	assert.strictEqual(r.total, 11);
	assert.ok(r.picked.some((s) => s.curie === 'ZFIN:ZDB-GENE-1'));
	assert.ok(!r.picked.some((s) => s.curie === 'HGNC:1'));
	assert.strictEqual(r.picked.filter((s) => s.curie === 'ZFIN:ZDB-GENE-1').length, 1);
});

test('ribbonUrl and slimmerUrl use apiBase and repeat subject and slim', () => {
	const base = tool.apiBase({ apiBase: 'http://x/api/' });
	assert.strictEqual(base, 'http://x/api');
	assert.strictEqual(tool.apiBase({}), 'https://api.geneontology.org/api');
	const u = tool.ribbonUrl(base, ['HGNC:1', 'MGI:2']);
	assert.ok(u.startsWith('http://x/api/ontology/ribbon/?subset=goslim_agr&subject=HGNC%3A1&subject=MGI%3A2'));
	assert.ok(tool.slimmerUrl(base, 'HGNC:1', ['GO:1', 'GO:2']).includes('slim=GO%3A1&slim=GO%3A2&subject=HGNC%3A1&rows=-1'));
});

test('main renders one row with a labelled button per cell and the source note', async () => {
	const log = [];
	globalThis.fetch = fakeNet({ gene: TP53, log });
	const el = fakeEl();
	tool.main(el, { root: ROOT }, entity(8000038), {}, {});
	await tick();
	const buttons = el.find('button');
	assert.strictEqual(buttons.length, 59);
	const mf = buttons.find((b) => b.getAttribute('aria-label') === 'TP53, all molecular function, 107 annotations');
	assert.ok(mf);
	assert.strictEqual(mf.textContent, '107');
	assert.ok(mf.className.includes('alliance-go-ribbon-l4'));
	assert.ok(buttons.some((b) => b.disabled === true));
	const text = el.textContent;
	assert.ok(text.includes('TP53 (H. sapiens)'));
	assert.ok(text.includes('Data from the Alliance of Genome Resources API'));
	const a = el.find('a')[0];
	assert.strictEqual(a.href, 'https://www.alliancegenome.org/gene/HGNC%3A11998');
	const mine = log.filter((l) => l.url.startsWith(ROOT + '/service/query/results'));
	assert.strictEqual(mine.length, 1);
	assert.strictEqual(mine[0].init.method, 'POST');
	assert.ok(new URLSearchParams(mine[0].init.body).get('query').includes('value="8000038"'));
	const ribbon = log.filter((l) => l.url.includes('/ontology/ribbon/'));
	assert.strictEqual(ribbon.length, 1);
	assert.ok(ribbon[0].url.includes('subject=HGNC%3A11998'));
	assert.ok(ribbon[0].init.signal, 'request carries an abort signal');
});

test('clicking a cell lists term, evidence code and reference', async () => {
	const log = [];
	globalThis.fetch = fakeNet({ gene: TP53, log });
	const el = fakeEl();
	tool.main(el, { root: ROOT }, entity(8000038), {}, {});
	await tick();
	const cell = el.find('button').find((b) => b.getAttribute('aria-label').startsWith('TP53, catalytic activity'));
	assert.ok(cell, 'catalytic activity cell exists');
	cell.listeners.click();
	await tick();
	const slim = log.find((l) => l.url.includes('/bioentityset/slimmer/'));
	assert.ok(slim.url.includes('slim=GO%3A0003824'));
	assert.ok(slim.url.includes('subject=HGNC%3A11998'));
	const text = el.textContent;
	assert.ok(text.includes('Evidence code'));
	assert.ok(text.includes('ATP-dependent DNA/DNA annealing activity'));
	assert.ok(text.includes('GO_REF:0000107'));
	assert.ok(el.find('button').some((b) => b.getAttribute('aria-pressed') === 'true'));
});

test('details failure keeps the ribbon and shows a short message', async () => {
	const errors = [];
	const orig = console.error;
	console.error = (...a) => errors.push(a);
	try {
		globalThis.fetch = fakeNet({ gene: TP53, slimmer: () => json({}, 500) });
		const el = fakeEl();
		tool.main(el, { root: ROOT }, entity(1), {}, {});
		await tick();
		el.find('button').find((b) => b.getAttribute('aria-label').startsWith('TP53, catalytic activity')).listeners.click();
		await tick();
		assert.ok(el.textContent.includes('Could not load GO annotations from the API'));
		assert.ok(el.find('button').length > 0);
		assert.strictEqual(errors.length, 1);
	} finally {
		console.error = orig;
	}
});

test('compare with orthologs requests several subjects and adds rows', async () => {
	const log = [];
	const orthologs = [
		['MGI:104537', 'Brca1', 'M. musculus', '10090'],
		['RGD:2218', 'Tp53', 'R. norvegicus', '10116']
	];
	globalThis.fetch = fakeNet({ gene: TP53, orthologs, log });
	const el = fakeEl();
	tool.main(el, { root: ROOT }, entity(8000038), {}, {});
	await tick();
	const box = el.find('input')[0];
	assert.strictEqual(box.disabled, false);
	box.checked = true;
	box.listeners.change();
	await tick();
	const ribbon = log.filter((l) => l.url.includes('/ontology/ribbon/'));
	assert.strictEqual(ribbon.length, 2);
	assert.ok(ribbon[1].url.includes('subject=HGNC%3A11998&subject=MGI%3A104537&subject=RGD%3A2218'));
	const text = el.textContent;
	assert.ok(text.includes('Brca1 (M. musculus)'));
	assert.ok(text.includes('Tp53 (R. norvegicus)'));
	assert.strictEqual(el.find('tr').length, 2 + 3);
	box.checked = false;
	box.listeners.change();
	await tick();
	assert.strictEqual(el.find('tr').length, 2 + 1);
	assert.strictEqual(log.filter((l) => l.init && l.init.method === 'POST' && l.url.includes('/query/results')).length, 2, 'orthologs fetched once');
});

test('a gene with a bare id from another mine is converted before the API call', async () => {
	const log = [];
	globalThis.fetch = fakeNet({ gene: ['FBgn0003731', 'Egfr', 'D. melanogaster', '7227'], log, ribbon: json(null, 404) });
	const el = fakeEl();
	tool.main(el, { root: ROOT }, entity(8000144), {}, {});
	await tick();
	assert.ok(log.some((l) => l.url.includes('subject=FB%3AFBgn0003731')));
	assert.ok(el.textContent.includes('No GO annotations available'));
});

test('404 from the API shows no data without console.error', async () => {
	const errors = [];
	const orig = console.error;
	console.error = (...a) => errors.push(a);
	try {
		globalThis.fetch = fakeNet({ gene: TP53, ribbon: () => json(null, 404) });
		const el = fakeEl();
		tool.main(el, { root: ROOT }, entity(1), {}, {});
		await tick();
		assert.ok(el.textContent.includes('No GO annotations available'));
		assert.strictEqual(errors.length, 0);
	} finally {
		console.error = orig;
	}
});

test('API failure logs console.error and shows a short message', async () => {
	const errors = [];
	const orig = console.error;
	console.error = (...a) => errors.push(a);
	try {
		globalThis.fetch = fakeNet({ gene: TP53, ribbon: () => json({}, 503) });
		const el = fakeEl();
		tool.main(el, { root: ROOT }, entity(1), {}, {});
		await tick();
		assert.ok(el.textContent.includes('Could not load the GO ribbon from the API'));
		assert.strictEqual(errors.length, 1);
	} finally {
		console.error = orig;
	}
});

test('mine failure logs console.error and shows a short message', async () => {
	const errors = [];
	const orig = console.error;
	console.error = (...a) => errors.push(a);
	try {
		globalThis.fetch = async () => json({}, 500);
		const el = fakeEl();
		tool.main(el, { root: ROOT }, entity(1), {}, {});
		await tick();
		assert.ok(el.textContent.includes('Could not load the gene from the mine'));
		assert.strictEqual(errors.length, 1);
	} finally {
		console.error = orig;
	}
});

test('gene unknown to the mine and gene without a curie give short messages', async () => {
	globalThis.fetch = fakeNet({ gene: null });
	let el = fakeEl();
	tool.main(el, { root: ROOT }, entity(1), {}, {});
	await tick();
	assert.ok(el.textContent.includes('No GO annotations available'));
	globalThis.fetch = fakeNet({ gene: ['ENSG1', 'X', 'H. sapiens', '9606'] });
	el = fakeEl();
	tool.main(el, { root: ROOT }, entity(1), {}, {});
	await tick();
	assert.ok(el.textContent.includes('No Alliance identifier for this gene'));
	el = fakeEl();
	tool.main(el, { root: ROOT }, entity([]), {}, {});
	assert.ok(el.textContent.includes('No GO annotations available'));
});

test('a response for an older entity does not overwrite the newer one', async () => {
	let release;
	const slow = new Promise((r) => { release = r; });
	let n = 0;
	globalThis.fetch = async (url, init) => {
		if (String(url).includes('/query/results')) {
			n += 1;
			if (n === 1) {
				await slow;
				return json({ results: [['HGNC:1', 'OLD', 'H. sapiens', '9606']] });
			}
			return json({ results: [['HGNC:2', 'NEW', 'H. sapiens', '9606']] });
		}
		return json(RIBBON);
	};
	const el = fakeEl();
	tool.main(el, { root: ROOT }, entity(1), {}, {});
	tool.main(el, { root: ROOT }, entity(2), {}, {});
	await tick();
	release();
	await tick();
	assert.ok(el.textContent.includes('NEW'));
	assert.ok(!el.textContent.includes('OLD'));
});

test('apiBase from config is used for requests', async () => {
	const log = [];
	globalThis.fetch = fakeNet({ gene: TP53, log });
	const el = fakeEl();
	tool.main(el, { root: ROOT }, entity(1), {}, { apiBase: 'http://api.test/v1/' });
	await tick();
	assert.ok(log.some((l) => l.url.startsWith('http://api.test/v1/ontology/ribbon/')));
});

test('main throws without arguments', () => {
	assert.throws(() => tool.main(), /correct signature/);
});
