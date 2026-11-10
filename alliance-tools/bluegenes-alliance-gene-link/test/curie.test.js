'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { toCurie, geneUrl } = require('../dist/bundle.js');

test('identifier with colon is kept', () => {
	assert.strictEqual(toCurie('HGNC:11998', 'H. sapiens'), 'HGNC:11998');
	assert.strictEqual(toCurie('MGI:98834', 'M. musculus'), 'MGI:98834');
});

test('prefixes by identifier shape', () => {
	assert.strictEqual(toCurie('FBgn0003996', 'D. melanogaster'), 'FB:FBgn0003996');
	assert.strictEqual(toCurie('WBGene00006789', 'C. elegans'), 'WB:WBGene00006789');
	assert.strictEqual(toCurie('S000001855', 'S. cerevisiae'), 'SGD:S000001855');
	assert.strictEqual(toCurie('ZDB-GENE-990415-8', 'D. rerio'), 'ZFIN:ZDB-GENE-990415-8');
});

test('numeric id maps to RGD only for Rattus', () => {
	assert.strictEqual(toCurie('2018', 'R. norvegicus'), 'RGD:2018');
	assert.strictEqual(toCurie('2018', 'Rattus norvegicus'), 'RGD:2018');
	assert.strictEqual(toCurie('2018', 'H. sapiens'), null);
	assert.strictEqual(toCurie('2018', undefined), null);
});

test('unknown or empty input gives null', () => {
	assert.strictEqual(toCurie('PFI1105w', 'P. falciparum 3D7'), null);
	assert.strictEqual(toCurie('', 'R. norvegicus'), null);
	assert.strictEqual(toCurie(null, null), null);
	assert.strictEqual(toCurie(42, 'R. norvegicus'), null);
});

test('geneUrl keeps the colon readable', () => {
	assert.strictEqual(geneUrl('FB:FBgn0003996'), 'https://www.alliancegenome.org/gene/FB:FBgn0003996');
});
