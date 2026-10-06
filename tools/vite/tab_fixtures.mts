import fs from 'fs';
import path from 'path';
import { PluginOption } from 'vite';

import { fixtureSettledExpression, pagePathFor, upgradesTabButtonSelector } from '../../test-tab-harness.mjs';

/**
 * Dev-server-only index and loader for the recorded Upgrades-tab fixtures (ticket 520).
 * `/tbc/tab-fixtures/` lists them and `/tbc/tab-fixtures/<name>.json` serves one, which is
 * where the tab's replay runner fetches it (`ui/features/upgrades/utils/fixture.ts`);
 * `<spec page>?upgrades-fixture=<name>` opens the Upgrades tab on that recorded result
 * without a run. The fixtures live in the main repo. `apply: 'serve'` keeps all of this
 * out of every build.
 */
export function tabFixtures(dir: string): PluginOption {
	const esc = (s: unknown) => String(s).replace(/[&<>"]/g, c => `&#${c.charCodeAt(0)};`);
	const fixtureNames = () =>
		fs
			.readdirSync(dir)
			.filter(f => f.endsWith('.json'))
			.sort()
			.map(file => file.slice(0, -'.json'.length));

	// `document.documentElement.dataset.upgradesFixture` and `#upgrades-fixture-error` are what
	// the repo's `scripts/tab-fixtures/smoke.mjs` reads.
	const autoload = `(async () => {
	const name = new URLSearchParams(location.search).get('upgrades-fixture');
	if (!name) return;
	const until = async (fn, ms) => { const end = Date.now() + ms; while (!fn() && Date.now() < end) await new Promise(r => setTimeout(r, 100)); return fn(); };
	const nav = () => document.querySelector(${JSON.stringify(upgradesTabButtonSelector)});
	try {
		const payload = fetch('/tbc/tab-fixtures/' + encodeURIComponent(name) + '.json').then(r => {
			if (!r.ok) throw new Error('no fixture named ' + name + ' (HTTP ' + r.status + ')');
			return r.json();
		});
		payload.catch(() => {});
		if (!(await until(() => typeof window.__upgradesFixture === 'function' && nav(), 120000))) throw new Error('the Upgrades tab did not load in 120 s');
		nav().click();
		const res = await window.__upgradesFixture(await payload);
		if (!res.ok) throw new Error('fixture rejected: ' + res.reason + (res.detail ? ' (' + res.detail + ')' : ''));
		if (!(await until(() => ${fixtureSettledExpression}, 30000))) throw new Error('the table did not settle in 30 s');
		document.documentElement.dataset.upgradesFixture = 'loaded';
		console.info('[upgrades-fixture] ' + name + ': ' + res.rows + ' rows, settled ' + (performance.now() / 1000).toFixed(1) + ' s after navigation');
	} catch (e) {
		document.documentElement.dataset.upgradesFixture = 'failed';
		const msg = '[upgrades-fixture] ' + name + ': ' + (e && e.message ? e.message : e);
		console.error(msg);
		const p = document.createElement('p');
		p.id = 'upgrades-fixture-error';
		p.style.cssText = 'margin: 0.5rem; padding: 0.5rem; border: 1px solid #dc3545; color: #dc3545';
		p.textContent = msg;
		document.body.prepend(p);
	}
})();`;

	return {
		name: 'tab-fixtures',
		apply: 'serve',
		configureServer(server) {
			server.middlewares.use('/tbc/tab-fixtures', (req, res) => {
				const pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
				const json = /^\/([\w.-]+)\.json$/.exec(pathname);
				if (json && fixtureNames().includes(json[1])) {
					res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
					res.end(fs.readFileSync(path.join(dir, `${json[1]}.json`)));
					return;
				}
				if (pathname !== '/') {
					res.writeHead(404, { 'Content-Type': 'text/plain' });
					res.end('Not Found');
					return;
				}
				const items = fixtureNames().map(name => {
					const spec = JSON.parse(fs.readFileSync(path.join(dir, `${name}.json`), 'utf-8')).spec;
					let link = esc(name);
					try {
						link = `<a href="${pagePathFor(spec)}?upgrades-fixture=${esc(name)}">${link}</a>`;
					} catch {}
					return `<li>${link} (${esc(spec)})</li>`;
				});
				res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
				res.end(`<!doctype html><title>Tab fixtures</title><ul>${items.join('')}</ul>`);
			});
		},
		transformIndexHtml() {
			return [{ tag: 'script', children: autoload, injectTo: 'body' }];
		},
	};
}
