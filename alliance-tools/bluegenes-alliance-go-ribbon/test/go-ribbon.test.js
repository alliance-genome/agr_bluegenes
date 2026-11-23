'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { install } = require('./dom-stub.js');
install();
const tool = require('../dist/bundle.js');

tool.settings.backoff = 1;

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

test('toAllianceCurie handles the identifiers production mines store', () => {
	const c = tool.toAllianceCurie;
	// WormMine, FlyMine, YeastMine as queried: own genes bare, taxon ids as strings, yeast taxon 4932.
	assert.strictEqual(c('WBGene00000001', '6239'), 'WB:WBGene00000001');
	assert.strictEqual(c('FBgn0000001', '7227'), 'FB:FBgn0000001');
	assert.strictEqual(c('S000000001', '4932'), 'SGD:S000000001');
	assert.strictEqual(c('S000000001', 'S. cerevisiae'), 'SGD:S000000001');
	// Homologue ids as WormMine returns them: curies for human, mouse, rat; bare for fly and zebrafish.
	assert.strictEqual(c('HGNC:6091', '9606'), 'HGNC:6091');
	assert.strictEqual(c('MGI:96575', '10090'), 'MGI:96575');
	assert.strictEqual(c('RGD:2917', '10116'), 'RGD:2917');
	assert.strictEqual(c('FBgn0283499', '7227'), 'FB:FBgn0283499');
	assert.strictEqual(c('ZDB-GENE-020503-4', '7955'), 'ZFIN:ZDB-GENE-020503-4');
	// Numeric NCBI ids (WormMine D. rerio 110292, FlyMine D. erecta 113563677) and other species.
	assert.strictEqual(c('110292', '7955'), null);
	assert.strictEqual(c('11998', '9606'), null);
	assert.strictEqual(c('113563677', '7220'), null);
	assert.strictEqual(c('AFLA_000690', '332952'), null);
	assert.strictEqual(c('L000003336', '4932'), null);
});

test('pickOrthologs skips paralogs of the focus species (FlyMine Egfr homologues)', () => {
	const rows = [
		['FBgn0000017', 'Abl', 'D. melanogaster', '7227'],
		['FBgn0003733', 'tor', 'D. melanogaster', '7227'],
		['HGNC:3236', 'EGFR', 'H. sapiens', '9606'],
		['MGI:95294', 'Egfr', 'M. musculus', '10090']
	];
	const r = tool.pickOrthologs(rows, 'FB:FBgn0003731', 8);
	assert.deepStrictEqual(r.picked.map((s) => s.curie), ['HGNC:3236', 'MGI:95294']);
	assert.strictEqual(r.total, 2);
});

test('ortholog query is limited to the Alliance taxa, the gene query is not', () => {
	const o = tool.buildQuery(['Gene.homologues.homologue.primaryIdentifier'], 5, 'Gene.homologues.homologue.organism.taxonId');
	assert.ok(o.includes('path="Gene.homologues.homologue.organism.taxonId" op="ONE OF"'));
	assert.ok(o.includes('<value>4932</value>') && o.includes('<value>559292</value>') && o.includes('<value>9606</value>'));
	assert.ok(!tool.buildQuery(['Gene.symbol'], 5).includes('ONE OF'));
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
	assert.deepStrictEqual([0, 1, 2, 3, 9, 10, 29, 30, 500].map(tool.level), [0, 1, 2, 2, 3, 4, 5, 5, 6]);
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

test('an Other cell with 300 terms is split into requests under 4000 characters and merged', async () => {
	const log = [];
	const terms = Array.from({ length: 300 }, (_, i) => 'GO:' + String(1000000 + i));
	const ribbon = JSON.parse(JSON.stringify(RIBBON));
	const other = tool.buildColumns(ribbon.categories).find((x) => x.key === 'GO:0005575-other');
	ribbon.subjects[0].groups[other.key].ALL.terms = terms;
	ribbon.subjects[0].groups[other.key].ALL.nb_annotations = 300;
	const slimmer = (url) => {
		const slims = new URL(url).searchParams.getAll('slim');
		const assocs = slims.map((t) => ({ id: 'a' + t, object: { id: t, label: 'term ' + t, category: ['cellular_component'] }, evidence_type: 'IDA', reference: ['PMID:1'] }));
		assocs.push({ id: 'shared', object: { id: 'GO:9', label: 'shared', category: ['cellular_component'] }, evidence_type: 'IDA', reference: [] });
		return json([{ assocs }]);
	};
	globalThis.fetch = fakeNet({ gene: TP53, ribbon, slimmer, log });
	const el = fakeEl();
	tool.main(el, { root: ROOT }, entity(8000038), {}, {});
	await tick();
	el.find('button').find((b) => b.getAttribute('aria-label').startsWith('TP53, other cellular component')).listeners.click();
	await tick();
	const reqs = log.filter((l) => l.url.includes('/bioentityset/slimmer/'));
	assert.strictEqual(reqs.length, 3);
	reqs.forEach((r) => assert.ok(r.url.length < 4000, 'url length ' + r.url.length));
	assert.strictEqual(tool.toDetails(await Promise.all(reqs.map((r) => slimmer(r.url).json())).then((a) => [].concat(...a)), 'cellular_component').length, 301);
	assert.ok(el.textContent.includes('term GO:1000299'));
	assert.deepStrictEqual(tool.chunk([1, 2, 3], 2), [[1, 2], [3]]);
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
	assert.ok(el.find('td').some((td) => td.children.includes(mf) && td.className === 'agr-heat-6'));
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
	assert.ok(el.textContent.includes('No GO annotations for this gene'));
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
		assert.ok(el.textContent.includes('No GO annotations for this gene'));
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
	assert.ok(el.textContent.includes('No GO annotations for this gene'));
	globalThis.fetch = fakeNet({ gene: ['ENSG1', 'X', 'H. sapiens', '9606'] });
	el = fakeEl();
	tool.main(el, { root: ROOT }, entity(1), {}, {});
	await tick();
	assert.ok(el.textContent.includes('No Alliance identifier for this gene'));
	el = fakeEl();
	tool.main(el, { root: ROOT }, entity([]), {}, {});
	assert.ok(el.textContent.includes('No GO annotations for this gene'));
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

// Gene sets: lists and results pages.
const setRows = (n) => Array.from({ length: n }, (_, i) => [`HGNC:${1000 + i}`, `G${i}`, 'H. sapiens', '9606', 5000 + i]);

// The ribbon API answers every requested subject with TP53's counts, except
// odd-numbered genes, which get the MGI gene's counts. The mine answers the
// rows whose Gene.id is in the query. unmapped lists curies the ribbon API
// rejects with a 404 naming the first of them; failWhen(curies) returns an
// HTTP status for a ribbon request or null; delay holds ribbon answers.
function setNet({ rows, log = [], ribbonStatus = 200, unmapped = [], failWhen = null, delay = 0 } = {}) {
	return async (url, init) => {
		log.push({ url: String(url), init });
		if (String(url).startsWith(ROOT + '/service/query/results')) {
			const query = new URLSearchParams(init.body).get('query');
			const wanted = new Set([...query.matchAll(/<value>([^<]*)<\/value>/g)].map((m) => m[1]));
			return json({ results: rows.filter((r) => wanted.has(String(r[4]))) });
		}
		if (String(url).includes('/bioentityset/slimmer/')) return json(SLIMMER);
		if (String(url).includes('/ontology/ribbon/')) {
			if (delay) await new Promise((r) => setTimeout(r, delay));
			const curies = new URL(url).searchParams.getAll('subject');
			const status = ribbonStatus !== 200 ? ribbonStatus : failWhen && failWhen(curies);
			if (status) return json({}, status);
			const bad = curies.find((c) => unmapped.includes(c));
			if (bad) return json({ detail: 'No UniProtKB IDs found for ' + bad }, 404);
			const subjects = curies.map((id) => {
				const src = Number(id.split(':')[1]) % 2 ? RIBBON.subjects[1] : RIBBON.subjects[0];
				return Object.assign({}, src, { id });
			});
			return json({ categories: RIBBON.categories, subjects });
		}
		throw new Error('unexpected ' + url);
	};
}

const ctx = (extra) => Object.assign({ mine: 'alliancemine', list: null, query: null, intent: '', page: 'list' }, extra);
const mineCalls = (log) => log.filter((l) => l.url.startsWith(ROOT + '/service/query/results'));
const ribbonCalls = (log) => log.filter((l) => l.url.includes('/ontology/ribbon/'));
const termButton = (el, label) => el.find('button').find((b) => b.getAttribute('aria-label') === label);

test('buildSetQuery lists every id in one ONE OF constraint', () => {
	const q = tool.buildSetQuery([1, 2, 3]);
	assert.ok(q.includes('op="ONE OF"'));
	assert.ok(q.includes('<value>1</value><value>2</value><value>3</value>'));
	assert.ok(q.includes('Gene.id'));
});

test('toSetGenes keeps curie genes once and carries the internal id', () => {
	const genes = tool.toSetGenes([...setRows(2), setRows(1)[0], ['12345', 'X', 'H. sapiens', '9606', 9]]);
	assert.deepStrictEqual(genes.map((g) => [g.curie, g.id]), [['HGNC:1000', 5000], ['HGNC:1001', 5001]]);
});

test('toCsv quotes commas, quotes and line breaks', () => {
	assert.strictEqual(tool.toCsv([['a', 'b,c', 'd"e']]), 'a,"b,c","d""e"\r\n');
});

test('toCsv prefixes text that a spreadsheet would run as a formula', () => {
	assert.strictEqual(
		tool.toCsv([['=SUM(A1)', '+1', '-x', '@s', 'ok', 5, -3]]),
		"'=SUM(A1),'+1,'-x,'@s,ok,5,-3\r\n"
	);
});

test('a list of 120 genes is fetched in 8 requests of at most 15 subjects', async () => {
	const log = [];
	globalThis.fetch = setNet({ rows: setRows(120), log });
	const el = fakeEl();
	tool.main(el, { root: ROOT }, entity(setRows(120).map((r) => r[4])), {}, {}, null, ctx());
	await tick();
	await tick();
	assert.strictEqual(mineCalls(log).length, 1);
	const calls = ribbonCalls(log);
	assert.deepStrictEqual(calls.map((c) => new URL(c.url).searchParams.getAll('subject').length), [15, 15, 15, 15, 15, 15, 15, 15]);
	assert.ok(calls.every((c) => c.url.includes('subset=goslim_agr')));
	assert.ok(el.textContent.includes('Download summary as CSV'));
});

test('slim term table counts genes per term', async () => {
	globalThis.fetch = setNet({ rows: setRows(4) });
	const el = fakeEl();
	tool.main(el, { root: ROOT }, entity([5000, 5001, 5002, 5003]), {}, {}, null, ctx());
	await tick();
	await tick();
	const text = el.textContent;
	assert.ok(text.includes('biological process'));
	assert.ok(text.includes('molecular function'));
	assert.ok(text.includes('cellular component'));
	assert.ok(termButton(el, 'all molecular function, 4 genes'));
	assert.ok(termButton(el, 'catalytic activity, 4 genes'));
	assert.ok(termButton(el, 'signaling receptor binding, 2 genes'), 'only the two even genes carry it');
});

test('progress line shows chunk progress while the ribbon loads', async () => {
	const seen = [];
	const net = setNet({ rows: setRows(90) });
	const el = fakeEl();
	globalThis.fetch = async (url, init) => {
		seen.push(el.textContent);
		return net(url, init);
	};
	tool.main(el, { root: ROOT }, entity(setRows(90).map((r) => r[4])), {}, {}, null, ctx());
	await tick();
	await tick();
	assert.ok(seen.some((t) => /Loading GO annotations: \d+ of 90 genes/.test(t) && !t.includes(': 0 of')));
});

test('clicking a term lists its genes with Alliance links', async () => {
	globalThis.fetch = setNet({ rows: setRows(4) });
	const el = fakeEl();
	tool.main(el, { root: ROOT }, entity([5000, 5001, 5002, 5003]), {}, {}, null, ctx());
	await tick();
	await tick();
	termButton(el, 'signaling receptor binding, 2 genes').listeners.click();
	const text = el.textContent;
	assert.ok(text.includes('signaling receptor binding: 2 genes'));
	const hrefs = el.find('a').map((a) => a.href);
	assert.ok(hrefs.includes('https://www.alliancegenome.org/gene/HGNC%3A1000'));
	assert.ok(hrefs.includes('https://www.alliancegenome.org/gene/HGNC%3A1002'));
	assert.ok(!hrefs.includes('https://www.alliancegenome.org/gene/HGNC%3A1001'));
});

test('CSV buttons download the summary and the term genes', async () => {
	globalThis.fetch = setNet({ rows: setRows(4) });
	const blobs = [];
	const clicks = [];
	const realCreate = URL.createObjectURL;
	URL.createObjectURL = (b) => { blobs.push(b); return 'blob:x'; };
	URL.revokeObjectURL = () => {};
	const Node = install();
	document.body = new Node('body');
	Node.prototype.click = function () { clicks.push(this.download); };
	try {
		const el = fakeEl();
		tool.main(el, { root: ROOT }, entity([5000, 5001, 5002, 5003]), {}, {}, null, ctx());
		await tick();
		await tick();
		el.find('button').find((b) => b.textContent === 'Download summary as CSV').listeners.click();
		termButton(el, 'signaling receptor binding, 2 genes').listeners.click();
		el.find('button').find((b) => b.textContent === 'Download genes as CSV').listeners.click();
		assert.deepStrictEqual(clicks, ['go-ribbon-summary.csv', 'go-ribbon-GO-0005102.csv']);
		assert.strictEqual(blobs[0].type, 'text/csv;charset=utf-8');
		assert.deepStrictEqual([...new Uint8Array(await blobs[0].arrayBuffer()).slice(0, 3)], [0xef, 0xbb, 0xbf]);
		const summary = Buffer.from(await blobs[0].arrayBuffer()).toString('utf8').slice(1);
		assert.ok(summary.startsWith('Aspect,GO ID,Term,Genes,Gene symbols,Alliance IDs\r\n'));
		assert.ok(summary.includes('molecular function,GO:0005102,signaling receptor binding,2,G0; G2,HGNC:1000; HGNC:1002'));
		const genes = Buffer.from(await blobs[1].arrayBuffer()).toString('utf8');
		assert.ok(genes.includes('G0,HGNC:1000,H. sapiens,1'));
	} finally {
		URL.createObjectURL = realCreate;
	}
});

test('the save button appears only when context.saveList exists and saves the term ids', async () => {
	globalThis.fetch = setNet({ rows: setRows(4) });
	const saved = [];
	const run = async (context) => {
		const el = fakeEl();
		tool.main(el, { root: ROOT }, entity([5000, 5001, 5002, 5003]), {}, {}, null, context);
		await tick();
		await tick();
		termButton(el, 'signaling receptor binding, 2 genes').listeners.click();
		return el;
	};
	const without = await run(ctx());
	assert.ok(!without.textContent.includes('Save genes in this term as a list'));
	const withSave = await run(ctx({ saveList: async (req) => { saved.push(req); return 'My list'; } }));
	const btn = withSave.find('button').find((b) => b.textContent === 'Save genes in this term as a list');
	btn.listeners.click();
	await tick();
	assert.deepStrictEqual(saved[0].ids, [5000, 5002]);
	assert.strictEqual(saved[0].class, 'Gene');
	assert.ok(withSave.textContent.includes('Saved list My list (2 genes)'));
});

test('an anonymous user gets a login message when saving', async () => {
	globalThis.fetch = setNet({ rows: setRows(2) });
	const el = fakeEl();
	const saveList = () => Promise.reject(new Error('login required'));
	tool.main(el, { root: ROOT }, entity([5000, 5001]), {}, {}, null, ctx({ saveList }));
	await tick();
	await tick();
	termButton(el, 'all molecular function, 2 genes').listeners.click();
	el.find('button').find((b) => b.textContent === 'Save genes in this term as a list').listeners.click();
	await tick();
	assert.ok(el.textContent.includes('Log in to save a list'));
});

test('a set ribbon failure logs console.error and shows a short message', async () => {
	globalThis.fetch = setNet({ rows: setRows(2), ribbonStatus: 500 });
	const errors = [];
	const realError = console.error;
	console.error = (...a) => errors.push(a);
	try {
		const el = fakeEl();
		tool.main(el, { root: ROOT }, entity([5000, 5001]), {}, {}, null, ctx());
		await tick();
		await tick();
		assert.ok(el.textContent.includes('Could not load the GO ribbon from the API'));
		assert.strictEqual(errors.length, 1);
	} finally {
		console.error = realError;
	}
});

test('a results page with one id still runs the set view, a report page does not', async () => {
	globalThis.fetch = setNet({ rows: setRows(1) });
	const el = fakeEl();
	tool.main(el, { root: ROOT }, entity([5000]), {}, {}, null, ctx({ page: 'results' }));
	await tick();
	await tick();
	assert.ok(el.textContent.includes('Download summary as CSV'));
	const report = fakeEl();
	globalThis.fetch = fakeNet({ gene: TP53 });
	tool.main(report, { root: ROOT }, entity(8000038), {}, {}, null, ctx({ page: 'report' }));
	await tick();
	assert.strictEqual(report.find('button').length, 59);
	assert.ok(!report.textContent.includes('Download summary'));
});

// Failure handling and live-data cases.
const settle = (ms) => new Promise((r) => setTimeout(r, ms));
const withErrors = async (fn) => {
	const orig = console.error;
	const errors = [];
	console.error = (...a) => errors.push(a);
	try { await fn(errors); } finally { console.error = orig; }
};
const BAD_XIST = fixture('ribbon-404-xist.json');
const XEN = fixture('ribbon-xenbase-pax6.json');

test('toAllianceCurie keeps Xenbase case and maps bare XB-GENE ids', () => {
	const c = tool.toAllianceCurie;
	assert.strictEqual(c(XEN.subject.id, 'X. tropicalis'), 'Xenbase:XB-GENE-484088');
	assert.strictEqual(c('XENBASE:XB-GENE-484088', '8364'), 'Xenbase:XB-GENE-484088');
	assert.strictEqual(c('XB-GENE-484088', '8364'), 'Xenbase:XB-GENE-484088');
	assert.strictEqual(c('XB-GENE-484088', 'H. sapiens'), null);
	assert.strictEqual(c('Xenbase:', 'X. tropicalis'), null);
});

test('a Xenopus gene is sent to the ribbon API with its Xenbase curie', async () => {
	const log = [];
	globalThis.fetch = fakeNet({ gene: ['Xenbase:XB-GENE-484088', 'pax6', 'X. tropicalis', '8364'], log, ribbon: json(null, 404) });
	const el = fakeEl();
	tool.main(el, { root: ROOT }, entity(9), {}, {});
	await tick();
	assert.ok(log.some((l) => l.url.includes('subject=Xenbase%3AXB-GENE-484088')));
});

test('unmappable genes are dropped from their chunk one by one and named, the other genes load', async () => {
	const log = [];
	const rows = setRows(20);
	globalThis.fetch = setNet({ rows, log, unmapped: ['HGNC:1003', 'HGNC:1004'] });
	const el = fakeEl();
	tool.main(el, { root: ROOT }, entity(rows.map((r) => r[4])), {}, {}, null, ctx());
	await settle(60);
	assert.ok(el.textContent.includes('2 genes have no GO data in the Alliance API: G3, G4'));
	assert.ok(termButton(el, 'all molecular function, 18 genes'));
	assert.ok(ribbonCalls(log).some((c) => !c.url.includes('HGNC%3A1003') && !c.url.includes('HGNC%3A1004') && c.url.includes('HGNC%3A1002')));
});

test('the recorded 404 detail for XIST drops that gene and keeps its neighbours', async () => {
	const rows = setRows(3);
	rows[1][0] = 'HGNC:12810';
	rows[1][1] = 'XIST';
	globalThis.fetch = async (url) => {
		if (String(url).includes('/query/results')) return json({ results: rows });
		const subjects = new URL(url).searchParams.getAll('subject');
		if (subjects.includes('HGNC:12810')) return json(BAD_XIST, 404);
		return json({ categories: RIBBON.categories, subjects: subjects.map((id) => Object.assign({}, RIBBON.subjects[0], { id })) });
	};
	const el = fakeEl();
	tool.main(el, { root: ROOT }, entity(rows.map((r) => r[4])), {}, {}, null, ctx());
	await settle(40);
	assert.ok(el.textContent.includes('1 gene has no GO data in the Alliance API: XIST'));
	assert.ok(termButton(el, 'all molecular function, 2 genes'));
});

test('a failed chunk keeps the loaded genes, reports the gap and retries only that chunk', async () => {
	await withErrors(async () => {
		const log = [];
		const rows = setRows(45);
		let broken = true;
		globalThis.fetch = setNet({ rows, log, failWhen: (c) => (broken && c.includes('HGNC:1015') ? 502 : null) });
		const el = fakeEl();
		tool.main(el, { root: ROOT }, entity(rows.map((r) => r[4])), {}, {}, null, ctx());
		await settle(80);
		assert.ok(el.textContent.includes('GO data missing for 15 of 45 genes (API error).'));
		assert.ok(termButton(el, 'all molecular function, 30 genes'));
		assert.ok(el.find('p').some((p) => p.getAttribute('role') === 'alert'));
		broken = false;
		const before = ribbonCalls(log).length;
		el.find('button').find((b) => b.textContent === 'Retry').listeners.click();
		await settle(40);
		assert.strictEqual(ribbonCalls(log).length, before + 1);
		assert.ok(ribbonCalls(log).pop().url.includes('HGNC%3A1015'));
		assert.ok(!el.textContent.includes('GO data missing'));
		assert.ok(termButton(el, 'all molecular function, 45 genes'));
	});
});

test('a 429 is retried with backoff and then succeeds', async () => {
	const log = [];
	let n = 0;
	globalThis.fetch = fakeNet({ gene: TP53, log, ribbon: () => (++n === 1 ? json({}, 429) : json(RIBBON)) });
	const el = fakeEl();
	tool.main(el, { root: ROOT }, entity(1), {}, {});
	await settle(40);
	assert.strictEqual(ribbonCalls(log).length, 2);
	assert.ok(el.find('button').length > 0);
});

test('a ribbon body that stalls past the timeout aborts and shows the error', async () => {
	await withErrors(async () => {
		const saved = Object.assign({}, tool.settings);
		tool.settings.ribbonTimeout = 20;
		tool.settings.retries = 0;
		try {
			const net = fakeNet({ gene: TP53 });
			globalThis.fetch = async (url, init) => {
				if (!String(url).includes('/ontology/ribbon/')) return net(url, init);
				return { ok: true, status: 200, json: () => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(new Error('aborted')))) };
			};
			const el = fakeEl();
			tool.main(el, { root: ROOT }, entity(1), {}, {});
			await settle(80);
			assert.ok(el.textContent.includes('Could not load the GO ribbon from the API'));
			assert.ok(el.find('p').some((p) => p.getAttribute('role') === 'alert'));
		} finally {
			Object.assign(tool.settings, saved);
		}
	});
});

test('no chunk is requested after the view is replaced', async () => {
	const log = [];
	const rows = setRows(120);
	globalThis.fetch = setNet({ rows, log, delay: 30 });
	const el = fakeEl();
	tool.main(el, { root: ROOT }, entity(rows.map((r) => r[4])), {}, {}, null, ctx());
	await tick();
	tool.main(el, { root: ROOT }, entity([5000]), {}, {}, null, ctx());
	await settle(250);
	const late = ribbonCalls(log).filter((c) => c.url.includes('HGNC%3A1119') || c.url.includes('HGNC%3A1100'));
	assert.strictEqual(late.length, 0);
	assert.strictEqual(ribbonCalls(log).length, 4 + 1);
});

test('genes without a curie do not use up the 300 cap', async () => {
	const log = [];
	const rows = setRows(400).map((r, i) => (i < 60 ? ['9' + i, 'X' + i, 'H. sapiens', '9606', r[4]] : r));
	globalThis.fetch = setNet({ rows, log });
	const el = fakeEl();
	tool.main(el, { root: ROOT }, entity(rows.map((r) => r[4])), {}, {}, null, ctx());
	await settle(150);
	const asked = ribbonCalls(log).reduce((n, c) => n + new URL(c.url).searchParams.getAll('subject').length, 0);
	assert.strictEqual(asked, 300);
	const text = el.textContent;
	assert.ok(text.includes('60 genes have no Alliance identifier and are left out.'));
	assert.ok(text.includes('This list has 340 genes with an Alliance identifier. The ribbon covers the first 300; 40 are left out.'));
});

test('a list over 500 genes is looked up in batches of 500', async () => {
	const log = [];
	const rows = setRows(1200);
	globalThis.fetch = setNet({ rows, log });
	const el = fakeEl();
	tool.main(el, { root: ROOT }, entity(rows.map((r) => r[4])), {}, {}, null, ctx());
	await settle(200);
	const sizes = mineCalls(log).map((l) => new URLSearchParams(l.init.body).get('query').split('<value>').length - 1);
	assert.deepStrictEqual(sizes, [500, 500, 200]);
});

test('a saved term list is named after its source list and says when only the first 300 were analysed', async () => {
	const rows = setRows(340);
	globalThis.fetch = setNet({ rows });
	const saved = [];
	const saveList = async (req) => { saved.push(req); return req.name; };
	const el = fakeEl();
	tool.main(el, { root: ROOT }, entity(rows.map((r) => r[4])), {}, {}, null, ctx({ saveList, list: { name: 'l1', title: 'My kinases', size: 340, type: 'Gene' } }));
	await settle(200);
	termButton(el, 'all molecular function, 300 genes').listeners.click();
	el.find('button').find((b) => b.textContent === 'Save genes in this term as a list').listeners.click();
	await tick();
	assert.strictEqual(saved[0].name, 'My kinases / all molecular function (GO slim, first 300 of 340)');
	assert.ok(el.textContent.includes('Only the first 300 of 340 genes in the source were analysed.'));

	const small = setRows(4);
	globalThis.fetch = setNet({ rows: small });
	const el2 = fakeEl();
	tool.main(el2, { root: ROOT }, entity(small.map((r) => r[4])), {}, {}, null, ctx({ saveList, page: 'results' }));
	await settle(60);
	termButton(el2, 'all molecular function, 4 genes').listeners.click();
	el2.find('button').find((b) => b.textContent === 'Save genes in this term as a list').listeners.click();
	await tick();
	assert.strictEqual(saved[1].name, 'Results / all molecular function (GO slim)');
});

test('the gene matrix view shows one row per gene and loads cell details', async () => {
	const log = [];
	const rows = setRows(3);
	globalThis.fetch = setNet({ rows, log });
	const el = fakeEl();
	tool.main(el, { root: ROOT }, entity(rows.map((r) => r[4])), {}, {}, null, ctx());
	await settle(60);
	el.find('button').find((b) => b.textContent === 'Show gene matrix').listeners.click();
	assert.ok(el.textContent.includes('G1 (H. sapiens)'));
	assert.strictEqual(el.find('tbody').pop().find('tr').length, 3);
	el.find('button').find((b) => (b.getAttribute('aria-label') || '').startsWith('G0, catalytic activity')).listeners.click();
	await tick();
	assert.ok(log.some((l) => l.url.includes('/bioentityset/slimmer/') && l.url.includes('subject=HGNC%3A1000')));
	assert.ok(el.textContent.includes('Evidence code'));
	assert.ok(el.find('button').some((b) => b.textContent === 'Show term list'));
});

test('the gene matrix leaves out genes the API could not map', async () => {
	const rows = setRows(3);
	globalThis.fetch = setNet({ rows, log: [], unmapped: ['HGNC:1001'] });
	const el = fakeEl();
	tool.main(el, { root: ROOT }, entity(rows.map((r) => r[4])), {}, {}, null, ctx());
	await settle(60);
	el.find('button').find((b) => b.textContent === 'Show gene matrix').listeners.click();
	assert.strictEqual(el.find('tbody').pop().find('tr').length, 2);
	assert.ok(!el.textContent.includes('G1 (H. sapiens)'));
});

test('geneMatrixCsv has one row per gene with data and a column per slim term', () => {
	const genes = [
		{ curie: RIBBON.subjects[0].id, symbol: 'TP53', species: 'H. sapiens' },
		{ curie: 'HGNC:0', symbol: 'GONE', species: 'H. sapiens' }
	];
	const lines = tool.geneMatrixCsv(RIBBON, genes).split('\r\n');
	assert.strictEqual(lines.length, 3);
	assert.strictEqual(lines[0].split(',').length, 3 + 59);
	assert.ok(lines[1].startsWith('HGNC:11998,TP53,H. sapiens,107'));
});

test('status, errors and tables carry accessibility roles and header scopes', async () => {
	const rows = setRows(2);
	globalThis.fetch = setNet({ rows });
	const el = fakeEl();
	tool.main(el, { root: ROOT }, entity(rows.map((r) => r[4])), {}, {}, null, ctx());
	assert.ok(el.find('p').some((p) => p.getAttribute('role') === 'status'));
	await settle(60);
	assert.ok(el.find('th').every((th) => th.getAttribute('scope')));
	assert.ok(el.find('caption').length >= 3);
	globalThis.fetch = fakeNet({ gene: TP53 });
	const single = fakeEl();
	tool.main(single, { root: ROOT }, entity(1), {}, {});
	await tick();
	assert.ok(single.find('th').every((th) => th.getAttribute('scope')));
});

test('an ortholog the API cannot map is left out of the grid and named', async () => {
	const orthologs = [['MGI:104537', 'Brca1', 'M. musculus', '10090'], ['RGD:2218', 'Tp53', 'R. norvegicus', '10116']];
	globalThis.fetch = fakeNet({
		gene: TP53,
		orthologs,
		ribbon: (url) => (String(url).includes('RGD%3A2218') ? json({ detail: 'No UniProtKB IDs found for RGD:2218' }, 404) : json(RIBBON))
	});
	const el = fakeEl();
	tool.main(el, { root: ROOT }, entity(8000038), {}, {});
	await tick();
	const box = el.find('input')[0];
	box.checked = true;
	box.listeners.change();
	await settle(40);
	const text = el.textContent;
	assert.ok(text.includes('No GO data in the Alliance API for: Tp53'));
	assert.ok(text.includes('Brca1 (M. musculus)'));
	assert.strictEqual(el.find('tr').length, 2 + 2);
});
