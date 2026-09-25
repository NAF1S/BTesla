"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { signIn } from "@/lib/auth-api";
import { homeForRole } from "@/lib/roles";
import { Button, Field, Input, Notice, Panel } from "@/components/ui";

/**
 * Signing in — one form, both roles.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS IN `components/auth/` AND NOT `components/passenger/`
 * ---------------------------------------------------------------------------
 * A person signs in before they are a passenger or a driver: the API has one
 * login endpoint, one cookie, and one DTO. Only *after* it answers does the role
 * matter, and it is the API's answer that decides where this lands — never a
 * field on the form and never a client-side guess. A role selector here would be
 * a way to ask for a session you should not have.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT DOES WITH THE SESSION
 * ---------------------------------------------------------------------------
 * Nothing. `signIn` posts the credentials, and the API answers with an HttpOnly
 * cookie that the browser stores and JavaScript cannot read. There is no token to
 * keep, no `localStorage`, and therefore nothing here that can leak one.
 *
 * After a successful sign-in, `router.replace` navigates and `router.refresh`
 * tells Next to re-render the server components — which is what makes the header
 * start showing the name and the guard start letting them through. `replace`
 * rather than `push`, so the back button does not return to a form that has
 * already been used.
 */
export function SignInForm({ next = null, deniedRole = null }) {
  const router = useRouter();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  const canSubmit = email.trim() !== "" && password !== "" && !submitting;

  const onSubmit = async (event) => {
    event.preventDefault();
    if (!canSubmit) return;

    setSubmitting(true);
    setError(null);

    try {
      // The role decides where this lands: a passenger at `/ride`, a driver at
      // `/driver`. It comes from the user the API just returned, and
      // `homeForRole` is the one place that mapping is written down. `next` wins
      // when the guard remembered where somebody was going, because "the screen
      // you asked for" is more specific than "the screen for your role".
      const user = await signIn({ email: email.trim(), password });
      router.replace(next || homeForRole(user.role) || "/signin");
      router.refresh();
    } catch (err) {
      setError(err);
      setSubmitting(false);
    }
  };

  return (
    <Panel className="w-full max-w-md">
      <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
        <div>
          <h2 className="text-xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
            Sign in
          </h2>
          <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
            Passengers get the ride screen; drivers get the driver console.
          </p>
        </div>

        {deniedRole ? (
          <Notice tone="warning" title={`This account is a ${deniedRole}`}>
            This client has a screen for passengers and one for drivers, and none for a{" "}
            {deniedRole}. Sign in with one of those accounts.
          </Notice>
        ) : null}

        {error ? (
          <Notice
            tone="error"
            title={error.isUnauthenticated ? "Sign-in failed" : "Could not sign in"}
          >
            {error.message}
          </Notice>
        ) : null}

        <Field id="email" label="Email">
          <Input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="you@example.com"
          />
        </Field>

        <Field id="password" label="Password">
          <Input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </Field>

        <Button type="submit" disabled={!canSubmit}>
          {submitting ? "Signing in…" : "Sign in"}
        </Button>

        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          No account?{" "}
          <Link href="/signup" className="underline underline-offset-4">
            Create a passenger account
          </Link>
        </p>

        {/* Said plainly, and as a warning rather than a feature: there is no
            vehicle endpoint, so a driver created here cannot be dispatched to.
            The dashboard explains the same thing from the driver's side. */}
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          Driver accounts are seeded, not self-service: a new driver has no vehicle and dispatch
          cannot use one. Sign in as the seeded driver to drive a ride.
        </p>
      </form>
    </Panel>
  );
}
