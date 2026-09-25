import Link from "next/link";
import { Geist, Geist_Mono } from "next/font/google";

import { SignOutButton } from "@/components/passenger/sign-out-button";
import { getSessionUser } from "@/lib/session";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata = {
  title: "TeslaB",
  description: "TeslaB — the passenger app",
};

/**
 * The shell: a header and the page.
 *
 * The header reads the session on the **server**, so the name and the sign-out
 * button are in the HTML that arrives rather than appearing a moment later once
 * some client-side fetch resolves. That also means there is no "flash of signed
 * out" while the page works out whether it knows who you are.
 *
 * The links are only the two screens this milestone built. There is deliberately
 * no "history" link, because history is a later milestone and a link to a screen
 * that does not exist is worse than no link.
 *
 * `force-dynamic` is not set here even though the header uses `cookies()`: reading
 * the cookie jar opts the route into dynamic rendering by itself, and Next is
 * better at tracking that than a blanket directive would be.
 */
async function Header() {
  const user = await getSessionUser();
  const signedIn = user?.role === "PASSENGER";

  return (
    <header className="border-b border-black/[.08] bg-white dark:border-white/[.145] dark:bg-zinc-900">
      <div className="mx-auto flex w-full max-w-2xl items-center justify-between gap-4 px-4 py-3 sm:px-8">
        <Link href="/" className="text-sm font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
          TeslaB
        </Link>

        {signedIn ? (
          <nav className="flex items-center gap-4">
            <Link
              href="/ride"
              className="text-sm text-zinc-600 underline-offset-4 hover:underline dark:text-zinc-400"
            >
              Request a ride
            </Link>
            <Link
              href="/track"
              className="text-sm text-zinc-600 underline-offset-4 hover:underline dark:text-zinc-400"
            >
              Your ride
            </Link>
            <span className="hidden text-sm text-zinc-500 sm:inline dark:text-zinc-400">
              {user.name}
            </span>
            <SignOutButton />
          </nav>
        ) : (
          <nav className="flex items-center gap-4">
            <Link
              href="/signin"
              className="text-sm text-zinc-600 underline-offset-4 hover:underline dark:text-zinc-400"
            >
              Sign in
            </Link>
            <Link
              href="/signup"
              className="text-sm text-zinc-600 underline-offset-4 hover:underline dark:text-zinc-400"
            >
              Create account
            </Link>
          </nav>
        )}
      </div>
    </header>
  );
}

export default function RootLayout({ children }) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <Header />
        {children}
      </body>
    </html>
  );
}
