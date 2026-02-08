interface PropertyRow {
  label: string;
  value: React.ReactNode;
}

interface PropertyGridProps {
  rows: PropertyRow[];
}

export function PropertyGrid({ rows }: PropertyGridProps): React.JSX.Element {
  return (
    <dl className="divide-y divide-border/50">
      {rows.map((row) => (
        <div key={row.label} className="grid gap-3 py-2" style={{ gridTemplateColumns: "160px minmax(0, 1fr)" }}>
          <dt className="text-xs font-semibold uppercase tracking-[0.5px] text-[var(--text-tertiary)]">{row.label}</dt>
          <dd className="text-sm text-[var(--text-primary)]">{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}
