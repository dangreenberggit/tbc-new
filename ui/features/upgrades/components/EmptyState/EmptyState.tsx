export interface EmptyStateProps {
	title?: string;
	body: string;
}

export const EmptyState = ({ title, body }: EmptyStateProps) => (
	<div className="grid gap-1 py-6 text-center" data-testid="upgrades-empty-state">
		{title && <strong>{title}</strong>}
		<p className="mb-0 text-muted">{body}</p>
	</div>
);
