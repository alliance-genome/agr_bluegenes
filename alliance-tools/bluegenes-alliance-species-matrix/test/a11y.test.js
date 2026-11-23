'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

let Node;
try {
	Node = require('./dom-stub.js').install();
} catch (e) {
	Node = class {
		constructor(tag) { this.tag = tag; this.children = []; this._text = ''; this.className = ''; this.attrs = {}; }
		set textContent(v) { this._text = String(v); this.children = []; }
		get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); }
		get firstChild() { return this.children[0] || null; }
		appendChild(c) { this.children.push(c); return c; }
		removeChild(c) { this.children.splice(this.children.indexOf(c), 1); return c; }
		addEventListener() {}
		setAttribute(k, v) { this.attrs[k] = String(v); }
		find(tag, out = []) { if (this.tag === tag) out.push(this); this.children.forEach((c) => c.find && c.find(tag, out)); return out; }
	};
	globalThis.document = { createElement: (t) => new Node(t), createTextNode: (s) => { const n = new Node('#text'); n._text = s; return n; } };
}
const tool = require('../dist/bundle.js');
const config = require('../config.json');
const accepts = config.accepts;
const entity = { [config.classes[0]]: { value: accepts.includes('ids') && !accepts.includes('id') ? ['1', '2'] : '1' } };

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const live = (el) => el.find('p').concat(el.find('div')).filter((n) => n.attrs && n.attrs.role);

test('a failed request is announced as an alert', async () => {
	globalThis.fetch = async () => ({ ok: false, status: 500, headers: { get: () => null } });
	const el = document.createElement('div');
	const quiet = console.error;
	console.error = () => {};
	try {
		tool.main(el, { root: 'http://h/m' }, entity, {}, {}, () => {});
		await wait(80);
	} finally {
		console.error = quiet;
	}
	const alerts = live(el).filter((n) => n.attrs.role === 'alert');
	assert.ok(alerts.length >= 1, 'no element with role=alert');
	assert.match(alerts[0].textContent, /Could not/);
});

test('the loading message is a polite status', async () => {
	globalThis.fetch = () => new Promise((resolve) => setTimeout(() => resolve({ ok: false, status: 500 }), 60));
	const el = document.createElement('div');
	const quiet = console.error;
	console.error = () => {};
	try {
		tool.main(el, { root: 'http://h/m' }, entity, {}, {}, () => {});
		await wait(5);
		const status = live(el).filter((n) => n.attrs.role === 'status');
		assert.ok(status.length >= 1, 'no element with role=status');
		await wait(120);
	} finally {
		console.error = quiet;
	}
});

test('table header cells carry a scope', () => {
	const src = fs.readFileSync(require.resolve('../dist/bundle.js'), 'utf8').replace(/function (colHeader|rowHeader)[\s\S]*?\n\t\}/g, '');
	assert.ok(!/node\('th'/.test(src), 'a th is created without scope');
});

test('external links use rel="noopener noreferrer"', () => {
	const src = fs.readFileSync(require.resolve('../dist/bundle.js'), 'utf8');
	assert.ok(!/rel = 'noopener';/.test(src));
	assert.ok(!/setAttribute\('rel', 'noopener'\)/.test(src));
});
