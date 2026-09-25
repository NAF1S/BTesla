import { redirect } from "next/navigation";

import { RideRequestPanel } from "@/components/passenger/ride-request-panel";
import { Heading, PageShell } from "@/components/ui";
import { getCurrentRide } from "@/lib/passenger-api";
import { PASSENGER_HOME, readCookieHeader, requirePassenger } from "@/lib/session";

export const metadata = { title: "Request a ride — TeslaB" };

/**
 * Where a passenger picks two places and asks for a car.
 *
 * The guard runs first, so an uninvited visitor gets a redirect rather than a
 * rendered form.
 *
 * Then the one interesting decision on this page: **a passenger who is already on
 * a ride is sent to the tracker instead.** Without it they would fill in the form,
 * press the button, and be told by the API that they already have an active
 * request — the endpoint refuses a second one, deliberately, and the refusal is a
 * `409`. Finding that out before filling in a form is better than finding out
 * after.
 *
 * The check is best-effort on purpose. If the API cannot be reached, this page
 * still renders and the panel shows its own error: a redirect decision is not
 * worth turning a slow API into a broken page.
 */
export default async function RidePage() {
  const user = await requirePassenger({ redirectTo: PASSENGER_HOME });

  let alreadyRiding = false;
  try {
    alreadyRiding = (await getCurrentRide({ cookie: await readCookieHeader() })) !== null;
  } catch {
    // See above: fall through and let the panel report the problem.
  }

  if (alreadyRiding) redirect("/track");

  return (
    <PageShell className="flex flex-col gap-6">
      <Heading
        level={1}
        description={`Signed in as ${user.name}. Prices come from the server before anything is booked.`}
      >
        Where to?
      </Heading>
      <RideRequestPanel />
    </PageShell>
  );
}
