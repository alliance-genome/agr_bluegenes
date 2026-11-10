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

test('numeric ids are never mapped, they are NCBI ids in the MOD mines', () => {
	assert.strictEqual(toCurie('2018', 'R. norvegicus'), null);
	assert.strictEqual(toCurie('113563677', 'D. erecta'), null);
	assert.strictEqual(toCurie('110292', 'D. rerio'), null);
});

test('RGD curie of rat genes is kept', () => {
	assert.strictEqual(toCurie('RGD:3889', 'R. norvegicus'), 'RGD:3889');
});

test('bare ids map only for the species of the mine that owns them', () => {
	assert.strictEqual(toCurie('WBGene00006759', 'C. elegans'), 'WB:WBGene00006759');
	assert.strictEqual(toCurie('WBGene00006759', 'C. briggsae'), null);
	assert.strictEqual(toCurie('FBgn0003996', 'D. simulans'), null);
	assert.strictEqual(toCurie('S000001855', 'S. cerevisiae S288C'), 'SGD:S000001855');
	assert.strictEqual(toCurie('S000001855', 'C. albicans SC5314'), null);
	assert.strictEqual(toCurie('ZDB-GENE-990415-270', 'D. rerio'), 'ZFIN:ZDB-GENE-990415-270');
});

test('locus tags of other fungi and unknown prefixes give null', () => {
	assert.strictEqual(toCurie('CAGL0K12694g', 'N. glabratus CBS 138'), null);
	assert.strictEqual(toCurie('orf19.5007', 'C. albicans SC5314'), null);
	assert.strictEqual(toCurie('NCBIGene:7157', 'H. sapiens'), null);
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
