"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { signIn } from "@/lib/passenger-api";
import { Button, Field, Input, Notice, Panel } from "@/components/ui";

/**
 * The passenger sign-in form.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A CLIENT COMPONENT
 * ---------------------------------------------------------------------------
 * It is the one place in this milestone that genuinely needs to be: it collects
 * input, submits it, and reacts to the answer. Everything downstream is guarded on
 * the server, so nothing sensitive is rendered here.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT DOES WITH THE SESSION
 * ---------------------------------------------------------------------------
 * Nothing. `signIn` posts the credentials, and the API answers with an HttpOnly
 * cookie that the browser stores and JavaScript cannot read. There is no token to
 * keep, no `localStorage`, and therefore nothing here that can leak one. That is
 * the project's existing pattern, not a choice made in this file.
 *
 * After a successful sign-in, `router.replace` navigates and `router.refresh`
 * tells Next to re-render the server components — which is what makes the layout
 * start showing the passenger's name and the guard start letting them through.
 * `replace` rather than `push`, so the back button does not return to a sign-in
 * form the passenger has already used.
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
      await signIn({ email: email.trim(), password });
      router.replace(next || "/ride");
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
            Request a ride and track it here.
          </p>
        </div>

        {deniedRole ? (
          <Notice tone="warning" title="This is the passenger app">
            You are signed in as a {deniedRole}, which this client does not support yet. Sign in
            with a passenger account.
          </Notice>
        ) : null}

        {error ? (
          <Notice tone="error" title={error.isUnauthenticated ? "Sign-in failed" : "Could not sign in"}>
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
            placeholder="nusrat@example.com"
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
      </form>
    </Panel>
  );
}
