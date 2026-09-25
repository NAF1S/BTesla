"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { signOut } from "@/lib/auth-api";
import { Button } from "@/components/ui";

/**
 * Sign out — shared by both roles.
 *
 * The API clears the cookie and answers `204`, and it does not require a valid
 * token — so this works on a session that has already expired, and is safe to
 * retry. There is nothing to invalidate on the client because there is nothing
 * stored on the client: the cookie *was* the session.
 *
 * The redirect is `replace`, so the back button does not walk into a page the
 * person has just signed out of. `refresh` re-renders the server components,
 * which is what makes the header stop showing them as signed in.
 *
 * A failure is not worth blocking on: if the request could not reach the API, the
 * cookie is still there, but the honest thing is to send them to the sign-in
 * screen and let the guard there decide. Swallowing the error silently would
 * leave somebody staring at a button that appeared to do nothing.
 */
export function SignOutButton({ className = "" }) {
  const router = useRouter();
  const [leaving, setLeaving] = useState(false);

  const onClick = async () => {
    setLeaving(true);

    try {
      await signOut();
    } catch {
      // Deliberately ignored — see above. The redirect happens either way.
    }

    router.replace("/signin");
    router.refresh();
  };

  return (
    <Button variant="quiet" onClick={onClick} disabled={leaving} className={className}>
      {leaving ? "Signing out…" : "Sign out"}
    </Button>
  );
}
