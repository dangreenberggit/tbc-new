import i18n from '@i18n/config';

import type { RunNote } from '../../model/engine/disclosure';
import { noteLabel, noteText } from '../../utils/format';

export interface RunNotesListProps {
	notes: readonly RunNote[];
}

/**
 * Every item the run left out, and why, with the run's other notes: a left-out item is a reason an
 * item the player expected is missing from the list. Each line shows the tab's sentence only. A
 * failed call's error goes to the console, and the run's first one to the run's error toast
 * (`run_session.ts`), as no other sim screen puts a sim error in a list.
 */
export const RunNotesList = ({ notes }: RunNotesListProps) => (
	<section className="mt-4">
		<p className="mb-1 font-bold">{i18n.t('upgrades_tab.assumptions.notes_title', { ns: 'upgrades', count: notes.length })}</p>
		<dl className="mb-0 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1" data-testid="upgrades-run-notes">
			{notes.map(note => (
				// The engine names each note by what it is about; the slot, detail and error tell two about one field apart.
				<div key={`${note.field}|${note.slot ?? ''}|${note.detail}|${note.error ?? ''}`} className="contents">
					<dt className="font-normal text-muted">{noteLabel(note)}</dt>
					<dd className="m-0">{noteText(note.detail)}</dd>
				</div>
			))}
		</dl>
	</section>
);
