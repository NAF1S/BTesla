import { SignUpForm } from "@/components/passenger/sign-up-form";
import { Heading, PageShell } from "@/components/ui";
import { PASSENGER_HOME, redirectIfSignedIn } from "@/lib/session";

export const metadata = { title: "Create account — TeslaB" };

/**
 * The sign-up screen.
 *
 * Guarded by the same rule as `/signin`, in the opposite direction: a passenger
 * who already has a session belongs on the ride screen, not on a form that would
 * create a second account.
 *
 * There is nothing to pass in. The API signs the new account in as part of the
 * registration, so the form has no second step and no state to carry across.
 */
export default async function SignUpPage() {
  await redirectIfSignedIn({ to: PASSENGER_HOME });

  return (
    <PageShell className="flex flex-col items-center justify-center gap-6">
      <Heading level={1} description="It takes an email address and a password.">
        Join TeslaB
      </Heading>
      <SignUpForm />
    </PageShell>
  );
}
