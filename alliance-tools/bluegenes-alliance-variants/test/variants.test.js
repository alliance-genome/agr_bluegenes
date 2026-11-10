'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { install } = require('./dom-stub.js');
install();
const tool = require('../dist/bundle.js');
const fx = (n) => require('./fixtures/' + n);

const MINE = 'http://h/mine';
const tick = () => new Promise((r) => setTimeout(r, 10));
const fakeEl = () => document.createElement('div');
const entity = (v) => ({ Gene: { value: v } });

// Stubbed fetch: the mine POST returns `gene` as one result row, Alliance GETs go to `alliance(url)`.
function stub(gene, alliance, log) {
	return async (url, init) => {
		log.push({ url: String(url), init });
		if (String(url).startsWith(MINE)) {
			if (gene instanceof Error) return { ok: false, status: 500 };
			return { ok: true, status: 200, json: async () => ({ results: gene ? [gene] : [] }) };
		}
		const v = await alliance(String(url));
		if (v === 404) return { ok: false, status: 404 };
		if (v instanceof Error) return { ok: false, status: 500 };
		return { ok: true, status: 200, json: async () => v };
	};
}

function texts(el, tag) {
	return el.find(tag).map((n) => n.textContent);
}

test('toAllianceCurie maps all 7 species', () => {
	const f = tool.toAllianceCurie;
	// curies pass through (AllianceMine)
	assert.strictEqual(f('HGNC:11998', 'H. sapiens'), 'HGNC:11998');
	assert.strictEqual(f('MGI:104537', 'M. musculus'), 'MGI:104537');
	assert.strictEqual(f('RGD:2218', 'R. norvegicus'), 'RGD:2218');
	assert.strictEqual(f('ZFIN:ZDB-GENE-990415-72', 'D. rerio'), 'ZFIN:ZDB-GENE-990415-72');
	assert.strictEqual(f('FB:FBgn0003731', 'D. melanogaster'), 'FB:FBgn0003731');
	assert.strictEqual(f('WB:WBGene00000898', 'C. elegans'), 'WB:WBGene00000898');
	assert.strictEqual(f('SGD:S000002428', 'S. cerevisiae'), 'SGD:S000002428');
	// bare ids from other mines, by short name or taxon id
	assert.strictEqual(f('ZDB-GENE-990415-72', '7955'), 'ZFIN:ZDB-GENE-990415-72');
	assert.strictEqual(f('FBgn0003731', 'D. melanogaster'), 'FB:FBgn0003731');
	assert.strictEqual(f('WBGene00000898', 6239), 'WB:WBGene00000898');
	assert.strictEqual(f('S000002428', 'Saccharomyces cerevisiae'), 'SGD:S000002428');
});

test('toAllianceCurie returns null for unknown species, empty ids and wrong shapes', () => {
	assert.strictEqual(tool.toAllianceCurie('FBgn0003731', 'H. sapiens'), null);
	assert.strictEqual(tool.toAllianceCurie('123', 'A. thaliana'), null);
	assert.strictEqual(tool.toAllianceCurie('', 'H. sapiens'), null);
	assert.strictEqual(tool.toAllianceCurie(null, 'H. sapiens'), null);
});

test('toAllianceCurie handles the identifiers production mines store', () => {
	const f = tool.toAllianceCurie;
	// WormMine, FlyMine, YeastMine as queried, taxon ids as strings (yeast is 4932 there).
	assert.strictEqual(f('WBGene00000001', '6239'), 'WB:WBGene00000001');
	assert.strictEqual(f('FBgn0000001', '7227'), 'FB:FBgn0000001');
	assert.strictEqual(f('S000000001', '4932'), 'SGD:S000000001');
	assert.strictEqual(f('S000000001', 'NCBITaxon:559292'), 'SGD:S000000001');
	// AllianceMine curies with a taxon id.
	assert.strictEqual(f('HGNC:11998', '9606'), 'HGNC:11998');
	assert.strictEqual(f('MGI:104537', '10090'), 'MGI:104537');
	// NCBI Gene ids and genes of other species.
	assert.strictEqual(f('110292', '7955'), null);
	assert.strictEqual(f('11998', '9606'), null);
	assert.strictEqual(f('113563677', '7220'), null);
	assert.strictEqual(f('FBgn0000001', '7220'), null);
	assert.strictEqual(f('L000003336', '4932'), null);
});

test('serviceRoot and apiBase', () => {
	assert.strictEqual(tool.serviceRoot('http://localhost:9999/alliancetestmine'), 'http://localhost:9999/alliancetestmine/service');
	assert.strictEqual(tool.serviceRoot('http://x/m/service/'), 'http://x/m/service');
	assert.strictEqual(tool.apiBase({}), 'https://www.alliancegenome.org/api');
	assert.strictEqual(tool.apiBase({ apiBase: 'http://a/api/' }), 'http://a/api');
});

test('variantsUrl adds limit, page and filters', () => {
	assert.strictEqual(tool.variantsUrl('http://a', 'MGI:1', 1), 'http://a/gene/MGI%3A1/alleles?limit=50&page=1');
	const u = tool.variantsUrl('http://a', 'MGI:1', 3, { type: 'SNP', consequence: 'missense_variant' });
	assert.ok(u.endsWith('limit=50&page=3&filter.variantType=SNP&filter.molecularConsequence=missense_variant'));
});

test('toVariantRows reads a variant_summary row', () => {
	const rows = tool.toVariantRows(fx('mouse-brca1-page1.json').results[0]);
	assert.deepStrictEqual(rows, [{
		id: 'NC_000077.7:g.101382521A>T',
		type: 'SNP',
		consequence: 'intron_variant',
		protein: '',
		position: '11:101382521',
		allele: 'rs248245846'
	}]);
});

test('toVariantRows reads a named allele and joins a range position', () => {
	const rows = tool.toVariantRows(fx('mouse-brca1-allele-with-variant.json').results[0]);
	assert.strictEqual(rows[0].allele, 'Brca1tm5.1Cxd');
	assert.strictEqual(rows[0].type, 'MNV');
	assert.strictEqual(rows[0].position, '11:101414678-101414679');
	assert.strictEqual(rows[0].id, 'NC_000077.7:g.101414678_101414679delinsGC');
});

test('toVariantRows takes protein change when the API gives one and skips alleles without variants', () => {
	const r = {
		allele: { curie: 'a1' },
		variantList: [{
			variantType: { name: 'SNP' },
			curatedVariantGenomicLocations: [{
				start: 5, end: 5, hgvs: 'NC_1:g.5A>T',
				predictedVariantConsequences: [{ vepConsequences: [{ name: 'missense_variant' }], hgvsProteinNomenclature: 'p.Arg175His' }]
			}]
		}]
	};
	const rows = tool.toVariantRows(r);
	assert.strictEqual(rows[0].protein, 'p.Arg175His');
	assert.strictEqual(rows[0].consequence, 'missense_variant');
	assert.deepStrictEqual(tool.toVariantRows({ allele: { curie: 'a2' } }), []);
});

test('main renders rows, total, attribution link and asks the API once for page 1', async () => {
	const log = [];
	globalThis.fetch = stub(['8000268', 'MGI:104537', 'Brca1', 'M. musculus', '10090'], async () => fx('mouse-brca1-page1.json'), log);
	const el = fakeEl();
	tool.main(el, { root: MINE }, entity('8000268'), {}, { apiBase: 'http://alliance.test/api' }, () => {});
	await tick();
	await tick();
	const gets = log.filter((l) => !l.url.startsWith(MINE));
	assert.strictEqual(gets.length, 1);
	assert.strictEqual(gets[0].url, 'http://alliance.test/api/gene/MGI%3A104537/alleles?limit=50&page=1');
	assert.ok(log[0].url.startsWith(MINE + '/service/query/results'));
	assert.strictEqual(log[0].init.method, 'POST');
	assert.strictEqual(el.find('tr').length, 3);
	assert.ok(texts(el, 'p').includes('1-2 of 2160 records (alleles and variants), 2 variant rows on this page'));
	assert.ok(texts(el, 'p').some((t) => t.startsWith('Data from the Alliance of Genome Resources API')));
	assert.strictEqual(el.find('a')[0].getAttribute('href'), 'https://www.alliancegenome.org/gene/MGI:104537');
});

test('main uses a bare fly id from another mine to build the curie', async () => {
	const log = [];
	globalThis.fetch = stub(['9', 'FBgn0003731', 'Egfr', 'D. melanogaster', '7227'], async () => fx('empty.synthetic.json'), log);
	tool.main(fakeEl(), { root: MINE + '/service' }, entity(9), {}, {}, () => {});
	await tick();
	await tick();
	assert.ok(log.some((l) => l.url.startsWith('https://www.alliancegenome.org/api/gene/FB%3AFBgn0003731/alleles')));
});

test('main shows the empty state when the API has no variants', async () => {
	globalThis.fetch = stub(['1', 'HGNC:1', 'X', 'H. sapiens', '9606'], async () => fx('empty.synthetic.json'), []);
	const el = fakeEl();
	tool.main(el, { root: MINE }, entity('1'), {}, {}, () => {});
	await tick();
	await tick();
	assert.ok(texts(el, 'span').includes('No variants in the Alliance for this gene'));
	assert.strictEqual(el.find('table').length, 0);
});

test('main treats a 404 as no data', async () => {
	globalThis.fetch = stub(['1', 'HGNC:1', 'X', 'H. sapiens', '9606'], async () => 404, []);
	const el = fakeEl();
	tool.main(el, { root: MINE }, entity('1'), {}, {}, () => {});
	await tick();
	await tick();
	assert.ok(texts(el, 'span').includes('No variants in the Alliance for this gene'));
});

test('main logs and shows a short message when the API fails', async () => {
	globalThis.fetch = stub(['1', 'HGNC:1', 'X', 'H. sapiens', '9606'], async () => new Error('boom'), []);
	const errors = [];
	const orig = console.error;
	console.error = (...a) => errors.push(a);
	const el = fakeEl();
	tool.main(el, { root: MINE }, entity('1'), {}, {}, () => {});
	await tick();
	await tick();
	console.error = orig;
	assert.strictEqual(errors.length, 1);
	assert.ok(texts(el, 'span').includes('Could not load variants from the Alliance API'));
});

test('main logs and shows a message when the mine query fails', async () => {
	globalThis.fetch = stub(new Error('x'), async () => ({}), []);
	const errors = [];
	const orig = console.error;
	console.error = (...a) => errors.push(a);
	const el = fakeEl();
	tool.main(el, { root: MINE }, entity('1'), {}, {}, () => {});
	await tick();
	console.error = orig;
	assert.strictEqual(errors.length, 1);
	assert.ok(texts(el, 'span').includes('Could not load the gene from the mine'));
});

test('main says so when the species has no Alliance identifier', async () => {
	const log = [];
	globalThis.fetch = stub(['1', 'AT1G01010', 'NAC001', 'A. thaliana', '3702'], async () => ({}), log);
	const el = fakeEl();
	tool.main(el, { root: MINE }, entity('1'), {}, {}, () => {});
	await tick();
	await tick();
	assert.ok(texts(el, 'span').includes('No Alliance identifier for AT1G01010'));
	assert.strictEqual(log.filter((l) => !l.url.startsWith(MINE)).length, 0);
});

test('a filter change refetches page 1 with filter params; Next asks for page 2', async () => {
	const log = [];
	const gets = [];
	globalThis.fetch = stub(['8', 'MGI:104537', 'Brca1', 'M. musculus', '10090'], async (u) => {
		gets.push(u);
		return u.includes('filter.') ? fx('mouse-brca1-missense-snp.json') : { ...fx('mouse-brca1-page1.json'), returnedRecords: 2 };
	}, log);
	const el = fakeEl();
	tool.main(el, { root: MINE }, entity('8'), {}, {}, () => {});
	await tick();
	await tick();
	const selects = el.find('select');
	assert.strictEqual(selects.length, 2);
	assert.ok(selects[0].children.map((o) => o.textContent).includes('SNP'));
	assert.ok(selects[1].children.map((o) => o.textContent).includes('missense_variant'));
	// Next is enabled (2 of 2160 shown).
	const next = el.find('button').find((b) => b.textContent === 'Next');
	assert.strictEqual(next.getAttribute('disabled'), null);
	next.listeners.click();
	await tick();
	assert.ok(gets[1].includes('page=2'));
	// Filter: resets to page 1.
	el.find('select')[0].value = 'SNP';
	el.find('select')[0].listeners.change();
	await tick();
	assert.ok(gets[2].includes('page=1') && gets[2].includes('filter.variantType=SNP'));
	assert.ok(texts(el, 'p').includes('1-2 of 65 records (alleles and variants), 2 variant rows on this page'));
	// Options stay from the unfiltered load.
	assert.ok(el.find('select')[1].children.map((o) => o.textContent).includes('intron_variant'));
});

test('a filter with no matches says so and keeps the filters', async () => {
	let n = 0;
	globalThis.fetch = stub(['8', 'MGI:1', 'G', 'M. musculus', '10090'], async () => (n++ === 0 ? fx('mouse-brca1-page1.json') : fx('empty.synthetic.json')), []);
	const el = fakeEl();
	tool.main(el, { root: MINE }, entity('8'), {}, {}, () => {});
	await tick();
	await tick();
	el.find('select')[1].value = 'stop_gained';
	el.find('select')[1].listeners.change();
	await tick();
	assert.ok(texts(el, 'p').includes('No variants match the filters'));
	assert.strictEqual(el.find('select').length, 2);
});

test('a slow response for an older main call does not overwrite the newer one', async () => {
	const releases = [];
	globalThis.fetch = async (url) => {
		if (String(url).startsWith(MINE)) {
			return new Promise((resolve) => {
				releases.push(() => resolve({
					ok: true, status: 200,
					json: async () => ({ results: [['1', 'HGNC:' + (releases.length === 1 ? '111' : '222'), 'S', 'H. sapiens', '9606']] })
				}));
			});
		}
		return { ok: true, status: 200, json: async () => fx('empty.synthetic.json') };
	};
	const el = fakeEl();
	tool.main(el, { root: MINE }, entity('1'), {}, {}, () => {});
	tool.main(el, { root: MINE }, entity('1'), {}, {}, () => {});
	releases[1]();
	await tick();
	await tick();
	releases[0]();
	await tick();
	await tick();
	assert.strictEqual(el.find('a').length, 1);
	assert.ok(el.find('a')[0].getAttribute('href').endsWith('HGNC:222'));
});

test('a list shows a gene selector and switching genes loads that gene', async () => {
	const gets = [];
	globalThis.fetch = async (url) => {
		if (String(url).startsWith(MINE)) {
			return { ok: true, status: 200, json: async () => ({ results: [['1', 'HGNC:1', 'A', 'H. sapiens', '9606'], ['2', 'HGNC:2', 'B', 'H. sapiens', '9606']] }) };
		}
		gets.push(String(url));
		return { ok: true, status: 200, json: async () => fx('human-tp53-page1.json') };
	};
	const el = fakeEl();
	tool.main(el, { root: MINE }, entity(['1', '2']), {}, {}, () => {});
	await tick();
	await tick();
	const sel = el.find('select')[0];
	assert.strictEqual(sel.children.length, 2);
	sel.value = '1';
	sel.listeners.change();
	await tick();
	assert.ok(gets[0].includes('HGNC%3A1/') && gets[1].includes('HGNC%3A2/'));
});

test('main rejects a missing entity', () => {
	assert.throws(() => tool.main(fakeEl(), { root: MINE }, null), /signature/);
});

test('config accepts a single id and a list', () => {
    const cfg = require('../config.json');
    assert.deepStrictEqual(cfg.accepts, ['id', 'ids']);
});

test('a failed page request keeps the filters and pager and restores the page', async () => {
    const gets = [];
    let fail = false;
    globalThis.fetch = stub(['8', 'MGI:104537', 'Brca1', 'M. musculus', '10090'], async (u) => {
        gets.push(u);
        return fail ? new Error('boom') : fx('mouse-brca1-page1.json');
    }, []);
    const errors = [];
    const orig = console.error;
    console.error = (...a) => errors.push(a);
    const el = fakeEl();
    tool.main(el, { root: MINE }, entity('8'), {}, {}, () => {});
    await tick();
    await tick();
    fail = true;
    el.find('button').find((b) => b.textContent === 'Next').listeners.click();
    await tick();
    console.error = orig;
    assert.strictEqual(errors.length, 1);
    assert.ok(texts(el, 'p').includes('Could not load variants from the Alliance API'));
    assert.strictEqual(el.find('select').length, 2);
    assert.ok(texts(el, 'p').some((t) => t.startsWith('1-2 of 2160')));
    fail = false;
    el.find('button').find((b) => b.textContent === 'Next').listeners.click();
    await tick();
    assert.ok(gets[gets.length - 1].includes('page=2'));
});
