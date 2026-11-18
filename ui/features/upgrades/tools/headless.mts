// Headless harness for the upgrades exporters.
//
// Lets an exporter run the sim's real decision functions (canEquipItem and
// friends) under plain Node, with no change to the sim's source: every shim
// below stands in for a browser global that some module in the import graph
// touches at load time for reasons unrelated to the decision being borrowed.
//
// Each shim is listed with the module that forces it and what that module
// wants it for. If a shim ever needs to grow beyond an inert placeholder --
// if an exporter starts depending on what a shim RETURNS -- that is the signal
// that the thing being borrowed is UI behaviour, not a pure decision, and the
// borrow is no longer safe.
//
// The window.location shim served modules that no longer exist (they derived a
// routing string and a spec page URL at load time); whether any module still
// needs it is untested.
//
//   window.location            (see above)
//   localStorage               ui/i18n/locale_service.ts     reads a saved language
//   virtual:i18next-loader     ui/i18n/config.ts             Vite-only specifier for
//                                                            the translation bundle
//                                                            (served by hooks.mjs)

const storage = {
	getItem: () => null,
	setItem: () => {},
	removeItem: () => {},
	clear: () => {},
};

const nav = { language: 'en', languages: ['en'], userAgent: 'node' };

const location = {
	protocol: 'http:',
	host: 'localhost',
	hostname: 'localhost',
	origin: 'http://localhost',
	href: 'http://localhost/',
	pathname: '/',
	search: '',
};

const noopElement = () => ({
	style: {},
	classList: { add: () => {}, remove: () => {} },
	appendChild: () => {},
	setAttribute: () => {},
});

export function installBrowserShims(): void {
	const g = globalThis as Record<string, unknown>;
	g.localStorage ??= storage;
	g.sessionStorage ??= storage;
	g.window ??= {
		location,
		localStorage: storage,
		sessionStorage: storage,
		navigator: nav,
		addEventListener: () => {},
		removeEventListener: () => {},
		matchMedia: () => ({ matches: false, addEventListener: () => {} }),
	};
	g.document ??= {
		documentElement: { lang: 'en', classList: { add: () => {}, remove: () => {} } },
		addEventListener: () => {},
		createElement: noopElement,
		querySelector: () => null,
		querySelectorAll: () => [],
		body: { appendChild: () => {} },
	};
}
