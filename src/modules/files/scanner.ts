import type { ObjectRead } from "@/lib/storage/types";

export type FileScanResult =
  | { state: "clean" }
  | { state: "not_required" }
  | { state: "infected"; code: string }
  | { state: "error"; code: string };

export interface FileScanner {
  scan(input: {
    byteSize: number;
    detectedType: string;
    open: () => Promise<ObjectRead | null>;
  }): Promise<FileScanResult>;
}

/**
 * The open-source default makes no malware-clean claim. Operators that require
 * scanning can inject a scanner; an unavailable required scanner must return
 * `error`, which leaves the file quarantined.
 */
export const noOpFileScanner: FileScanner = {
  async scan() {
    return { state: "not_required" };
  },
};
