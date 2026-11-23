'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { mineFetch, errorText } = require('../dist/bundle.js');

const res = (status, body) => ({
	ok: status >= 200 && status < 300,
	status,
	headers: { get: () => null },
	json: async () => body
});

test('mineFetch retries HTTP 429 and returns the later response', async () => {
	let calls = 0;
	globalThis.fetch = async () => (++calls < 3 ? res(429) : res(200, { results: [1] }));
	const r = await mineFetch('http://h/s', {}, { delays: [1, 1] });
	assert.strictEqual(calls, 3);
	assert.deepStrictEqual(await r.json(), { results: [1] });
});

test('mineFetch retries HTTP 503 and stops after two retries', async () => {
	let calls = 0;
	globalThis.fetch = async () => (calls++, res(503));
	const r = await mineFetch('http://h/s', {}, { delays: [1, 1] });
	assert.strictEqual(calls, 3);
	assert.strictEqual(r.status, 503);
});

test('mineFetch does not retry other failures', async () => {
	let calls = 0;
	globalThis.fetch = async () => (calls++, res(500));
	const r = await mineFetch('http://h/s', {}, { delays: [1, 1] });
	assert.strictEqual(calls, 1);
	assert.strictEqual(r.status, 500);
});

test('mineFetch aborts a stalled request and the error says so', async () => {
	globalThis.fetch = (url, init) =>
		new Promise((resolve, reject) => {
			init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
		});
	await assert.rejects(mineFetch('http://h/s', {}, { timeoutMs: 20 }), (err) => {
		assert.strictEqual(err.timeout, true);
		assert.match(errorText(err, 'Could not load things from the mine'), /Timed out after 0\.02 s/);
		return true;
	});
});

test('mineFetch aborts a body that never arrives', async () => {
	globalThis.fetch = (url, init) =>
		Promise.resolve({
			ok: true,
			status: 200,
			json: () =>
				new Promise((resolve, reject) => {
					init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
				})
		});
	const r = await mineFetch('http://h/s', {}, { timeoutMs: 20 });
	await assert.rejects(r.json(), (err) => err.timeout === true);
});

test('errorText names the HTTP status and the busy mine', () => {
	const base = 'Could not load things from the mine';
	assert.strictEqual(errorText({ status: 429 }, base), base + ': the mine is busy (HTTP 429), try again in a minute');
	assert.strictEqual(errorText({ status: 500 }, base), base + ' (HTTP 500)');
	assert.strictEqual(errorText(new Error('x'), base), base);
});

test('mine requests go through mineFetch', () => {
	const src = require('node:fs').readFileSync(require.resolve('../dist/bundle.js'), 'utf8');
	assert.doesNotMatch(src, /(^|[^.\w])(fetch|timedFetch)\((resultsUrl|sr\.replace|serviceRoot\.replace|mineRoot\.replace)/m);
	assert.doesNotMatch(src, /(^|[^.\w])fetch\(url\)/m);
});
