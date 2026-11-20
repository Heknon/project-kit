"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { currentUser, signIn, signOut } from "@/auth";
import { db } from "@/db";
import { notes } from "@/db/schema";
import { presignPut } from "@/lib/storage";

export async function signInWithGoogle() {
  await signIn("google", { redirectTo: "/" });
}

export async function signOutUser() {
  await signOut({ redirectTo: "/" });
}

const noteBody = z.string().trim().min(1).max(500);

export async function addNote(formData: FormData) {
  const user = await currentUser();
  const body = noteBody.safeParse(formData.get("body"));
  if (!db || !user || !body.success) return;
  await db.insert(notes).values({ userId: user.id, body: body.data });
  revalidatePath("/");
}

export async function createUploadUrl(fileName: string, contentType: string): Promise<string> {
  const user = await currentUser();
  if (!user) throw new Error("Not signed in");
  return presignPut(["uploads", user.id, safeFileName(fileName)], contentType || "application/octet-stream");
}

function safeFileName(name: string): string {
  const cleaned = name.replace(/[^\w.-]/g, "_").slice(-100);
  return /^\.*$/.test(cleaned) ? "file" : cleaned;
}
