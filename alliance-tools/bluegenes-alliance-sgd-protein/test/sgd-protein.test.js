'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { install } = require('./dom-stub.js');
install();
const tool = require('../dist/bundle.js');

const fixture = (n) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', n), 'utf8'));
const PROTEIN = fixture('protein-S000001855.json');
const NEIGHBORS = fixture('neighbors-S000001855.json');

const tick = () => new Promise((r) => setTimeout(r, 15));
const fakeEl = () => document.createElement('div');
const entity = { Gene: { value: 1234 } };
const service = { root: 'http://h/mine' };
const SGD = 'S000001855';

const okJson = (body) => ({ ok: true, status: 200, json: () => Promise.resolve(body) });

// Stubbed fetch: records calls; the mine answers [id, organism], the proxy answers fixtures.
function stubFetch(geneRow, overrides = {}) {
	const calls = [];
	globalThis.fetch = (url, opts) => {
		calls.push({ url, opts });
		if (/\/query\/results$/.test(url)) return Promise.resolve(okJson({ results: geneRow ? [geneRow] : [] }));
		for (const [key, res] of Object.entries(overrides)) {
			if (url.endsWith(key)) return typeof res === 'function' ? res() : Promise.resolve(res);
		}
		if (url.endsWith('/protein_experiment_details')) return Promise.resolve(okJson(PROTEIN));
		if (url.endsWith('/neighbor_sequence_details')) return Promise.resolve(okJson(NEIGHBORS));
		return Promise.reject(new Error('unexpected ' + url));
	};
	return calls;
}

test('sgdIdOf accepts bare and prefixed SGDIDs of S. cerevisiae only', () => {
	const f = tool.sgdIdOf;
	assert.strictEqual(f('S000001855', 'S. cerevisiae'), SGD);
	assert.strictEqual(f('SGD:S000001855', 'S. cerevisiae'), SGD);
	assert.strictEqual(f('SGD:S000001855', '559292'), SGD);
	assert.strictEqual(f('S000001855', '4932'), SGD);
	assert.strictEqual(f('SGD:S000001855', 'Saccharomyces cerevisiae'), SGD);
	assert.strictEqual(f('SGD:S000001855', 'H. sapiens'), null);
	assert.strictEqual(f('S000001855', 'D. melanogaster'), null);
	assert.strictEqual(f('HGNC:11998', 'H. sapiens'), null);
	assert.strictEqual(f('YFL039C', 'S. cerevisiae'), null);
	assert.strictEqual(f('S00000185', 'S. cerevisiae'), null);
	assert.strictEqual(f('S000001855/../x', 'S. cerevisiae'), null);
	assert.strictEqual(f(null, 'S. cerevisiae'), null);
});

test('backendBaseOf: config, then serverVars deploy path, then /bluegenes', () => {
	const b = tool.backendBaseOf;
	assert.strictEqual(b({ backendBase: 'https://x.org/bg/' }, '{:bluegenes-deploy-path "/other"}'), 'https://x.org/bg');
	assert.strictEqual(b({}, '{:version "1" :bluegenes-deploy-path "/bluegenes" :a 1}'), '/bluegenes');
	assert.strictEqual(b({}, '{:bluegenes-deploy-path "/a/b/"}'), '/a/b');
	// Server vars present but without a deploy path: BlueGenes is served from the root.
	assert.strictEqual(b({}, '{:version "1"}'), '');
	// No server vars: the fork's default.
	assert.strictEqual(b({}, undefined), '/bluegenes');
	assert.strictEqual(b(undefined, 5), '/bluegenes');
});

test('backendBaseOf reads window.serverVars through the root object', () => {
	globalThis.serverVars = '{:bluegenes-deploy-path "/mybg"}';
	try {
		assert.strictEqual(tool.backendBaseOf({}), '/mybg');
	} finally {
		delete globalThis.serverVars;
	}
});

test('proxyUrl builds the backend path', () => {
	assert.strictEqual(tool.proxyUrl('/bluegenes', SGD, 'protein_experiment_details'),
		'/bluegenes/api/mod-proxy/sgd/locus/S000001855/protein_experiment_details');
});

test('toHalfLifeRows maps the recorded SGD response', () => {
	const rows = tool.toHalfLifeRows(PROTEIN);
	assert.deepStrictEqual(rows, [{
		experiment: 'half-life',
		value: '10.4',
		unit: 'hr',
		reference: 'Christiano R, et al. (2014)',
		referenceUrl: 'https://www.yeastgenome.org/reference/S000178561'
	}]);
	assert.deepStrictEqual(tool.toHalfLifeRows(null), []);
	assert.strictEqual(tool.toHalfLifeRows([{ reference: { display_name: 'x', link: 'javascript:alert(1)' } }])[0].referenceUrl, null);
});

test('toNeighbors reads S288C genes, sorted, with the current gene marked', () => {
	const nb = tool.toNeighbors(NEIGHBORS, SGD);
	assert.strictEqual(nb.chromosome, 'Chromosome VI');
	assert.deepStrictEqual(nb.genes.map((g) => g.name), ['FET5', 'YFL040W', 'ACT1', 'YPT1', 'TUB2', 'RUF21', 'RPO41']);
	const act1 = nb.genes.find((g) => g.current);
	assert.strictEqual(act1.name, 'ACT1');
	assert.strictEqual(act1.start, 53260);
	assert.strictEqual(act1.end, 54696);
	assert.strictEqual(act1.strand, '-');
	assert.strictEqual(nb.genes.filter((g) => g.current).length, 1);
	assert.strictEqual(tool.toNeighbors({}, SGD), null);
});

test('assignLanes keeps overlapping genes on separate lanes', () => {
	const lanes = tool.assignLanes([{ start: 0, end: 10 }, { start: 5, end: 20 }, { start: 30, end: 40 }], 0);
	assert.deepStrictEqual(lanes, [0, 1, 0]);
});

test('trackSvg builds SVG with createElementNS and highlights the current gene', () => {
	const svg = tool.trackSvg(tool.toNeighbors(NEIGHBORS, SGD).genes);
	assert.strictEqual(svg.tag, 'svg');
	assert.strictEqual(svg.ns, 'http://www.w3.org/2000/svg');
	assert.strictEqual(svg.find('rect').length, 7);
	const current = svg.find('g').filter((g) => g.getAttribute('class').includes('alliance-sgd-current'));
	assert.strictEqual(current.length, 1);
	assert.ok(current[0].textContent.includes('ACT1'));
	assert.strictEqual(current[0].find('rect')[0].getAttribute('fill'), '#d9534f');
});

test('main shows half-life rows, the track and the attribution for ACT1', async () => {
	const calls = stubFetch(['SGD:S000001855', 'S. cerevisiae']);
	const el = fakeEl();
	tool.main(el, service, entity, {}, {}, () => {});
	await tick();
	const urls = calls.map((c) => c.url);
	assert.deepStrictEqual(urls.filter((u) => !/query\/results/.test(u)).sort(), [
		'/bluegenes/api/mod-proxy/sgd/locus/S000001855/neighbor_sequence_details',
		'/bluegenes/api/mod-proxy/sgd/locus/S000001855/protein_experiment_details'
	]);
	assert.ok(urls.every((u) => !/yeastgenome\.org\/backend/.test(u)), 'never calls SGD directly');
	const text = el.textContent;
	assert.ok(text.includes('half-life'));
	assert.ok(text.includes('10.4'));
	assert.ok(text.includes('hr'));
	assert.ok(text.includes('Christiano R, et al. (2014)'));
	assert.ok(text.includes('Data from SGD (yeastgenome.org)'));
	const link = el.find('a').find((a) => a.href === 'https://www.yeastgenome.org/reference/S000178561');
	assert.ok(link, 'reference link');
	assert.strictEqual(el.find('svg').length, 1);
	assert.strictEqual(el.find('rect').length, 7);
	assert.ok(text.includes('53260') && text.includes('54696'));
});

test('main uses config.backendBase when set', async () => {
	const calls = stubFetch(['S000001855', 'S. cerevisiae']);
	tool.main(fakeEl(), service, entity, {}, { backendBase: 'https://bg.example.org/app' }, () => {});
	await tick();
	assert.ok(calls.some((c) => c.url === 'https://bg.example.org/app/api/mod-proxy/sgd/locus/S000001855/protein_experiment_details'));
});

test('main sends no proxy request for other organisms', async () => {
	const calls = stubFetch(['HGNC:11998', 'H. sapiens']);
	const el = fakeEl();
	tool.main(el, service, entity, {}, {}, () => {});
	await tick();
	assert.strictEqual(calls.length, 1);
	assert.ok(/query\/results$/.test(calls[0].url));
	assert.ok(el.textContent.includes('SGD data is for budding yeast genes.'));
});

test('main sends no proxy request for a yeast gene without an SGDID', async () => {
	const calls = stubFetch(['YFL039C', 'S. cerevisiae']);
	const el = fakeEl();
	tool.main(el, service, entity, {}, {}, () => {});
	await tick();
	assert.strictEqual(calls.length, 1);
	assert.ok(el.textContent.includes('SGD data is for budding yeast genes.'));
});

test('main reports a failed section and still shows the other', async () => {
	stubFetch(['S000001855', 'S. cerevisiae'], { '/protein_experiment_details': { ok: false, status: 502, json: () => Promise.resolve({}) } });
	const el = fakeEl();
	const orig = console.error;
	console.error = () => {};
	try {
		tool.main(el, service, entity, {}, {}, () => {});
		await tick();
	} finally {
		console.error = orig;
	}
	assert.ok(el.textContent.includes('Could not load protein half-life from SGD'));
	assert.strictEqual(el.find('svg').length, 1);
});

test('main shows empty states', async () => {
	stubFetch(['S000001855', 'S. cerevisiae'], {
		'/protein_experiment_details': okJson([]),
		'/neighbor_sequence_details': okJson({})
	});
	const el = fakeEl();
	tool.main(el, service, entity, {}, {}, () => {});
	await tick();
	assert.ok(el.textContent.includes('No protein half-life data in SGD for this gene.'));
	assert.ok(el.textContent.includes('No neighbouring genes in SGD for this gene.'));
});

test('main ignores a response for an older entity', async () => {
	stubFetch(['S000001855', 'S. cerevisiae']);
	const el = fakeEl();
	tool.main(el, service, entity, {}, {}, () => {});
	tool.main(el, service, { Gene: { value: null } }, {}, {}, () => {});
	await tick();
	assert.ok(el.textContent.includes('No gene selected'));
	assert.strictEqual(el.find('svg').length, 0);
});

test('main throws without the full signature', () => {
	assert.throws(() => tool.main(null, service, entity), /correct signature/);
});
