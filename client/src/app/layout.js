import Link from "next/link";
import { Geist, Geist_Mono } from "next/font/google";

import { SignOutButton } from "@/components/auth/sign-out-button";
import { ROLE } from "@/lib/roles";
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
 * The navigation is chosen by **role**, because the two halves of this product
 * share nothing a person can act on: a passenger requests and follows a ride, a
 * driver goes online and answers offers. Showing both sets of links would offer
 * every account a screen it would immediately be redirected away from.
 *
 * The links are only the screens that exist. There is deliberately no "history"
 * link for either role: history is a later milestone, and a link to a screen that
 * does not exist is worse than no link.
 *
 * `force-dynamic` is not set here even though the header uses `cookies()`: reading
 * the cookie jar opts the route into dynamic rendering by itself, and Next is
 * better at tracking that than a blanket directive would be.
 */
async function Header() {
  const user = await getSessionUser();

  return (
    <header className="border-b border-black/[.08] bg-white dark:border-white/[.145] dark:bg-zinc-900">
      <div className="mx-auto flex w-full max-w-2xl items-center justify-between gap-4 px-4 py-3 sm:px-8">
        <Link
          href="/"
          className="text-sm font-semibold tracking-tight text-zinc-900 dark:text-zinc-50"
        >
          TeslaB
        </Link>

        {user ? (
          <nav className="flex items-center gap-4">
            {user.role === ROLE.PASSENGER ? (
              <>
                <NavLink href="/ride">Request a ride</NavLink>
                <NavLink href="/track">Your ride</NavLink>
              </>
            ) : null}

            {user.role === ROLE.DRIVER ? <NavLink href="/driver">Driver console</NavLink> : null}

            <span className="hidden text-sm text-zinc-500 sm:inline dark:text-zinc-400">
              {user.name}
            </span>
            <SignOutButton />
          </nav>
        ) : (
          <nav className="flex items-center gap-4">
            <NavLink href="/signin">Sign in</NavLink>
            <NavLink href="/signup">Create account</NavLink>
          </nav>
        )}
      </div>
    </header>
  );
}

/** One header link. Four of them, so the classes are named once. */
function NavLink({ href, children }) {
  return (
    <Link
      href={href}
      className="text-sm text-zinc-600 underline-offset-4 hover:underline dark:text-zinc-400"
    >
      {children}
    </Link>
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
