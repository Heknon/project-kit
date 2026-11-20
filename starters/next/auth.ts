import NextAuth from "next-auth";
import Google from "next-auth/providers/google";
import { env } from "@/lib/env";

export const authEnabled = Boolean(env.AUTH_SECRET && env.AUTH_GOOGLE_ID && env.AUTH_GOOGLE_SECRET);

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: authEnabled ? [Google] : [],
  session: { strategy: "jwt" },
  redirectProxyUrl: env.AUTH_REDIRECT_PROXY_URL,
  trustHost: true,
  callbacks: {
    signIn({ account, profile }) {
      return account?.provider === "google" && profile?.email_verified === true;
    },
    session({ session, token }) {
      if (token.sub) session.user.id = token.sub;
      return session;
    },
  },
});

export async function currentUser() {
  if (!authEnabled) return null;
  const session = await auth();
  const user = session?.user;
  return user?.id && user.email ? { id: user.id, email: user.email } : null;
}
