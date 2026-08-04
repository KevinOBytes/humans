import { Skeleton } from "@/components/ui/skeleton";

export default function PeopleLoading() {
  return (
    <section role="status" aria-label="Loading people" className="space-y-5">
      <Skeleton className="h-10 w-48" />
      <Skeleton className="h-16 w-full" />
      <Skeleton className="h-80 w-full" />
    </section>
  );
}
