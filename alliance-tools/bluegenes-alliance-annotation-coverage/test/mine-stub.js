'use strict';
// Rows below are trimmed live responses from the AllianceMine query service (Trp53, daf-16, TP53).
const MOUSE = 44179488;
const WORM = 44357242;
const HUMAN = 44551229;
const INFO = [
	[MOUSE, 'MGI:98834', 'Trp53', 'M. musculus'],
	[WORM, 'WB:WBGene00000912', 'daf-16', 'C. elegans'],
	[HUMAN, 'HGNC:11998', 'TP53', 'H. sapiens']
];
const PRESENT = {
	goAnnotation: [MOUSE, WORM, HUMAN],
	diseaseAnnotation: [MOUSE, WORM, HUMAN],
	phenotypeAnnotations: [MOUSE, WORM, HUMAN],
	publications: [MOUSE, WORM, HUMAN],
	alleles: [MOUSE, WORM]
};
const model = require('./model-fixture.json');

function idsIn(q) {
	return (q.match(/<value>[^<]*<\/value>/g) || []).map((v) => Number(v.replace(/<\/?value>/g, '')));
}

function ok(results) {
	return { ok: true, status: 200, json: async () => ({ results }) };
}

// opts.info: gene rows; opts.present: {collection: ids}; opts.respond(req): a response or undefined for the default.
function install(opts = {}) {
	const info = opts.info || INFO;
	const present = opts.present || PRESENT;
	const requests = [];
	let inFlight = 0;
	const stats = { maxInFlight: 0 };
	globalThis.fetch = async (url, init) => {
		const q = decodeURIComponent(init.body.split('query=')[1]);
		const ids = idsIn(q);
		const collection = (q.match(/path="Gene\.(\w+)" op="IS NOT NULL"/) || [])[1];
		const req = { q, ids, collection, kind: collection ? 'presence' : 'info', start: Number(init.body.match(/start=(\d+)/)[1]), signal: init.signal };
		requests.push(req);
		inFlight += 1;
		stats.maxInFlight = Math.max(stats.maxInFlight, inFlight);
		try {
			if (opts.respond) {
				const r = await opts.respond(req, requests);
				if (r) return r;
			}
			if (req.kind === 'info') return ok(info.filter((r) => ids.includes(r[0])));
			const have = present[collection] || [];
			return ok(ids.filter((id) => have.includes(id)).map((id) => [id]));
		} finally {
			inFlight -= 1;
		}
	};
	return { requests, stats };
}

// n synthetic genes of one organism with ids from `from`, for page-size and organism-wide cases.
function genes(n, organism, from) {
	return Array.from({ length: n }, (_, i) => [from + i, organism + ':' + (from + i), 'g' + (from + i), organism]);
}

const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms));

async function run(tool, service, ids, context) {
	const el = document.createElement('div');
	tool.main(el, service, { Gene: { value: ids } }, {}, {}, () => {}, context);
	return el;
}

function geneTable(el) {
	return el.find('table').find((t) => /genes$/.test(t.className));
}

function geneRows(el) {
	return geneTable(el).find('tr').slice(1);
}

function button(el, pattern) {
	return el.find('button').find((b) => pattern.test(b.textContent) || pattern.test(b.getAttribute('title') || ''));
}

module.exports = { MOUSE, WORM, HUMAN, INFO, PRESENT, model, install, genes, ok, tick, run, geneTable, geneRows, button, idsIn };
