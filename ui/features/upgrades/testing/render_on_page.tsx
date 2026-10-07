import { SimHostProvider } from '@sim/context/SimHostContext';
import { fakeHost } from '@sim/testing';
import { render } from '@testing-library/react';
import type { ReactElement, ReactNode } from 'react';

/** A page whose sim database has no items, so every Source cell shows the engine's label. */
const host = fakeHost({ sim: { db: { getItemById: () => undefined } } });
const Page = ({ children }: { children: ReactNode }) => <SimHostProvider host={host}>{children}</SimHostProvider>;

/** Renders results-table UI on that page: each row's Source cell reads the page's sim. */
export const renderOnPage = (ui: ReactElement) => render(ui, { wrapper: Page });
