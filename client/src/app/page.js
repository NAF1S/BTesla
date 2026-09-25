import { redirect } from "next/navigation";

import { homeForRole } from "@/lib/roles";
import { getSessionUser } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * The front door: a redirect, and only a redirect.
 *
 * Three destinations, and each is a fact rather than a preference:
 *
 *  * somebody signed in -> **their own** home, from `homeForRole`: a passenger to
 *    `/ride`, a driver to `/driver`. There is exactly one mapping for this, in
 *    `lib/roles.js`, because the sign-in form, the guards and this page all need
 *    the same answer and must never disagree about it;
 *  * anybody with no home here — an `ADMIN`, or nobody at all — to the sign-in
 *    screen, which is where the guard explains it;
 *  * **the API being unreachable** -> the diagnostics screen at `/status`, because
 *    that is the one page in this app that can say *why* nothing loaded and what to
 *    start. Sending somebody to a sign-in form whose own session check will fail
 *    the same way would be a worse answer than an explanation.
 */
export default async function Home() {
  let user = null;

  try {
    user = await getSessionUser();
  } catch {
    redirect("/status");
  }

  redirect(homeForRole(user?.role) ?? "/signin");
}
