"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { signUp } from "@/lib/auth-api";
import { ROLE } from "@/lib/roles";
import { Button, Field, Input, Notice, Panel } from "@/components/ui";

/**
 * Passenger sign-up.
 *
 * The API creates the account **and signs it in**, in one request, so there is no
 * second round trip and no half-signed-up state. `role: PASSENGER` is set in
 * `passenger-api.js` rather than being a field here: this is the passenger client,
 * and a role selector on the form would be a driver sign-up screen in disguise.
 *
 * The password rule is the API's (`MIN_PASSWORD_LENGTH` is 8). It is checked here
 * too, but only so the passenger finds out before a round trip — the server
 * remains the authority, and its message is what is shown if it disagrees.
 */

const MIN_PASSWORD_LENGTH = 8;

export function SignUpForm() {
  const router = useRouter();

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  const passwordTooShort = password !== "" && password.length < MIN_PASSWORD_LENGTH;
  const canSubmit =
    name.trim() !== "" && email.trim() !== "" && !passwordTooShort && password !== "" && !submitting;

  const onSubmit = async (event) => {
    event.preventDefault();
    if (!canSubmit) return;

    setSubmitting(true);
    setError(null);

    try {
      await signUp({ name: name.trim(), email: email.trim(), password, role: ROLE.PASSENGER });
      router.replace("/ride");
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
            Create your account
          </h2>
          <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
            You will be signed in straight away.
          </p>
        </div>

        {error ? (
          <Notice tone="error" title="Could not create the account">
            {error.message}
          </Notice>
        ) : null}

        <Field id="name" label="Full name">
          <Input
            id="name"
            name="name"
            autoComplete="name"
            required
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Nusrat Jahan"
          />
        </Field>

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

        <Field
          id="password"
          label="Password"
          hint={`At least ${MIN_PASSWORD_LENGTH} characters.`}
          error={passwordTooShort ? `Use at least ${MIN_PASSWORD_LENGTH} characters.` : null}
        >
          <Input
            id="password"
            name="password"
            type="password"
            autoComplete="new-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </Field>

        <Button type="submit" disabled={!canSubmit}>
          {submitting ? "Creating account…" : "Create account"}
        </Button>

        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          Already have an account?{" "}
          <Link href="/signin" className="underline underline-offset-4">
            Sign in
          </Link>
        </p>
      </form>
    </Panel>
  );
}
