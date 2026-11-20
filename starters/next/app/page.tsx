import { desc, eq } from "drizzle-orm";
import { connection } from "next/server";
import { authEnabled, currentUser } from "@/auth";
import { db } from "@/db";
import { notes } from "@/db/schema";
import { list, presignGet, storageEnabled } from "@/lib/storage";
import { addNote, signInWithGoogle, signOutUser } from "./actions";
import { Upload } from "./upload";

type User = { id: string; email: string };

const button = "rounded bg-neutral-900 px-3 py-1.5 text-sm text-white";
const muted = "text-sm text-neutral-500";

export default async function Home() {
  await connection();
  const user = await currentUser();

  return (
    <main className="mx-auto flex max-w-xl flex-col gap-10 px-4 py-12">
      <header className="flex items-center justify-between gap-4">
        <h1 className="text-xl font-semibold">__APP_NAME__</h1>
        <Account user={user} />
      </header>
      <section className="flex flex-col gap-3">
        <h2 className="font-medium">Notes</h2>
        <Notes user={user} />
      </section>
      <section className="flex flex-col gap-3">
        <h2 className="font-medium">Files</h2>
        <Files user={user} />
      </section>
    </main>
  );
}

function Account({ user }: { user: User | null }) {
  if (!authEnabled) return <p className={muted}>Sign-in is not configured.</p>;
  if (!user) {
    return (
      <form action={signInWithGoogle}>
        <button type="submit" className={button}>
          Sign in with Google
        </button>
      </form>
    );
  }
  return (
    <form action={signOutUser} className="flex items-center gap-3">
      <span className="text-sm">{user.email}</span>
      <button type="submit" className={button}>
        Sign out
      </button>
    </form>
  );
}

async function Notes({ user }: { user: User | null }) {
  if (!db) return <p className={muted}>No database configured.</p>;
  if (!user) return <p className={muted}>Sign in to add notes.</p>;
  const rows = await db
    .select({ id: notes.id, body: notes.body })
    .from(notes)
    .where(eq(notes.userId, user.id))
    .orderBy(desc(notes.createdAt))
    .limit(20);

  return (
    <>
      <form action={addNote} className="flex gap-2">
        <input
          name="body"
          aria-label="Note"
          required
          maxLength={500}
          className="flex-1 rounded border border-neutral-300 px-3 py-1.5 text-sm"
        />
        <button type="submit" className={button}>
          Add
        </button>
      </form>
      {rows.length === 0 ? (
        <p className={muted}>No notes yet.</p>
      ) : (
        <ul className="flex flex-col gap-1 text-sm">
          {rows.map((note) => (
            <li key={note.id} dir="auto">
              {note.body}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

async function Files({ user }: { user: User | null }) {
  if (!storageEnabled) return <p className={muted}>No S3 bucket configured.</p>;
  if (!user) return <p className={muted}>Sign in to upload.</p>;
  const names = await list(["uploads", user.id]);
  const files = await Promise.all(
    names.map(async (name) => ({ name, url: await presignGet(["uploads", user.id, name]) })),
  );

  return (
    <>
      <Upload />
      {files.length === 0 ? (
        <p className={muted}>No files yet.</p>
      ) : (
        <ul className="flex flex-col gap-1 text-sm">
          {files.map((file) => (
            <li key={file.name}>
              <a href={file.url} className="underline">
                {file.name}
              </a>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
