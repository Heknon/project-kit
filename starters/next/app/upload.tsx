"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { createUploadUrl } from "./actions";

export function Upload() {
  const router = useRouter();
  const [status, setStatus] = useState<"idle" | "uploading" | "failed">("idle");

  async function upload(file: File) {
    setStatus("uploading");
    try {
      const url = await createUploadUrl(file.name, file.type);
      const response = await fetch(url, {
        method: "PUT",
        body: file,
        headers: { "Content-Type": file.type || "application/octet-stream" },
      });
      if (!response.ok) throw new Error(`Upload failed with ${response.status}`);
      setStatus("idle");
      router.refresh();
    } catch {
      setStatus("failed");
    }
  }

  return (
    <div className="flex items-center gap-3">
      <input
        type="file"
        aria-label="File"
        disabled={status === "uploading"}
        className="text-sm file:me-3 file:rounded file:border-0 file:bg-neutral-900 file:px-3 file:py-1.5 file:text-white"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void upload(file);
          event.target.value = "";
        }}
      />
      {status === "uploading" && <span className="text-sm text-neutral-500">Uploading</span>}
      {status === "failed" && <span className="text-sm text-red-600">Upload failed. Try again.</span>}
    </div>
  );
}
