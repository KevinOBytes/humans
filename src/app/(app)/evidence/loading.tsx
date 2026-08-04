import { Skeleton } from "@/components/ui/skeleton";

export default function EvidenceLoading() {
  return (
    <section role="status" aria-label="Loading evidence" className="space-y-5">
      <Skeleton className="h-10 w-64" />
      <Skeleton className="h-28 w-full" />
      <Skeleton className="h-80 w-full" />
    </section>
  );
}
