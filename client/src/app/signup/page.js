import { SignUpForm } from "@/components/passenger/sign-up-form";
import { Heading, PageShell } from "@/components/ui";
import { redirectIfSignedIn } from "@/lib/session";

export const metadata = { title: "Create account — TeslaB" };

/**
 * Passenger sign-up.
 *
 * Guarded by the same rule as `/signin`, in the opposite direction: somebody who
 * already has a session belongs on **their own** home, not on a form that would
 * create a second account. No destination is named, so a signed-in driver opening
 * this page goes to `/driver` rather than being routed through the passenger's
 * screen.
 *
 * There is nothing to pass in. The API signs the new account in as part of the
 * registration, so the form has no second step and no state to carry across.
 */
export default async function SignUpPage() {
  await redirectIfSignedIn();

  return (
    <PageShell className="flex flex-col items-center justify-center gap-6">
      <Heading level={1} description="It takes an email address and a password.">
        Join TeslaB
      </Heading>
      <SignUpForm />
    </PageShell>
  );
}
