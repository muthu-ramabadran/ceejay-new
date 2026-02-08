import { ChevronRight } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { CompanyReference } from "@/types/company";

interface ReferenceChipProps {
  reference: CompanyReference;
  onOpen: (companyId: string) => void;
}

export function ReferenceChip({ reference, onOpen }: ReferenceChipProps): React.JSX.Element {
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      onClick={() => onOpen(reference.companyId)}
      className="h-auto gap-1 rounded-none px-0 py-0 text-xs text-accent hover:bg-transparent hover:text-[var(--accent-hover)] hover:underline"
      aria-label={`Open details for ${reference.companyName}`}
    >
      <span>{reference.companyName}</span>
      <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
    </Button>
  );
}
