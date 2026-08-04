import { Skeleton } from "@/components/ui/skeleton";

export default function GraphLoading() {
  return (
    <section
      role="status"
      aria-label="Loading social graph"
      className="space-y-5"
    >
      <Skeleton className="h-10 w-64" />
      <Skeleton className="h-28 w-full" />
      <Skeleton className="h-[32rem] w-full" />
      <Skeleton className="h-80 w-full" />
    </section>
  );
}
