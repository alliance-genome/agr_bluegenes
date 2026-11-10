'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { install } = require('./dom-stub.js');
install();
const tool = require('../dist/bundle.js');

const tick = () => new Promise((r) => setTimeout(r, 10));

// Rows are [geneSymbol, geneId, geneSpecies, alleleId, alleleIdent, alleleSymbol, alleleSpecies, termId, termName, third, pmid, annId].
function row(kind) {
	return kind === 'disease'
		? ['G', 'FB:1', 'D. melanogaster', 5, 'FB:a5', 'a5', 'D. melanogaster', 'DOID:1', 'cancer', 'is_implicated_in', '123', 50]
		: ['G', 'FB:1', 'D. melanogaster', 5, 'FB:a5', 'a5', 'D. melanogaster', 'FBcv:1', 'lethal', 'lethal', '456', 60];
}

// rejected: list of regexes; a query matching one gets HTTP 400 (or the given status).
function stub(rejected) {
	globalThis.fetch = async (url, init) => {
		const q = decodeURIComponent(init.body.split('query=')[1]);
		const kind = q.includes('diseaseAnnotations') ? 'disease' : 'phenotype';
		const self = !q.includes('Gene.homologues.homologue.symbol');
		for (const r of rejected) {
			if (r.kind === kind && (r.self === undefined || r.self === self)) return { ok: false, status: r.status || 400 };
		}
		return { ok: true, json: async () => ({ results: self ? [row(kind)] : [] }) };
	};
}

async function run() {
	const el = document.createElement('div');
	tool.main(el, { root: 'http://h/mine' }, { Gene: { value: 1 } }, {}, {}, () => {});
	await tick();
	return el;
}

test('phenotype queries rejected with HTTP 400 hide the phenotype button and keep disease', async () => {
	stub([{ kind: 'phenotype' }]);
	const el = await run();
	assert.deepStrictEqual(el.find('button').map((b) => b.textContent), ['Disease (1)']);
	assert.ok(el.textContent.includes('This mine has no allele annotations for: this gene phenotype, orthologs phenotype.'));
	assert.ok(el.textContent.includes('cancer'));
});

test('one source rejected keeps both buttons and names the missing source', async () => {
	stub([{ kind: 'phenotype', self: false }]);
	const el = await run();
	assert.deepStrictEqual(el.find('button').map((b) => b.textContent), ['Disease (1)', 'Phenotype (1)']);
	assert.ok(el.textContent.includes('This mine has no allele annotations for: orthologs phenotype.'));
});

test('every query rejected shows the empty message with the note', async () => {
	stub([{ kind: 'phenotype' }, { kind: 'disease' }]);
	const el = await run();
	assert.ok(el.textContent.includes('No alleles with disease or phenotype annotations'));
	assert.ok(el.textContent.includes('This mine has no allele annotations for:'));
});

test('a query failing with HTTP 500 still fails the whole tool', async () => {
	stub([{ kind: 'phenotype', status: 500 }]);
	const orig = console.error;
	console.error = () => {};
	const el = await run();
	console.error = orig;
	assert.ok(el.textContent.includes('Could not load alleles from the mine'));
});
