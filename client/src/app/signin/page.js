import { SignInForm } from "@/components/passenger/sign-in-form";
import { Heading, PageShell } from "@/components/ui";
import { PASSENGER_HOME, redirectIfSignedIn } from "@/lib/session";

export const metadata = { title: "Sign in — TeslaB" };

/**
 * The sign-in screen.
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
 *  * `denied` — the role that was refused. It only ever produces a sentence: the
 *    server already decided, and the form does not re-check anything.
 */
export default async function SignInPage({ searchParams }) {
  await redirectIfSignedIn({ to: PASSENGER_HOME });

  const params = await searchParams;

  return (
    <PageShell className="flex flex-col items-center justify-center gap-6">
      <Heading level={1} description="Sign in to request a ride and follow it.">
        Welcome back
      </Heading>
      <SignInForm next={params?.next ?? null} deniedRole={params?.denied ?? null} />
    </PageShell>
  );
}
