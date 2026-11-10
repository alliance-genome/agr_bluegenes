'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { install } = require('./dom-stub.js');
install();
const tool = require('../dist/bundle.js');

const fixture = (n) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', n), 'utf8'));
const MOL = fixture('molecular-HGNC-11998.json');
const GEN = fixture('genetic-MGI-104537.json');

const ROOT = 'http://h/mine';
const tick = () => new Promise((r) => setTimeout(r, 15));
const fakeEl = () => document.createElement('div');

test('toAllianceCurie maps the 7 Alliance species', () => {
	const c = tool.toAllianceCurie;
	assert.strictEqual(c('HGNC:11998', 'H. sapiens'), 'HGNC:11998');
	assert.strictEqual(c('11998', 'H. sapiens'), 'HGNC:11998');
	assert.strictEqual(c('MGI:104537', 'M. musculus'), 'MGI:104537');
	assert.strictEqual(c('104537', 10090), 'MGI:104537');
	assert.strictEqual(c('RGD:3889', 'R. norvegicus'), 'RGD:3889');
	assert.strictEqual(c('3889', 'R. norvegicus'), 'RGD:3889');
	assert.strictEqual(c('ZDB-GENE-990415-8', 'D. rerio'), 'ZFIN:ZDB-GENE-990415-8');
	assert.strictEqual(c('ZFIN:ZDB-GENE-990415-8', 'D. rerio'), 'ZFIN:ZDB-GENE-990415-8');
	assert.strictEqual(c('FBgn0003731', 'D. melanogaster'), 'FB:FBgn0003731');
	assert.strictEqual(c('FB:FBgn0003731', 7227), 'FB:FBgn0003731');
	assert.strictEqual(c('WBGene00004397', 'C. elegans'), 'WB:WBGene00004397');
	assert.strictEqual(c('WB:WBGene00004397', 6239), 'WB:WBGene00004397');
	assert.strictEqual(c('S000002691', 'S. cerevisiae'), 'SGD:S000002691');
	assert.strictEqual(c('SGD:S000002691', 559292), 'SGD:S000002691');
});

test('toAllianceCurie returns null for unmappable input', () => {
	assert.strictEqual(tool.toAllianceCurie('', 'H. sapiens'), null);
	assert.strictEqual(tool.toAllianceCurie(null, 'H. sapiens'), null);
	assert.strictEqual(tool.toAllianceCurie('12345', 'X. laevis'), null);
	assert.strictEqual(tool.toAllianceCurie('12345'), null);
});

test('apiBaseOf defaults and trims', () => {
	assert.strictEqual(tool.apiBaseOf({}), 'https://www.alliancegenome.org/api');
	assert.strictEqual(tool.apiBaseOf(undefined), 'https://www.alliancegenome.org/api');
	assert.strictEqual(tool.apiBaseOf({ apiBase: 'http://x/api/' }), 'http://x/api');
});

test('interactionsUrl keeps the colon and sets limit and page', () => {
	assert.strictEqual(
		tool.interactionsUrl('http://x/api', 'HGNC:11998', 'molecular', 2, 50),
		'http://x/api/gene/HGNC:11998/molecular-interactions?limit=50&page=2'
	);
});

test('toRow picks the end that is not the query gene', () => {
	const r = tool.toRow(MOL.results[0], 'HGNC:11998');
	assert.strictEqual(r.curie, 'HGNC:20');
	assert.strictEqual(r.symbol, 'AARS1');
	assert.strictEqual(r.species, 'Homo sapiens');
	assert.strictEqual(r.type, 'physical association');
	assert.strictEqual(r.method, 'affinity chromatography technology');
	assert.strictEqual(r.source, 'biogrid');
	assert.deepStrictEqual(r.pmids, ['32807901']);
	const rev = tool.toRow(MOL.results[0], 'HGNC:20');
	assert.strictEqual(rev.curie, 'HGNC:11998');
});

test('toRow reads genetic results, which have no detection method', () => {
	const r = tool.toRow(GEN.results[0], 'MGI:104537');
	assert.strictEqual(r.curie, 'MGI:1340806');
	assert.strictEqual(r.symbol, 'Parp1');
	assert.strictEqual(r.method, '');
	assert.strictEqual(r.type, 'synthetic lethality (sensu BioGRID)');
	assert.strictEqual(tool.toRow({}, 'X'), null);
});

// Fake mine plus fake Alliance API.
function fakes(opts) {
	const log = { api: [], mine: [] };
	globalThis.fetch = async (url, init) => {
		if (url.startsWith(ROOT)) {
			const query = new URLSearchParams(init.body).get('query');
			log.mine.push({ url, query });
			if (opts.mineFail && query.includes('ONE OF')) return { ok: false, status: 500 };
			if (query.includes('Gene.organism.taxonId')) {
				return { ok: true, json: async () => ({ results: [opts.gene || ['HGNC:11998', 'TP53', 'H. sapiens', 9606]] }) };
			}
			const rows = (opts.mineGenes || []).filter((g) => query.includes('<value>' + g[1] + '</value>') || query.includes('value="' + g[1] + '"'));
			return { ok: true, json: async () => ({ results: rows }) };
		}
		log.api.push(url);
		const kind = url.includes('/molecular-') ? 'molecular' : 'genetic';
		const handler = opts[kind];
		const res = await handler(url);
		return res;
	};
	return log;
}

const json = (body) => ({ ok: true, status: 200, json: async () => body });

// Builds n molecular results by repeating the fixture row with distinct partners.
function manyMolecular(n, offset) {
	const out = [];
	for (let i = 0; i < n; i++) {
		const r = JSON.parse(JSON.stringify(MOL.results[0]));
		const o = r.geneMolecularInteraction.geneGeneAssociationObject;
		o.primaryExternalId = 'HGNC:' + (1000 + offset + i);
		o.geneSymbol.displayText = 'G' + (offset + i);
		out.push(r);
	}
	return out;
}

test('main: first page 50, count for both tabs, Load more fetches page 2', async () => {
	const log = fakes({
		molecular: async (url) => {
			const page = Number(/page=(\d+)/.exec(url)[1]);
			return json({ total: 120, results: manyMolecular(50, (page - 1) * 50) });
		},
		genetic: async () => json({ total: 7, results: GEN.results.slice(0, 1) }),
		mineGenes: [[777, 'HGNC:1003']]
	});
	const el = fakeEl();
	const nav = [];
	tool.main(el, { root: ROOT }, { Gene: { value: 8000038 } }, {}, {}, (...a) => nav.push(a));
	await tick();

	assert.deepStrictEqual(log.api.sort(), [
		'https://www.alliancegenome.org/api/gene/HGNC:11998/genetic-interactions?limit=1&page=1',
		'https://www.alliancegenome.org/api/gene/HGNC:11998/molecular-interactions?limit=50&page=1'
	]);
	assert.deepStrictEqual(el.find('button').slice(0, 2).map((b) => b.textContent), ['Molecular (120)', 'Genetic (7)']);
	assert.strictEqual(el.find('tr').length, 51);
	assert.ok(el.textContent.includes('Showing 50 of 120'));
	assert.ok(el.textContent.includes('Data from the Alliance of Genome Resources API'));
	assert.ok(el.find('a').some((a) => a.href === 'https://www.alliancegenome.org/gene/HGNC:11998'));

	// Partner HGNC:1003 exists in the mine: it navigates. Others link to the Alliance.
	const links = el.find('a');
	const inMine = links.find((a) => a.textContent === 'G3');
	assert.strictEqual(inMine.href, '#');
	inMine.listeners.click({ preventDefault() {} });
	assert.deepStrictEqual(nav[0], ['report', { type: 'Gene', id: 777 }]);
	const outside = links.find((a) => a.textContent === 'G4');
	assert.strictEqual(outside.href, 'https://www.alliancegenome.org/gene/HGNC:1004');
	assert.ok(links.some((a) => a.href === 'https://pubmed.ncbi.nlm.nih.gov/32807901'));

	// One batched ONE OF lookup per page, holding the CURIE and bare id of each partner.
	const lookups = log.mine.filter((m) => m.query.includes('ONE OF'));
	assert.strictEqual(lookups.length, 1);
	assert.strictEqual((lookups[0].query.match(/<value>/g) || []).length, 100);

	const more = el.find('button').find((b) => b.textContent === 'Load more');
	more.listeners.click();
	await tick();
	assert.ok(log.api.some((u) => u.endsWith('molecular-interactions?limit=50&page=2')));
	assert.strictEqual(el.find('tr').length, 101);
	assert.ok(el.textContent.includes('Showing 100 of 120'));
	assert.ok(el.find('button').some((b) => b.textContent === 'Load more'));
});

test('main: Load more disappears when all rows are shown', async () => {
	fakes({
		molecular: async () => json({ total: 3, results: manyMolecular(3, 0) }),
		genetic: async () => json({ total: 0, results: [] })
	});
	const el = fakeEl();
	tool.main(el, { root: ROOT }, { Gene: { value: 1 } }, {}, {}, () => {});
	await tick();
	assert.ok(!el.find('button').some((b) => b.textContent === 'Load more'));
});

test('main: Genetic tab loads on click and omits the empty detection method column', async () => {
	const log = fakes({
		gene: ['MGI:104537', 'Brca1', 'M. musculus', 10090],
		molecular: async () => json({ total: 0, results: [] }),
		genetic: async (url) => json({ total: 2, results: GEN.results })
	});
	const el = fakeEl();
	tool.main(el, { root: ROOT }, { Gene: { value: 8000268 } }, {}, {}, () => {});
	await tick();
	assert.ok(el.textContent.includes('No molecular interactions in the Alliance'));
	assert.ok(log.api[0].includes('/gene/MGI:104537/'));
	el.find('button')[1].listeners.click();
	await tick();
	assert.ok(el.textContent.includes('Parp1'));
	assert.ok(!el.textContent.includes('Detection method'));
	assert.ok(el.textContent.includes('Genetic (2)'));
});

test('main: 404 means no data, no error', async () => {
	fakes({
		molecular: async () => ({ ok: false, status: 404 }),
		genetic: async () => ({ ok: false, status: 404 })
	});
	const el = fakeEl();
	tool.main(el, { root: ROOT }, { Gene: { value: 1 } }, {}, {}, () => {});
	await tick();
	assert.ok(el.textContent.includes('No molecular interactions in the Alliance'));
	assert.ok(el.textContent.includes('Molecular (0)'));
});

test('main: API failure logs and shows a short message', async () => {
	fakes({
		molecular: async () => ({ ok: false, status: 500 }),
		genetic: async () => ({ ok: false, status: 500 })
	});
	const errors = [];
	const orig = console.error;
	console.error = (...a) => errors.push(a);
	try {
		const el = fakeEl();
		tool.main(el, { root: ROOT }, { Gene: { value: 1 } }, {}, {}, () => {});
		await tick();
		assert.ok(el.textContent.includes('Could not load molecular interactions from the Alliance'));
		assert.ok(errors.length >= 1);
	} finally {
		console.error = orig;
	}
});

test('main: failed partner lookup falls back to Alliance links', async () => {
	fakes({
		mineFail: true,
		molecular: async () => json({ total: 1, results: manyMolecular(1, 0) }),
		genetic: async () => json({ total: 0, results: [] })
	});
	const orig = console.error;
	console.error = () => {};
	try {
		const el = fakeEl();
		tool.main(el, { root: ROOT }, { Gene: { value: 1 } }, {}, {}, () => {});
		await tick();
		assert.ok(el.find('a').some((a) => a.href === 'https://www.alliancegenome.org/gene/HGNC:1000'));
	} finally {
		console.error = orig;
	}
});

test('main: unmappable gene shows a message and makes no Alliance request', async () => {
	const log = fakes({ gene: ['12345', 'x', 'X. laevis', 8355], molecular: async () => json({}), genetic: async () => json({}) });
	const el = fakeEl();
	tool.main(el, { root: ROOT }, { Gene: { value: 1 } }, {}, {}, () => {});
	await tick();
	assert.strictEqual(log.api.length, 0);
	assert.ok(el.textContent.includes('No Alliance gene for 12345'));
});

test('main: a stale response does not overwrite a newer entity', async () => {
	let release;
	const gate = new Promise((r) => { release = r; });
	let calls = 0;
	fakes({
		molecular: async () => {
			calls += 1;
			if (calls === 1) {
				await gate;
				return json({ total: 1, results: manyMolecular(1, 500) });
			}
			return json({ total: 1, results: manyMolecular(1, 900) });
		},
		genetic: async () => json({ total: 0, results: [] })
	});
	const el = fakeEl();
	tool.main(el, { root: ROOT }, { Gene: { value: 1 } }, {}, {}, () => {});
	await tick();
	tool.main(el, { root: ROOT }, { Gene: { value: 2 } }, {}, {}, () => {});
	await tick();
	release();
	await tick();
	assert.ok(el.textContent.includes('G900'));
	assert.ok(!el.textContent.includes('G500'));
});

test('main: uses config.apiBase and the serviceRoot of the mine', async () => {
	const log = fakes({
		molecular: async () => json({ total: 0, results: [] }),
		genetic: async () => json({ total: 0, results: [] })
	});
	const el = fakeEl();
	tool.main(el, { root: ROOT }, { Gene: { value: 1 } }, {}, { apiBase: 'http://alt/api' }, () => {});
	await tick();
	assert.ok(log.api.every((u) => u.startsWith('http://alt/api/gene/')));
	assert.ok(log.mine.every((m) => m.url === ROOT + '/service/query/results'));
});

test('main rejects a missing signature', () => {
	assert.throws(() => tool.main(null, {}, {}), /signature/);
});
