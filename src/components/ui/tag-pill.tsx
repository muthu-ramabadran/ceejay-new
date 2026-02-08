import { Badge } from "@/components/ui/badge";

interface TagPillProps {
  label: string;
}

export function TagPill({ label }: TagPillProps): React.JSX.Element {
  return <Badge className="rounded-full px-3 py-1">{label}</Badge>;
}
