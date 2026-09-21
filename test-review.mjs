// Per-ticket visual + accessibility capture for the Upgrades tab
// (visual-a11y-reviewer stage).
//
// Reuses test-tab-harness.mjs's build/serve/launch/attach/evaluate plumbing to
// turn a manifest of per-ticket visual acceptance into PNG clips, a facts.json,
// an a11y.json and an index.json. A gate-visual seat then judges each ticket's
// captures against its acceptance sentence. This script measures; it judges
// nothing and blocks nothing.
//
// Usage: node ./test-review.mjs --manifest <path> --out <dir>
//   (both required; relative paths resolve against process.cwd()).
//
// Manifest schema (proposal 1b):
//   { entries: [ {
//       ticket:       string,
//       state:        "pre-run" | "post-run",
//       widths:       number[],
//       interactions: [ { hover: sel } | { click: sel } ]  (optional),
//       pane:         boolean   (optional, default true). true = clip
//                     #upgrades-tab first and run axe on it. false = clip only
//                     the `capture` selectors and run axe on capture[0]; this
//                     is how an entry photographs something outside the
//                     Upgrades pane (the Gear item list, ticket 472) without
//                     the zero-size #upgrades-tab clip that would fail the run.
//       capture:      string[]   (selectors to clip, besides #upgrades-tab),
//       facts:        { key: "<op>:<sel>[:<prop>]" },
//       acceptance:   string,
//   } ] }
//
// facts DSL:
//   rect:<sel>              -> { top,right,bottom,left,width,height }
//   style:<sel>:<prop>      -> computed style string
//   text:<sel>              -> trimmed textContent
//   exists:<sel>            -> boolean
//   count:<sel>             -> number
//
// State from a `click` on the shared post-run page PERSISTS to later entries:
// post-run entries share one WASM run and one page. Manifest authors order
// entries so a stateful click comes last, or add a reverting click.

import {
	__dirname,
	build,
	startServer,
	launchChrome,
	cdp,
	attachPage,
	evaluate,
	sleep,
	PAGE_PATH,
	HEIGHT,
	RUN_WIDTH,
	RUN_DEADLINE_MS,
	MIN_ROWS,
	startRunExpression,
	rowCountExpression,
	activateTabExpression,
	axeRun,
} from './test-tab-harness.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

function usage(msg) {
	if (msg) console.error(`test-review.mjs: ${msg}`);
	console.error('usage: node ./test-review.mjs --manifest <path> --out <dir>');
}

function parseArgs(argv) {
	const out = { manifest: null, out: null };
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === '--manifest') out.manifest = argv[++i];
		else if (argv[i] === '--out') out.out = argv[++i];
	}
	return out;
}

// Evaluate one fact DSL entry at the current width. Returns the value or null.
function factExpression(spec) {
	const firstColon = spec.indexOf(':');
	const op = spec.slice(0, firstColon);
	const rest = spec.slice(firstColon + 1);
	if (op === 'rect') {
		return `(() => { const el = document.querySelector(${JSON.stringify(rest)}); if (!el) return null; const r = el.getBoundingClientRect(); return { top: r.top, right: r.right, bottom: r.bottom, left: r.left, width: r.width, height: r.height }; })()`;
	}
	if (op === 'style') {
		const lastColon = rest.lastIndexOf(':');
		const sel = rest.slice(0, lastColon);
		const prop = rest.slice(lastColon + 1);
		return `(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return null; return getComputedStyle(el)[${JSON.stringify(prop)}]; })()`;
	}
	if (op === 'text') {
		return `(() => { const el = document.querySelector(${JSON.stringify(rest)}); if (!el) return null; return (el.textContent || '').trim(); })()`;
	}
	if (op === 'exists') {
		return `(!!document.querySelector(${JSON.stringify(rest)}))`;
	}
	if (op === 'count') {
		return `document.querySelectorAll(${JSON.stringify(rest)}).length`;
	}
	return `(() => { throw new Error('unknown fact op: ' + ${JSON.stringify(op)}); })()`;
}

// Capture a clip of `sel` to `<out>/<ticket>-<state>-<width>-<n>.png`. Returns
// the filename written, or an { error } if the selector was not found.
//
// The element is scrolled into view first and the clip is taken in DOCUMENT
// coordinates (viewport rect + scroll offset) with captureBeyondViewport. On
// the full wowsims page the #upgrades-tab pane sits ~1300px down at a narrow
// width, past the emulated 900px viewport; capturing that offset without first
// scrolling to it returned a correctly-sized but empty (dark) clip, because the
// pane had never painted. scrollIntoView forces the paint, then the document-
// coordinate clip lands on the now-rendered element.
async function captureClip(send, outDir, ticket, state, width, n, sel) {
	const rect = await evaluate(
		send,
		`(() => {
			const el = document.querySelector(${JSON.stringify(sel)});
			if (!el) return null;
			el.scrollIntoView({ block: 'start', inline: 'nearest' });
			const r = el.getBoundingClientRect();
			return { x: r.left + window.scrollX, y: r.top + window.scrollY, width: r.width, height: r.height };
		})()`,
	);
	if (!rect || rect.width === 0 || rect.height === 0) {
		return { error: `capture selector missing or zero-size: ${sel}` };
	}
	// A beat for the scroll to settle and the newly-visible region to paint.
	await sleep(150);
	const { data } = await send('Page.captureScreenshot', {
		format: 'png',
		clip: { x: rect.x, y: rect.y, width: rect.width, height: rect.height, scale: 1 },
		captureBeyondViewport: true,
	});
	const file = `${ticket}-${state}-${width}-${n}.png`;
	fs.writeFileSync(path.join(outDir, file), Buffer.from(data, 'base64'));
	return { file };
}

// Dispatch a hover or click at the centre of `sel`. Returns null on success or
// an error string if the target was not found.
async function doInteraction(send, interaction) {
	const kind = interaction.hover ? 'hover' : interaction.click ? 'click' : null;
	const sel = interaction.hover || interaction.click;
	if (!kind) return `unknown interaction: ${JSON.stringify(interaction)}`;
	const centre = await evaluate(
		send,
		`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`,
	);
	if (!centre) return `interaction target not found: ${sel}`;
	if (kind === 'hover') {
		await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: centre.x, y: centre.y });
	} else {
		await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: centre.x, y: centre.y, button: 'left', clickCount: 1 });
		await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: centre.x, y: centre.y, button: 'left', clickCount: 1 });
	}
	await sleep(300);
	return null;
}

// Capture one entry at one width on an already-emulated, activated page.
async function captureEntryAtWidth(send, outDir, entry, width) {
	const files = [];
	const errors = [];

	for (const interaction of entry.interactions || []) {
		const err = await doInteraction(send, interaction);
		if (err) errors.push(err);
	}

	// Capture 0 is the pane, then each named selector — unless the entry opts
	// out of the pane (pane: false), in which case only its own selectors.
	const pane = entry.pane !== false;
	const selectors = pane ? ['#upgrades-tab', ...(entry.capture || [])] : [...(entry.capture || [])];
	for (let n = 0; n < selectors.length; n++) {
		const res = await captureClip(send, outDir, entry.ticket, entry.state, width, n, selectors[n]);
		if (res.error) errors.push(res.error);
		else files.push(res.file);
	}

	// Facts at this width.
	const facts = {};
	for (const [key, spec] of Object.entries(entry.facts || {})) {
		try {
			facts[key] = await evaluate(send, factExpression(spec));
		} catch (err) {
			errors.push(`fact ${key} (${spec}) threw: ${err.message}`);
			facts[key] = null;
		}
	}

	// a11y at this exact state/width.
	const axeRoot = pane ? '#upgrades-tab' : selectors[0];
	let axe = null;
	try {
		axe = await axeRun(send, axeRoot);
	} catch (err) {
		errors.push(`axe at ${width} threw: ${err.message}`);
	}

	return { files, errors, facts, axe };
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	if (!args.manifest || !args.out) {
		usage('both --manifest and --out are required');
		process.exit(2);
	}
	const manifestPath = path.resolve(process.cwd(), args.manifest);
	const outDir = path.resolve(process.cwd(), args.out);

	let manifest;
	try {
		manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
	} catch (err) {
		usage(`could not read manifest ${manifestPath}: ${err.message}`);
		process.exit(2);
	}
	if (!manifest || !Array.isArray(manifest.entries)) {
		usage('manifest has no entries array');
		process.exit(2);
	}
	fs.mkdirSync(outDir, { recursive: true });
	console.log(`tab-review: manifest ${manifestPath} (${manifest.entries.length} entries) -> ${outDir}`);

	const indexEntries = [];
	const factsOut = {};
	const a11yOut = {};

	// forkHead / forkDirty from the fork's own git, for provenance.
	const headRes = spawnSync('git', ['-C', __dirname, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
	const forkHead = headRes.status === 0 ? headRes.stdout.trim() : null;
	const dirtyRes = spawnSync('git', ['-C', __dirname, 'status', '--porcelain'], { encoding: 'utf8' });
	const forkDirty = dirtyRes.status === 0 ? dirtyRes.stdout.trim().length > 0 : null;

	let server, chrome, client;
	try {
		await build();
		server = await startServer();
		console.log(`serving dist on http://127.0.0.1:${server.port}`);
		chrome = await launchChrome();
		client = cdp(chrome.wsUrl);
		await client.ready;
	} catch (err) {
		// A crash before any capture: nothing was measured.
		console.error(`tab-review: setup failed before any capture: ${err.message}`);
		console.log(`TAB_REVIEW_VERDICT ${JSON.stringify({ outcome: 'unmeasured', entries: 0, errors: 1, out: outDir })}`);
		process.exit(2);
	}

	const url = `http://127.0.0.1:${server.port}${PAGE_PATH}`;
	const pre = manifest.entries.filter(e => e.state === 'pre-run');
	const post = manifest.entries.filter(e => e.state === 'post-run');

	const recordEntry = (entry, width, r) => {
		if (r.facts && Object.keys(r.facts).length) {
			factsOut[entry.ticket] = factsOut[entry.ticket] || {};
			factsOut[entry.ticket][width] = r.facts;
		}
		if (r.axe) a11yOut[`${entry.ticket}/${width}`] = r.axe;
		indexEntries.push({ ticket: entry.ticket, state: entry.state, width, files: r.files, errors: r.errors });
	};

	// A manifest entry with no widths captures nothing, so the per-width loops
	// below never touch it and it would leave errorCount at 0 -- a green run with
	// zero evidence for that ticket (ticket 451). Fail it as its own error row.
	for (const entry of manifest.entries) {
		if (!(entry.widths || []).length) {
			indexEntries.push({
				ticket: entry.ticket,
				state: entry.state,
				width: null,
				files: [],
				errors: [`manifest entry ${entry.ticket} (${entry.state}) has no widths -- nothing to capture`],
			});
		}
	}

	try {
		// pre-run entries: a fresh page per (entry, width). No sim.
		for (const entry of pre) {
			for (const width of entry.widths || []) {
				const { send } = await attachPage(client);
				await send('Emulation.setDeviceMetricsOverride', { width, height: HEIGHT, deviceScaleFactor: 1, mobile: false });
				await send('Page.navigate', { url });
				await sleep(300);
				const act = await evaluate(send, activateTabExpression());
				if (act && act.error) {
					indexEntries.push({ ticket: entry.ticket, state: entry.state, width, files: [], errors: [act.error] });
					continue;
				}
				const r = await captureEntryAtWidth(send, outDir, entry, width);
				recordEntry(entry, width, r);
			}
		}

		// post-run entries: one WASM run, shared page, re-emulate per (entry, width).
		if (post.length) {
			const { send } = await attachPage(client);
			await send('Emulation.setDeviceMetricsOverride', { width: RUN_WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false });
			await send('Page.navigate', { url });
			await sleep(300);
			const started = await evaluate(send, startRunExpression());
			let ran = false;
			if (started && started.error) {
				for (const entry of post)
					for (const width of entry.widths || [])
						indexEntries.push({ ticket: entry.ticket, state: entry.state, width, files: [], errors: [`run did not start: ${started.error}`] });
			} else {
				const deadline = Date.now() + RUN_DEADLINE_MS;
				let rows = 0;
				while (Date.now() < deadline) {
					rows = await evaluate(send, rowCountExpression);
					if (rows >= MIN_ROWS) break;
					await sleep(1000);
				}
				ran = rows >= MIN_ROWS;
				if (!ran) {
					for (const entry of post)
						for (const width of entry.widths || [])
							indexEntries.push({ ticket: entry.ticket, state: entry.state, width, files: [], errors: [`run produced only ${rows} rows (< ${MIN_ROWS})`] });
				}
			}
			if (ran) {
				console.log('tab-review: run landed rows; capturing post-run entries');
				for (const entry of post) {
					for (const width of entry.widths || []) {
						await send('Emulation.setDeviceMetricsOverride', { width, height: HEIGHT, deviceScaleFactor: 1, mobile: false });
						await sleep(200);
						const r = await captureEntryAtWidth(send, outDir, entry, width);
						recordEntry(entry, width, r);
					}
				}
			}
		}
	} finally {
		try {
			client.close();
			chrome.proc.kill();
			server.proc.kill();
		} catch {
			// best-effort teardown
		}
	}

	const errorCount = indexEntries.reduce((a, e) => a + e.errors.length, 0);
	const index = {
		forkHead,
		forkDirty,
		generatedAt: new Date().toISOString(),
		manifest: manifestPath,
		entries: indexEntries,
	};
	fs.writeFileSync(path.join(outDir, 'index.json'), JSON.stringify(index, null, 2) + '\n');
	fs.writeFileSync(path.join(outDir, 'facts.json'), JSON.stringify(factsOut, null, 2) + '\n');
	fs.writeFileSync(path.join(outDir, 'a11y.json'), JSON.stringify(a11yOut, null, 2) + '\n');

	// Reaching here means setup and the capture loop ran: something was
	// measured, so the outcome is "captured" whether or not individual entries
	// hit errors. errors > 0 is the exit-1 "measured but a capture failed" case;
	// "unmeasured" (exit 2) is only a crash before any capture, handled above.
	console.log(`TAB_REVIEW_VERDICT ${JSON.stringify({ outcome: 'captured', entries: indexEntries.length, errors: errorCount, out: outDir })}`);
	process.exit(errorCount === 0 ? 0 : 1);
}

main().catch(err => {
	console.error('tab-review crashed:', err.stack || err.message);
	console.log(`TAB_REVIEW_VERDICT ${JSON.stringify({ outcome: 'unmeasured', entries: 0, errors: 1 })}`);
	process.exit(2);
});
