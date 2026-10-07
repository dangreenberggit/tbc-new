// Per-ticket visual and accessibility capture for the React Upgrades tab
// (ticket 560 re-created it; the old tab's script was the visual-a11y-reviewer
// stage's). It turns a manifest of visual acceptance into PNG clips, facts.json,
// a11y.json and index.json, which a gate-visual seat judges against each
// entry's acceptance sentence. It measures; it judges nothing and blocks nothing.
//
// Usage: node ./test-review.mjs --manifest <path> --out <dir>
// (scripts/check_tab_review.py runs it with TBC_A11Y_BASELINE and
// TBC_TAB_FIXTURE_DIR set). Server: test-tab-harness.mjs `serveTab`.
//
// Manifest: { entries: [ {
//   ticket:       string, unique per entry (it names the PNG files);
//   state:        "pre-run" (the retribution page, no run) |
//                 "post-run" (a recorded fixture loaded, no sim);
//   fixture:      post-run only: a name in TBC_TAB_FIXTURE_DIR, or a .json path;
//   widths:       number[];
//   interactions: [ {click: sel} | {hover: sel} | {wait: ms} | {snapshot: label} ]
//                 in order. A click or hover acts on the first VISIBLE match
//                 (a hidden sub-tab pane holds copies of most elements),
//                 scrolled to the centre first. A hover moves the mouse away and
//                 then onto the target, two mouseMoved events, and waits for
//                 the popup (stage 558-p2 amendment A-K3-hover). `optional: true`
//                 on a click or hover skips it when no match is visible
//                 (the settings summary button exists only below xl). A snapshot
//                 reads every fact at that point into facts.steps.<label>;
//   pane:         boolean, default true: clip the tab first (its root's
//                 parent) and run axe on the tab root; false: clip only `capture` and run axe on capture[0];
//   capture:      selectors to clip, each its first visible match;
//   facts:        { key: "<op>:<sel>[:<name>]" };
//   acceptance:   string, for the judge;
// } ] }
// Every (entry, width) gets a fresh page, so one entry's clicks never leak into
// another's, and one width's into the next.
//
// Fact ops (rect, style, text, attr and prop read the first visible match, else the
// first match): rect:<sel>; style:<sel>:<prop>; text:<sel> (trimmed
// textContent); attr:<sel>:<name>; prop:<sel>:<name> (a DOM property, such as
// scrollWidth); exists:<sel>; count:<sel> (all matches);
// shown:<sel> (visible matches).

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import * as H from './test-tab-harness.mjs';

const HEIGHT = 900;
const ROOT = '[data-testid="upgrades-tab-root"]';
// The tab root is `display: contents` (its two columns are the pane's flex
// items), so it has no box to clip; its parent's box holds both columns.
const ROOT_CLIP = ':has(> [data-testid="upgrades-tab-root"])';
const VERDICT_TAG = 'TAB_REVIEW_VERDICT';
const PAGE_HELPERS = `
	const isShown = e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
	const firstShown = sel => [...document.querySelectorAll(sel)].find(isShown) ?? null;
	const pick = sel => firstShown(sel) ?? document.querySelector(sel);
`;

const parseArgs = argv => {
	const out = {};
	for (let i = 0; i < argv.length; i++) if (argv[i] === '--manifest' || argv[i] === '--out') out[argv[i].slice(2)] = argv[++i];
	return out;
};

function fixtureText(name) {
	if (name.endsWith('.json')) return fs.readFileSync(path.resolve(name), 'utf8');
	const dir = process.env.TBC_TAB_FIXTURE_DIR;
	if (!dir) throw new Error(`fixture "${name}" needs TBC_TAB_FIXTURE_DIR (run through pnpm tab-review) or a .json path`);
	return fs.readFileSync(path.join(dir, `${name}.json`), 'utf8');
}

function factExpression(spec) {
	const colon = spec.indexOf(':');
	const op = spec.slice(0, colon);
	const rest = spec.slice(colon + 1);
	const last = rest.lastIndexOf(':');
	const [sel, name] = ['style', 'attr', 'prop'].includes(op) ? [rest.slice(0, last), rest.slice(last + 1)] : [rest, null];
	const s = JSON.stringify(sel);
	const n = JSON.stringify(name);
	const read = {
		rect: `{ const el = pick(${s}); if (!el) return null; const r = el.getBoundingClientRect(); return { top: r.top, right: r.right, bottom: r.bottom, left: r.left, width: r.width, height: r.height }; }`,
		style: `{ const el = pick(${s}); return el ? getComputedStyle(el)[${n}] : null; }`,
		text: `{ const el = pick(${s}); return el ? (el.textContent || '').trim() : null; }`,
		attr: `{ const el = pick(${s}); return el ? el.getAttribute(${n}) : null; }`,
		prop: `{ const el = pick(${s}); return el ? el[${n}] ?? null : null; }`,
		exists: `{ return !!document.querySelector(${s}); }`,
		count: `{ return document.querySelectorAll(${s}).length; }`,
		shown: `{ return [...document.querySelectorAll(${s})].filter(isShown).length; }`,
	}[op];
	if (!read) throw new Error(`unknown fact op: ${op}`);
	return `(() => { ${PAGE_HELPERS} ${read} })()`;
}

async function readFacts(send, specs, errors) {
	const facts = {};
	for (const [key, spec] of Object.entries(specs ?? {})) {
		try {
			facts[key] = await H.evaluate(send, factExpression(spec));
		} catch (err) {
			errors.push(`fact ${key} (${spec}): ${err.message}`);
			facts[key] = null;
		}
	}
	return facts;
}

/** The centre of the first visible match, scrolled to the middle of the viewport, or null. */
const centreOf = (send, sel) =>
	H.evaluate(
		send,
		`(async () => { ${PAGE_HELPERS}
			const el = firstShown(${JSON.stringify(sel)});
			if (!el) return null;
			el.scrollIntoView({ block: 'center', inline: 'nearest' });
			await new Promise(r => setTimeout(r, 250));
			const r = el.getBoundingClientRect();
			return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
		})()`,
	);

async function interact(send, step, specs, steps, errors) {
	if (step.snapshot) {
		steps[step.snapshot] = await readFacts(send, specs, errors);
		return;
	}
	if (step.wait) {
		await H.sleep(step.wait);
		return;
	}
	const sel = step.click ?? step.hover;
	if (!sel) {
		errors.push(`unknown interaction: ${JSON.stringify(step)}`);
		return;
	}
	const at = await centreOf(send, sel);
	if (!at) {
		if (!step.optional) errors.push(`interaction target not found or not visible: ${sel}`);
		return;
	}
	if (step.hover) {
		await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 2, y: 2 });
		await H.sleep(150);
		await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x, y: at.y });
		await H.sleep(700);
		return;
	}
	await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: at.x, y: at.y, button: 'left', clickCount: 1 });
	await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: at.x, y: at.y, button: 'left', clickCount: 1 });
	await H.sleep(400);
}

const MAX_CLIP_HEIGHT = 16000;
// Room above a clip for upstream's sticky site nav, which would cover a target
// scrolled to the very top.
const CLIP_MARGIN = 200;

/**
 * Clip the first visible match of `sel` to a PNG. The page scrolls inside the
 * app's own scroller, not the window, so content past the viewport never
 * paints and a document-coordinate clip of it comes out blank (stage 558-p3
 * visual review K5, B2). So the viewport is made tall enough for the target
 * plus a margin, the target is centred below the sticky nav, and the clip is
 * taken in viewport coordinates; the height is restored afterwards. `inPlace`
 * clips where the target already is, for the first capture after a hover,
 * because a scroll moves the page under the pointer and closes the popup.
 */
async function clip(send, sel, file, width, inPlace) {
	const measure = centre => `(async () => { ${PAGE_HELPERS}
		const el = firstShown(${JSON.stringify(sel)});
		if (!el) return null;
		if (${centre}) { el.scrollIntoView({ block: 'center', inline: 'nearest' }); await new Promise(r => setTimeout(r, 200)); }
		const r = el.getBoundingClientRect();
		return { x: r.left, y: r.top, width: r.width, height: r.height };
	})()`;
	const size = await H.evaluate(send, measure(false));
	if (!size) return `capture selector missing or not visible: ${sel}`;
	const tall = !inPlace && size.height + 2 * CLIP_MARGIN > HEIGHT;
	if (tall) await setViewport(send, width, Math.min(MAX_CLIP_HEIGHT, Math.ceil(size.height) + 2 * CLIP_MARGIN));
	try {
		const rect = inPlace ? size : await H.evaluate(send, measure(true));
		await H.sleep(150);
		const { data } = await send('Page.captureScreenshot', { format: 'png', clip: { ...rect, scale: 1 }, captureBeyondViewport: false });
		fs.writeFileSync(file, Buffer.from(data, 'base64'));
		return null;
	} finally {
		if (tall) await setViewport(send, width, HEIGHT);
	}
}

const setViewport = async (send, width, height) => {
	await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
	await H.sleep(250);
};

async function openPage(send, base, entry, width) {
	await setViewport(send, width, HEIGHT);
	if (entry.state === 'post-run') {
		if (!entry.fixture) return 'a post-run entry needs a fixture (this script runs no sim)';
		const loaded = await H.loadFixturePage(send, base, fixtureText(entry.fixture));
		return loaded.error ? `fixture ${entry.fixture}: ${loaded.error}` : null;
	}
	if (entry.state !== 'pre-run') return `unknown state: ${entry.state}`;
	await send('Page.navigate', { url: `${base}${H.PAGE_PATH}` });
	await H.sleep(300);
	const opened = await H.evaluate(send, H.activateTabExpression());
	return opened?.ok ? null : (opened?.error ?? 'tab did not open');
}

/** One (entry, width) on a page of its own, closed afterwards so pages do not pile up in the browser. */
async function captureEntry(client, base, outDir, entry, width, baseline, matched) {
	const { send, targetId } = await H.attachPage(client);
	try {
		return await captureOnPage(send, base, outDir, entry, width, baseline, matched);
	} finally {
		await client.send('Target.closeTarget', { targetId });
	}
}

async function captureOnPage(send, base, outDir, entry, width, baseline, matched) {
	const record = { files: [], errors: [], facts: null, a11y: null };
	const opened = await openPage(send, base, entry, width);
	if (opened) {
		record.errors.push(opened);
		return record;
	}
	const steps = {};
	for (const step of entry.interactions ?? []) await interact(send, step, entry.facts, steps, record.errors);
	const hovered = (entry.interactions ?? []).some(step => step.hover);
	// The pointer stays where the last click left it, and a tooltip it opened would cover the clips.
	if (!hovered) await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 2, y: 2 });

	const pane = entry.pane !== false;
	const selectors = pane ? [ROOT_CLIP, ...(entry.capture ?? [])] : [...(entry.capture ?? [])];
	const hoverFirst = !pane && hovered;
	const shoot = async n => {
		const file = `${entry.ticket}-${entry.state}-${width}-${n}.png`;
		const err = await clip(send, selectors[n], path.join(outDir, file), width, hoverFirst && n === 0);
		if (err) record.errors.push(err);
		else record.files.push(file);
	};
	const audit = async () => {
		record.facts = { ...(await readFacts(send, entry.facts, record.errors)), ...(Object.keys(steps).length ? { steps } : {}) };
		try {
			const { violations } = await H.axeRun(send, pane ? ROOT : selectors[0]);
			const cls = H.a11yClassify(violations, baseline);
			for (const i of cls.matched) matched.add(i);
			record.a11y = { fail: cls.fail, warn: cls.warn };
		} catch (err) {
			record.errors.push(`axe at ${width}: ${err.message}`);
		}
	};
	// After a hover, the in-place clip, the facts and axe come before any scroll closes the popup.
	if (hoverFirst && selectors.length) await shoot(0);
	if (hoverFirst) await audit();
	for (let n = hoverFirst ? 1 : 0; n < selectors.length; n++) await shoot(n);
	if (!hoverFirst) await audit();
	return record;
}

const git = (...args) => {
	const res = spawnSync('git', ['-C', H.__dirname, ...args], { encoding: 'utf8' });
	return res.status === 0 ? res.stdout.trim() : null;
};

async function main() {
	const args = parseArgs(process.argv.slice(2));
	if (!args.manifest || !args.out) throw new Error('usage: node ./test-review.mjs --manifest <path> --out <dir>');
	const manifestPath = path.resolve(args.manifest);
	const outDir = path.resolve(args.out);
	const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
	if (!Array.isArray(manifest?.entries)) throw new Error('manifest has no entries array');
	fs.mkdirSync(outDir, { recursive: true });
	console.log(`tab-review: ${manifest.entries.length} entries -> ${outDir}`);

	const baseline = H.readA11yBaseline();
	const matched = new Set();
	const index = [];
	const factsOut = {};
	const a11yOut = {};
	const { base, stop } = await H.serveTab();
	const chrome = await H.launchChrome();
	const client = H.cdp(chrome.wsUrl, { callTimeoutMs: 120000 });
	try {
		await client.ready;
		for (const entry of manifest.entries) {
			// An entry with no widths would capture nothing and count no error: a
			// green run with no evidence for that ticket (ticket 451).
			if (!entry.widths?.length) index.push({ ticket: entry.ticket, state: entry.state, width: null, files: [], errors: ['entry has no widths'] });
			for (const width of entry.widths ?? []) {
				const r = await captureEntry(client, base, outDir, entry, width, baseline, matched);
				console.log(`tab-review: ${entry.ticket} ${entry.state} @${width}: ${r.files.length} clips, ${r.errors.length} errors`);
				for (const e of r.errors) console.log(`  error: ${e}`);
				index.push({ ticket: entry.ticket, state: entry.state, width, files: r.files, errors: r.errors });
				if (r.facts) (factsOut[entry.ticket] ??= {})[width] = r.facts;
				if (r.a11y) a11yOut[`${entry.ticket}/${width}`] = r.a11y;
			}
		}
	} finally {
		client.close();
		chrome.kill();
		stop();
	}

	const staleBaseline = baseline.filter((e, i) => !matched.has(i) && e.mayNotFire !== true).map(e => `${e.ruleId} ${e.selector}`);
	const errors = index.reduce((n, e) => n + e.errors.length, 0);
	const a11yFailed = Object.values(a11yOut).reduce((n, a) => n + a.fail.length, 0);
	const forkHead = git('rev-parse', 'HEAD');
	const forkDirty = git('status', '--porcelain');
	const write = (name, value) => fs.writeFileSync(path.join(outDir, name), JSON.stringify(value, null, 2) + '\n');
	write('index.json', {
		forkHead,
		forkDirty: forkDirty === null ? null : forkDirty.length > 0,
		generatedAt: new Date().toISOString(),
		manifest: manifestPath,
		staleBaseline,
		entries: index,
	});
	write('facts.json', factsOut);
	write('a11y.json', a11yOut);
	console.log(`${VERDICT_TAG} ${JSON.stringify({ outcome: 'captured', entries: index.length, errors, a11yFailed, staleBaseline, out: outDir })}`);
	return errors === 0 ? 0 : 1;
}

main().then(
	code => process.exit(code),
	err => {
		console.error(`test-review: ${err?.stack ?? err}`);
		console.log(`${VERDICT_TAG} ${JSON.stringify({ outcome: 'unmeasured', entries: 0, errors: 1, reason: String(err?.message ?? err) })}`);
		process.exit(2);
	},
);
