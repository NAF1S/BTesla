import { SignInForm } from "@/components/auth/sign-in-form";
import { Heading, PageShell } from "@/components/ui";
import { redirectIfSignedIn } from "@/lib/session";

export const metadata = { title: "Sign in — TeslaB" };

/**
 * The sign-in screen — for **both** roles.
 *
 * `redirectIfSignedIn` is given no destination on purpose: it sends whoever is
 * already signed in to **their own** home, from `homeForRole`. Naming a
 * destination here would send a signed-in driver to `/ride`, which would bounce
 * them on to `/driver` — one wasted hop, and a rule written twice.
 *
 * `searchParams` is a **Promise** in Next 16, so it is awaited rather than read
 * synchronously — the same change that made `cookies()` asynchronous.
 *
 * The two query parameters are read here, on the server, and handed to the form as
 * props. The alternative is `useSearchParams()` inside the client component, which
 * forces it to be wrapped in a `Suspense` boundary and makes the form render twice
 * on the client. Reading them once on the server is both simpler and faster.
 *
 *  * `next` — where the guard was sending the visitor before it found no session.
 *    It is passed through to `router.replace` unchanged; a redirect target is not
 *    the form's business to interpret.
 *  * `denied` — the role that was refused, which is now only ever an account with
 *    no screen here at all (`ADMIN`). The wrong-role cases are handled by
 *    redirection, not by a banner.
 */
export default async function SignInPage({ searchParams }) {
  await redirectIfSignedIn();

  const params = await searchParams;

  return (
    <PageShell className="flex flex-col items-center justify-center gap-6">
      <Heading level={1} description="Passengers request rides; drivers answer them.">
        Welcome back
      </Heading>
      <SignInForm next={params?.next ?? null} deniedRole={params?.denied ?? null} />
    </PageShell>
  );
}
