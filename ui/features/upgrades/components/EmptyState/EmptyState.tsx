export interface EmptyStateProps {
	title?: string;
	body: string;
}

/** What the results area says when there are no rows to show. */
export const EmptyState = ({ title, body }: EmptyStateProps) => (
	<div className="grid gap-1 py-6 text-center" data-testid="upgrades-empty-state">
		{title && <strong>{title}</strong>}
		<p className="mb-0 text-muted">{body}</p>
	</div>
);
