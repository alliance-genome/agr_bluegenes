'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { install } = require('./dom-stub.js');
install();
const tool = require('../dist/bundle.js');

const fakeEl = () => document.createElement('div');
const tick = () => new Promise((r) => setTimeout(r, 5));
const ok = (results) => ({ ok: true, json: async () => ({ results }) });

// Model shaped like service.model.classes: AllianceMine has the prediction fields on Homologue, WormMine does not.
const homologueModel = (extra) => ({
	classes: {
		BioEntity: { attributes: { primaryIdentifier: {}, symbol: {}, id: {} } },
		Gene: {
			extends: ['BioEntity'],
			collections: { homologues: { referencedType: 'Homologue' } },
			references: { organism: { referencedType: 'Organism' } }
		},
		Organism: { attributes: { shortName: {} } },
		Homologue: { references: { homologue: { referencedType: 'Gene' } }, attributes: extra }
	}
});
const ALGO = { algorithmsMatch: {}, algorithmsAttempted: {}, isBestScore: {}, isBestReverseScore: {} };

test('hasPath follows references, collections and superclasses', () => {
	const svc = { model: homologueModel(ALGO) };
	assert.ok(tool.hasPath(svc, 'Gene.homologues.homologue.primaryIdentifier'));
	assert.ok(tool.hasPath(svc, 'Gene.homologues.homologue.organism.shortName'));
	assert.ok(!tool.hasPath(svc, 'Gene.homologues.stringencyFilter'));
	assert.ok(!tool.hasPath(svc, 'Gene.paralogues.rank'));
	assert.ok(tool.hasPath({}, 'Gene.anything'), 'no model passed: assume present');
});

test('viewFor keeps every column when the model has the prediction fields', () => {
	assert.strictEqual(tool.viewFor({ model: homologueModel(ALGO) }).length, 9);
});

test('viewFor drops prediction columns the model lacks (WormMine)', () => {
	const view = tool.viewFor({ model: homologueModel({}) });
	assert.strictEqual(view.length, 5);
	assert.ok(!view.some((p) => /algorithms|isBest/.test(p)));
	assert.ok(tool.buildQuery('1', view).includes('Gene.homologues.homologue.organism.shortName'));
	assert.ok(!tool.buildQuery('1', view).includes('algorithms'));
});

test('main on a model without prediction fields queries and renders three columns', async () => {
	let body;
	globalThis.fetch = async (url, i) => {
		body = decodeURIComponent(i.body);
		return ok([['WBGene1', 11, 'FBgn1', 'dx', 'D. melanogaster']]);
	};
	const el = fakeEl();
	tool.main(el, { root: 'http://h/mine', model: homologueModel({}) }, { Gene: { value: '42' } }, {}, {}, () => {});
	await tick();
	assert.ok(!body.includes('algorithmsMatch'));
	const heads = el.find('th').map((t) => t.textContent);
	assert.deepStrictEqual(heads, ['Species', 'Symbol', 'Identifier']);
});
