import { Skeleton } from "@/components/ui/skeleton";

export default function SettingsLoading() {
  return (
    <div role="status" aria-label="Loading settings" className="space-y-5">
      <Skeleton className="h-9 w-64" />
      <Skeleton className="h-32 w-full rounded-2xl" />
      <span className="sr-only">Loading settings…</span>
    </div>
  );
}
