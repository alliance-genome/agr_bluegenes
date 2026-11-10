'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { install } = require('./dom-stub.js');
install();
const tool = require('../dist/bundle.js');
const models = require('./fixtures/models.json');
const alleles = require('./fixtures/alleles.json');
const phenotypes = require('./fixtures/phenotypes.json');

const tick = () => new Promise((r) => setTimeout(r, 10));
const fakeEl = () => document.createElement('div');
const entity = (id) => ({ Gene: { class: 'Gene', format: 'id', value: id } });
const service = { root: 'http://h/mine' };
const click = (el, label) => el.find('button').find((b) => b.textContent.startsWith(label)).listeners.click();

test('toAllianceCurie maps bare ids from each MOD mine', () => {
	const c = tool.toAllianceCurie;
	assert.strictEqual(c('WBGene00006789', 'C. elegans'), 'WB:WBGene00006789');
	assert.strictEqual(c('FBgn0003731', 'D. melanogaster'), 'FB:FBgn0003731');
	assert.strictEqual(c('S000000001', 'S. cerevisiae'), 'SGD:S000000001');
	assert.strictEqual(c('MGI:104537', 'M. musculus'), 'MGI:104537');
	assert.strictEqual(c('104537', 'M. musculus'), 'MGI:104537');
	assert.strictEqual(c('ZDB-GENE-980526-166', 'D. rerio'), 'ZFIN:ZDB-GENE-980526-166');
	assert.strictEqual(c('2218', 'R. norvegicus'), 'RGD:2218');
	assert.strictEqual(c('11998', 'H. sapiens'), 'HGNC:11998');
});

test('toAllianceCurie keeps AllianceMine curies for all 7 species', () => {
	const c = tool.toAllianceCurie;
	assert.strictEqual(c('HGNC:11998', 'H. sapiens'), 'HGNC:11998');
	assert.strictEqual(c('MGI:104537', 'M. musculus'), 'MGI:104537');
	assert.strictEqual(c('RGD:2218', 'R. norvegicus'), 'RGD:2218');
	assert.strictEqual(c('ZFIN:ZDB-GENE-980526-166', 'D. rerio'), 'ZFIN:ZDB-GENE-980526-166');
	assert.strictEqual(c('FB:FBgn0003731', 'D. melanogaster'), 'FB:FBgn0003731');
	assert.strictEqual(c('WB:WBGene00006789', 'C. elegans'), 'WB:WBGene00006789');
	assert.strictEqual(c('SGD:S000000001', 'S. cerevisiae'), 'SGD:S000000001');
});

test('toAllianceCurie accepts taxon ids and rejects unknown input', () => {
	const c = tool.toAllianceCurie;
	assert.strictEqual(c('FBgn0003731', '7227'), 'FB:FBgn0003731');
	assert.strictEqual(c('FBgn0003731', 7227), 'FB:FBgn0003731');
	assert.strictEqual(c('S000000001', '4932'), 'SGD:S000000001');
	assert.strictEqual(c('S000000001', '559292'), 'SGD:S000000001');
	assert.strictEqual(c('FBgn0003731', 'C. elegans'), null);
	assert.strictEqual(c('7157', 'A. thaliana'), null);
	assert.strictEqual(c('', 'H. sapiens'), null);
	assert.strictEqual(c(null, 'H. sapiens'), null);
});

test('serviceRoot and apiBaseOf', () => {
	assert.strictEqual(tool.serviceRoot('http://h/mine/'), 'http://h/mine/service');
	assert.strictEqual(tool.serviceRoot('http://h/mine/service'), 'http://h/mine/service');
	assert.strictEqual(tool.apiBaseOf(undefined), 'https://www.alliancegenome.org/api');
	assert.strictEqual(tool.apiBaseOf({ apiBase: 'http://x/api/' }), 'http://x/api');
	assert.strictEqual(tool.apiBaseOf({ config: { apiBase: 'http://y/api' } }), 'http://y/api');
});

test('row mappers read the recorded API shapes', () => {
	const m = tool.toModelRow(models.results[0]);
	assert.strictEqual(m.id, 'FB:FBgo0499844');
	assert.strictEqual(m.disease, 'cancer');
	assert.strictEqual(m.association, 'IS_MODEL_OF');
	assert.strictEqual(m.provider, 'FB');
	assert.ok(!m.name.includes('<sup>'));
	const a = tool.toAlleleRow(alleles.results[0]);
	assert.strictEqual(a.symbol, 'Brca1em1Cya');
	assert.strictEqual(a.id, 'MGI:7792368');
	const v = tool.toAlleleRow(alleles.results[2]);
	assert.strictEqual(v.type, 'variant');
	assert.ok(v.symbol.startsWith('NC_'));
	const p = tool.toPhenotypeRow(phenotypes.results[0]);
	assert.strictEqual(p.phenotype, 'Abdominal obesity');
	assert.strictEqual(p.sources.length > 0, true);
});

// Fake mine and fake Alliance API in one fetch stub.
function stubFetch(log, opts) {
	opts = opts || {};
	globalThis.fetch = async (url, init) => {
		log.push({ url, init });
		if (url.startsWith('http://h/mine/service/query/results')) {
			const body = new URLSearchParams(init.body);
			if (body.get('format') === 'count') {
				if (opts.mineCountFails) return { ok: false, status: 400 };
				return { ok: true, status: 200, text: async () => String(opts.mineCount || 0) };
			}
			const row = opts.geneRow || ['FBgn0003731', 'Egfr', 'D. melanogaster', '7227'];
			return { ok: true, status: 200, json: async () => ({ results: opts.noGene ? [] : [row] }) };
		}
		if (opts.apiStatus) return { ok: false, status: opts.apiStatus };
		const body = url.includes('/models') ? models : url.includes('/alleles') ? alleles : phenotypes;
		return { ok: true, status: 200, json: async () => body };
	};
}

test('main loads the models tab only, then alleles on click (lazy)', async () => {
	const log = [];
	stubFetch(log);
	const el = fakeEl();
	tool.main(el, service, entity(8000144), {}, {}, () => {});
	await tick();
	const apiCalls = () => log.filter((l) => l.url.includes('alliancegenome.org')).map((l) => l.url);
	assert.deepStrictEqual(apiCalls(), ['https://www.alliancegenome.org/api/gene/FB%3AFBgn0003731/models?limit=50&page=1']);
	assert.ok(el.textContent.includes('Disease models (5)'));
	assert.ok(el.textContent.includes('1-3 of 5'));
	assert.ok(el.textContent.includes('Fetched 20'));
	assert.ok(el.textContent.includes('Data from the Alliance of Genome Resources API'));
	const link = el.find('a')[0];
	assert.strictEqual(link.href, 'https://www.alliancegenome.org/gene/FB%3AFBgn0003731');
	click(el, 'Alleles');
	await tick();
	assert.strictEqual(apiCalls().length, 2);
	assert.ok(apiCalls()[1].includes('/alleles?limit=50&page=1'));
	assert.ok(el.textContent.includes('Alleles (2160)'));
	assert.ok(el.textContent.includes('Brca1em1Cya'));
	click(el, 'Phenotypes');
	await tick();
	assert.ok(el.textContent.includes('Phenotypes (225)'));
	assert.ok(el.textContent.includes('Abdominal obesity'));
});

test('one POST to the mine reads the gene, with the id in the body', async () => {
	const log = [];
	stubFetch(log);
	tool.main(fakeEl(), service, entity(8000144), {}, { hideInAllianceMine: false }, () => {});
	await tick();
	const mine = log.filter((l) => l.url.startsWith('http://h/mine/'));
	assert.strictEqual(mine.length, 1);
	assert.strictEqual(mine[0].init.method, 'POST');
	assert.ok(decodeURIComponent(mine[0].init.body).includes('value="8000144"'));
});

test('apiBase from config is used for requests', async () => {
	const log = [];
	stubFetch(log);
	tool.main(fakeEl(), service, entity(1), {}, { apiBase: 'http://api.test/v1' }, () => {});
	await tick();
	assert.ok(log.some((l) => l.url.startsWith('http://api.test/v1/gene/FB%3AFBgn0003731/models')));
});

test('paging requests the next page of 50', async () => {
	const log = [];
	stubFetch(log);
	const el = fakeEl();
	tool.main(el, service, entity(1), {}, {}, () => {});
	await tick();
	click(el, 'Next');
	await tick();
	assert.ok(log.some((l) => l.url.endsWith('/models?limit=50&page=2')));
});

test('note shows when the mine has its own disease models, tool stays usable', async () => {
	const log = [];
	stubFetch(log, { mineCount: 4 });
	const el = fakeEl();
	tool.main(el, service, entity(1), {}, { hideInAllianceMine: true }, () => {});
	await tick();
	assert.ok(el.textContent.includes('This mine already has disease model data for this gene (4 rows)'));
	assert.ok(el.textContent.includes('Disease models (5)'));
});

test('no note when the mine count is 0, the query fails, or the option is false', async () => {
	for (const [opts, cfg] of [[{ mineCount: 0 }, {}], [{ mineCountFails: true }, {}], [{ mineCount: 9 }, { hideInAllianceMine: false }]]) {
		const log = [];
		stubFetch(log, opts);
		const el = fakeEl();
		tool.main(el, service, entity(1), {}, cfg, () => {});
		await tick();
		assert.ok(!el.textContent.includes('already has'));
		assert.ok(el.textContent.includes('Disease models (5)'));
	}
});

test('404 from the API shows no data', async () => {
	const log = [];
	stubFetch(log, { apiStatus: 404 });
	const el = fakeEl();
	tool.main(el, service, entity(1), {}, {}, () => {});
	await tick();
	assert.ok(el.textContent.includes('No disease models in the Alliance for this gene'));
	assert.ok(el.textContent.includes('Disease models (0)'));
});

test('API error logs and shows a short message', async () => {
	const log = [];
	stubFetch(log, { apiStatus: 500 });
	const errors = [];
	const orig = console.error;
	console.error = (...a) => errors.push(a);
	try {
		const el = fakeEl();
		tool.main(el, service, entity(1), {}, {}, () => {});
		await tick();
		assert.ok(el.textContent.includes('Could not load disease models from the Alliance API: HTTP 500'));
		assert.strictEqual(errors.length, 1);
	} finally {
		console.error = orig;
	}
});

test('unmappable gene shows a message and makes no API call', async () => {
	const log = [];
	stubFetch(log, { geneRow: ['X1', 'x', 'A. thaliana', '3702'] });
	const el = fakeEl();
	tool.main(el, service, entity(1), {}, {}, () => {});
	await tick();
	assert.ok(el.textContent.includes('Cannot map X1 (A. thaliana) to an Alliance gene id'));
	assert.strictEqual(log.filter((l) => l.url.includes('alliancegenome.org')).length, 0);
});

test('a stale response does not overwrite a newer entity', async () => {
	const log = [];
	const gates = [];
	globalThis.fetch = async (url, init) => {
		log.push(url);
		if (url.startsWith('http://h/mine/')) {
			const body = new URLSearchParams(init.body);
			if (body.get('format') === 'count') return { ok: true, status: 200, text: async () => '0' };
			const id = decodeURIComponent(body.get('query')).match(/value="(\d+)"/)[1];
			await new Promise((r) => gates.push(r));
			const row = id === '1' ? ['FBgn0000001', 'old', 'D. melanogaster', '7227'] : ['WBGene00000002', 'new', 'C. elegans', '6239'];
			return { ok: true, status: 200, json: async () => ({ results: [row] }) };
		}
		return { ok: true, status: 200, json: async () => models };
	};
	const el = fakeEl();
	tool.main(el, service, entity(1), {}, {}, () => {});
	tool.main(el, service, entity(2), {}, {}, () => {});
	await tick();
	gates[1]();
	await tick();
	gates[0]();
	await tick();
	assert.ok(el.textContent.includes('WB:WBGene00000002'));
	assert.ok(!el.textContent.includes('FB:FBgn0000001'));
	assert.ok(!log.some((u) => u.includes('FBgn0000001')));
});

test('main throws on a bad signature and handles an empty entity', () => {
	assert.throws(() => tool.main(null, service, entity(1)));
	const el = fakeEl();
	tool.main(el, service, { Gene: { value: [] } }, {}, {}, () => {});
	assert.ok(el.textContent.includes('No gene selected'));
});
