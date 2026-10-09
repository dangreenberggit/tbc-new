import i18n from '@i18n/config';
import { Spinner } from '@ui-kit/Spinner';
import { Component, lazy, type ReactNode, Suspense, useLayoutEffect, useRef, useState } from 'react';

// A dynamic import, so the tab's code and its bundled item data stay out of every spec page's first download (ticket 575).
const UpgradesTabBodyInner = lazy(() => import('@features/upgrades/components/UpgradesTab').then(module => ({ default: module.UpgradesTabBodyInner })));

/**
 * Catches a failed download of the tab's code, for example after a site release removes the old chunk while the
 * page is open. Without it React unmounts the page's one root and the whole sim page goes blank. React has no hook
 * for this, so it is a class.
 */
class LoadFailedBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
	state = { failed: false };

	static getDerivedStateFromError() {
		return { failed: true };
	}

	render() {
		if (!this.state.failed) return this.props.children;
		return (
			<p className="mt-6 text-center text-danger" role="alert" data-testid="upgrades-tab-load-failed">
				{i18n.t('load_failed', { ns: 'upgrades' })}
			</p>
		);
	}
}

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
		<LoadFailedBoundary>
			<Suspense fallback={<Spinner className="mx-auto mt-6" />}>
				<UpgradesTabBodyInner />
			</Suspense>
		</LoadFailedBoundary>
	);
};
