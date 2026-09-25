import { redirect } from "next/navigation";

import { PASSENGER_HOME, getSessionUser } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * The front door: a redirect, and only a redirect.
 *
 * Three destinations, and each is a fact rather than a preference:
 *
 *  * a signed-in **passenger** -> the ride screen, which is where the brief says a
 *    signed-in passenger belongs;
 *  * anybody else — including a signed-in **driver** — -> the sign-in screen, which
 *    is where the guard explains that this client is the passenger's;
 *  * **the API being unreachable** -> the diagnostics screen at `/status`, because
 *    that is the one page in this app that can say *why* nothing loaded and what to
 *    start. Sending a visitor to a sign-in form whose own session check will fail
 *    the same way would be a worse answer than an explanation.
 */
export default async function Home() {
  let user = null;

  try {
    user = await getSessionUser();
  } catch {
    redirect("/status");
  }

  redirect(user?.role === "PASSENGER" ? PASSENGER_HOME : "/signin");
}
