import { Spinner } from '@ui-kit/Spinner';
import { lazy, Suspense, useLayoutEffect, useRef, useState } from 'react';

// A dynamic import, so the tab's code and its bundled item data stay out of every spec page's first download (ticket 575).
const UpgradesTabBodyInner = lazy(() => import('@features/upgrades/components/UpgradesTab').then(module => ({ default: module.UpgradesTabBodyInner })));

/**
 * Renders the tab body the first time its pane is shown. Panes stay mounted and no context says which tab is open,
 * so the pane watches the `hidden` attribute Base UI keeps on a closed `Tabs.Panel`; this needs no change to the
 * tab strip's code. Outside a tab panel the body renders at once.
 */
export const UpgradesTabBody = () => {
	const probe = useRef<HTMLDivElement>(null);
	const [opened, setOpened] = useState(false);

	useLayoutEffect(() => {
		if (opened) return;
		const panel = probe.current?.closest('[role="tabpanel"]');
		if (!panel) {
			setOpened(true);
			return;
		}
		const check = () => {
			if (!panel.hasAttribute('hidden')) setOpened(true);
		};
		check();
		const observer = new MutationObserver(check);
		observer.observe(panel, { attributes: true, attributeFilter: ['hidden', 'data-hidden'] });
		return () => observer.disconnect();
	}, [opened]);

	if (!opened) return <div ref={probe} hidden />;
	return (
		<Suspense fallback={<Spinner className="mx-auto mt-6" />}>
			<UpgradesTabBodyInner />
		</Suspense>
	);
};
