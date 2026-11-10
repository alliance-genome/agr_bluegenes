'use strict';
const test = require('node:test');
const assert = require('node:assert');

class FakeNode {
	constructor(tag) {
		this.tag = tag;
		this.children = [];
		this._text = '';
		this.className = '';
	}
	get firstChild() {
		return this.children[0] || null;
	}
	appendChild(c) {
		this.children.push(c);
		return c;
	}
	removeChild(c) {
		this.children.splice(this.children.indexOf(c), 1);
		return c;
	}
	set textContent(v) {
		this.children = [];
		this._text = String(v);
	}
	get textContent() {
		return this._text + this.children.map((c) => c.textContent).join('');
	}
	addEventListener() {}
}
global.document = { createElement: (tag) => new FakeNode(tag) };
const tool = require('../dist/bundle.js');
const tick = () => new Promise((r) => setTimeout(r, 5));

// Gene.diseaseAnnotation exists in all three models. FlyMine has the PhenotypeAnnotation class
// but no Gene.phenotypeAnnotations, so only the field decides.
const model = (withPhenotypes) => ({
	classes: {
		Gene: {
			attributes: { id: {} },
			collections: Object.assign(
				{ diseaseAnnotation: { referencedType: 'DiseaseAnnotation' } },
				withPhenotypes ? { phenotypeAnnotations: { referencedType: 'PhenotypeAnnotation' } } : {}
			)
		},
		DiseaseAnnotation: { attributes: { qualifier: {} } },
		PhenotypeAnnotation: { attributes: { id: {}, phenotypeStatement: {} }, collections: { publications: { referencedType: 'Publication' } } },
		Publication: { attributes: { pubMedId: {} } }
	}
});

test('hasPath: class present, collection absent', () => {
	const svc = { model: model(false) };
	assert.ok(svc.model.classes.PhenotypeAnnotation);
	assert.strictEqual(tool.hasPath(svc, 'Gene.phenotypeAnnotations.id'), false);
	assert.strictEqual(tool.hasPath({ model: model(true) }, 'Gene.phenotypeAnnotations.publications.pubMedId'), true);
});

test('without Gene.phenotypeAnnotations the phenotype query is not sent and the section says so', async () => {
	const bodies = [];
	global.fetch = (url, opts) => {
		bodies.push(opts.body);
		return Promise.resolve({ ok: true, json: () => Promise.resolve({ results: [] }) });
	};
	const el = new FakeNode('div');
	tool.main(el, { root: 'http://mine.test', model: model(false) }, { Gene: { value: 5 } });
	await tick();
	assert.strictEqual(bodies.length, 1);
	assert.ok(!/phenotypeAnnotations/.test(decodeURIComponent(bodies[0])));
	assert.match(el.textContent, /Phenotype annotations are not available in this mine/);
	assert.match(el.textContent, /Disease \(0\)/);
});

test('with Gene.phenotypeAnnotations both queries are sent', async () => {
	const bodies = [];
	global.fetch = (url, opts) => {
		bodies.push(opts.body);
		return Promise.resolve({ ok: true, json: () => Promise.resolve({ results: [] }) });
	};
	const el = new FakeNode('div');
	tool.main(el, { root: 'http://mine.test', model: model(true) }, { Gene: { value: 5 } });
	await tick();
	assert.strictEqual(bodies.length, 2);
});
