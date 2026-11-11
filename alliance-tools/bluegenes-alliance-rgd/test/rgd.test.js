'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { install } = require('./dom-stub.js');
install();
const tool = require('../dist/bundle.js');

const fixture = (n) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', n), 'utf8'));
const GENE = fixture('gene-2218.json');
const ANN = fixture('annotations-2218.json');
const ORTH = fixture('orthologs-2218.json');

const ROOT = 'http://h/mine';
const BASE = 'https://rest.rgd.mcw.edu/rgdws';
const tick = () => new Promise((r) => setTimeout(r, 15));
const fakeEl = () => document.createElement('div');
const json = (body) => ({ ok: true, status: 200, json: async () => body });
const run = (el, value) => tool.main(el, { root: ROOT }, { Gene: { value } }, {}, {}, () => {});

function fakes(opts) {
	const log = { mine: [], rgd: [] };
	globalThis.fetch = async (url, init) => {
		if (url.startsWith(ROOT)) {
			log.mine.push(new URLSearchParams(init.body).get('query'));
			if (opts.mineFail) return { ok: false, status: 500 };
			return json({ results: [opts.gene || ['RGD:2218', 'R. norvegicus', 10116]] });
		}
		log.rgd.push(url);
		if (url.startsWith(BASE + '/genes/orthologs/')) return opts.orthologs ? opts.orthologs(url) : json(ORTH);
		if (url.startsWith(BASE + '/annotations/')) return opts.annotations ? opts.annotations(url) : json(ANN);
		return opts.geneRec ? opts.geneRec(url) : json(GENE);
	};
	return log;
}

test('serviceRoot appends /service once', () => {
	assert.strictEqual(tool.serviceRoot('http://h/mine/'), 'http://h/mine/service');
	assert.strictEqual(tool.serviceRoot('http://h/mine/service'), 'http://h/mine/service');
});

test('isRat accepts shortName or taxon 10116 only', () => {
	assert.ok(tool.isRat('R. norvegicus', undefined));
	assert.ok(tool.isRat(null, '10116'));
	assert.ok(tool.isRat('Rattus norvegicus', 9606));
	assert.ok(!tool.isRat('M. musculus', 10090));
	assert.ok(!tool.isRat(undefined, undefined));
});

test('rgdIdOf takes RGD:n and bare digits', () => {
	assert.strictEqual(tool.rgdIdOf('RGD:2218'), '2218');
	assert.strictEqual(tool.rgdIdOf('2218'), '2218');
	assert.strictEqual(tool.rgdIdOf('MGI:104537'), null);
	assert.strictEqual(tool.rgdIdOf('Brca1'), null);
	assert.strictEqual(tool.rgdIdOf(null), null);
});

test('URL builders and apiBaseOf', () => {
	assert.strictEqual(tool.apiBaseOf({}), BASE);
	assert.strictEqual(tool.apiBaseOf({ apiBase: 'http://x/ws/' }), 'http://x/ws');
	assert.strictEqual(tool.geneUrl(BASE, '2218'), BASE + '/genes/2218');
	assert.strictEqual(tool.orthologsUrl(BASE, '2218'), BASE + '/genes/orthologs/2218');
	assert.strictEqual(tool.annotationsUrl(BASE, '2218'), BASE + '/annotations/rgdId/2218');
	assert.strictEqual(tool.rgdGeneLink('2218'), 'https://rgd.mcw.edu/rgdweb/report/gene/main.html?id=2218');
});

test('hasPath reads service.model.classes', () => {
	const classes = {
		Gene: { references: { organism: { referencedType: 'Organism' } } },
		Organism: { attributes: { shortName: {} } }
	};
	assert.ok(tool.hasPath({ model: { classes } }, 'Gene.organism.shortName'));
	assert.ok(!tool.hasPath({ model: { classes } }, 'Gene.organism.taxonId'));
	assert.ok(tool.hasPath({}, 'Gene.organism.taxonId'));
});

test('groupAnnotations orders known aspects and keeps unknown codes as-is', () => {
	const g = tool.groupAnnotations([
		{ aspect: 'C', term: 'c' }, { aspect: 'D', term: 'd' }, { aspect: 'Z', term: 'z' }, { aspect: 'N', term: 'n' }, { aspect: 'D', term: 'd2' }
	]);
	assert.deepStrictEqual(g.map((x) => x.code), ['D', 'N', 'C', 'Z']);
	assert.deepStrictEqual(g.map((x) => x.label), ['Disease', 'Phenotype', 'GO cellular component', 'Z']);
	assert.strictEqual(g[0].rows.length, 2);
	assert.deepStrictEqual(tool.groupAnnotations(null), []);
});

test('fixture aspect codes map to words', () => {
	const g = tool.groupAnnotations(ANN);
	assert.deepStrictEqual(g.map((x) => x.code), ['D', 'E', 'W', 'P', 'F', 'C']);
	assert.strictEqual(tool.aspectLabel('E'), 'Chemical and drug interactions (CTD)');
	assert.strictEqual(tool.aspectLabel('W'), 'Pathway');
});

test('rat gene renders card, tabs with counts, reference link, orthologs and attribution', async () => {
	const log = fakes({});
	const el = fakeEl();
	run(el, '7');
	await tick();
	const text = el.textContent;
	assert.ok(text.includes('Brca1'));
	assert.ok(text.includes('BRCA1, DNA repair associated'));
	assert.ok(text.includes('VALIDATED'));
	assert.ok(text.includes('protein-coding'));
	assert.ok(text.includes('Disease (3)'));
	assert.ok(text.includes('Chemical and drug interactions (CTD) (3)'));
	assert.ok(text.includes('Orthologs (4)'));
	assert.ok(text.includes('Data from the Rat Genome Database (RGD) REST API'));
	const hrefs = el.find('a').map((a) => a.href);
	assert.ok(hrefs.includes('https://rgd.mcw.edu/rgdweb/report/gene/main.html?id=2218'));
	assert.ok(hrefs.some((h) => h.startsWith('https://rgd.mcw.edu/rgdweb/report/reference/main.html?id=')));
	assert.strictEqual(log.mine.length, 1);
	assert.strictEqual(log.rgd.length, 3);
	assert.ok(log.mine[0].includes('Gene.organism.shortName'));
});

test('a tab click switches aspect', async () => {
	fakes({});
	const el = fakeEl();
	run(el, '7');
	await tick();
	const tab = el.find('button').filter((b) => b.textContent.startsWith('Pathway'))[0];
	tab.listeners.click();
	assert.ok(el.textContent.includes('ataxia telangiectasia-mutated (ATM) signaling pathway'));
	assert.strictEqual(tab.getAttribute('aria-selected'), 'true');
});

test('long lists page 50 at a time', async () => {
	const many = [];
	for (let i = 0; i < 120; i++) many.push({ aspect: 'D', term: 'term' + i, evidence: 'ISO', dataSrc: 'CTD', refRgdId: 100 + i });
	fakes({ annotations: () => json(many) });
	const el = fakeEl();
	run(el, '7');
	await tick();
	assert.ok(el.textContent.includes('Showing 50 of 120'));
	assert.ok(el.textContent.includes('term49'));
	assert.ok(!el.textContent.includes('term50'));
	const more = el.find('button').filter((b) => b.textContent.startsWith('Show 50 more'))[0];
	more.listeners.click();
	assert.ok(el.textContent.includes('Showing 100 of 120'));
	const last = el.find('button').filter((b) => b.textContent.startsWith('Show 20 more'))[0];
	last.listeners.click();
	assert.ok(el.textContent.includes('Showing 120 of 120'));
	assert.strictEqual(el.find('button').filter((b) => /more$/.test(b.textContent)).length, 0);
});

test('bare numeric id works for a rat gene by taxon id', async () => {
	const log = fakes({ gene: ['2218', 'R. norvegicus', 10116] });
	const el = fakeEl();
	run(el, '7');
	await tick();
	assert.ok(log.rgd[0].endsWith('/genes/2218'));
});

test('non-rat gene shows the message and makes no RGD request', async () => {
	const log = fakes({ gene: ['MGI:104537', 'M. musculus', 10090] });
	const el = fakeEl();
	run(el, '7');
	await tick();
	assert.strictEqual(el.textContent, 'RGD data is for rat genes.');
	assert.strictEqual(log.rgd.length, 0);
});

test('rat gene without an RGD id makes no RGD request', async () => {
	const log = fakes({ gene: ['Brca1', 'R. norvegicus', 10116] });
	const el = fakeEl();
	run(el, '7');
	await tick();
	assert.strictEqual(el.textContent, 'RGD data is for rat genes.');
	assert.strictEqual(log.rgd.length, 0);
});

test('mine lookup failure shows a short message and logs', async () => {
	fakes({ mineFail: true });
	const orig = console.error;
	const logged = [];
	console.error = (...a) => logged.push(a);
	const el = fakeEl();
	run(el, '7');
	await tick();
	console.error = orig;
	assert.ok(el.textContent.includes('Could not load the gene from the mine'));
	assert.strictEqual(logged.length, 1);
});

test('annotation failure keeps the gene card and shows a message', async () => {
	fakes({ annotations: async () => ({ ok: false, status: 500 }) });
	const orig = console.error;
	console.error = () => {};
	const el = fakeEl();
	run(el, '7');
	await tick();
	console.error = orig;
	assert.ok(el.textContent.includes('Brca1'));
	assert.ok(el.textContent.includes('Could not load annotations from RGD'));
	assert.ok(el.textContent.includes('Orthologs (4)'));
});

test('a stale response does not overwrite the newer entity', async () => {
	let release;
	const gate = new Promise((r) => { release = r; });
	const log = fakes({ geneRec: async () => { await gate; return json(GENE); } });
	const el = fakeEl();
	run(el, '7');
	await tick();
	globalThis.fetch = async (url, init) => {
		if (url.startsWith(ROOT)) return json({ results: [['MGI:1', 'M. musculus', 10090]] });
		return json([]);
	};
	run(el, '8');
	await tick();
	release();
	await tick();
	assert.strictEqual(el.textContent, 'RGD data is for rat genes.');
	assert.ok(log.rgd.length >= 1);
});

test('requests carry an abort signal', async () => {
	let signal;
	fakes({ geneRec: async (url) => json(GENE) });
	const inner = globalThis.fetch;
	globalThis.fetch = async (url, init) => { if (!url.startsWith(ROOT)) signal = init.signal; return inner(url, init); };
	const el = fakeEl();
	run(el, '7');
	await tick();
	assert.ok(signal && typeof signal.aborted === 'boolean');
});

test('speciesName maps keys 1 to 3 and labels the rest generically', () => {
	assert.strictEqual(tool.speciesName(1), 'Human');
	assert.strictEqual(tool.speciesName(2), 'Mouse');
	assert.strictEqual(tool.speciesName(3), 'Rat');
	assert.strictEqual(tool.speciesName(13), 'Other species (RGD key 13)');
});

test('orthologs of other species render the generic label', async () => {
	fakes({});
	const el = fakeEl();
	run(el, '7');
	await tick();
	assert.ok(el.textContent.includes('Other species (RGD key'));
	assert.ok(!el.textContent.includes('species key'));
});

test('no gene selected and bad signature', () => {
	const el = fakeEl();
	tool.main(el, { root: ROOT }, { Gene: { value: '' } }, {}, {}, () => {});
	assert.strictEqual(el.textContent, 'No gene selected');
	assert.throws(() => tool.main(null, {}, {}), /correct signature/);
});
