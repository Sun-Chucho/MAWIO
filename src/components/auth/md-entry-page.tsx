"use client";

import Image from "next/image";
import { writeActiveSessionUsername } from "@/app/lib/login-profiles";

/** A deliberately minimal, touch-friendly entry point for the MD dashboard. */
export function MdEntryPage() {
  const enterDashboard = () => {
    // The dashboard continues to use its normal role/session gate. Entering via
    // the MD mark establishes that role without asking for credentials.
    localStorage.setItem("orange-hotel-role", "director");
    localStorage.setItem("orange-hotel-active-login-scope", "standard");
    localStorage.setItem("mawio-tier", "standard");
    localStorage.removeItem("orange-hotel-shift");
    writeActiveSessionUsername("MD", "standard");
    window.location.assign("/dashboard");
  };

  return (
    <main className="flex min-h-[100dvh] w-full items-center justify-center overflow-hidden bg-white p-6">
      <button
        type="button"
        aria-label="Open MD Dashboard"
        onClick={enterDashboard}
        className="flex h-48 w-48 items-center justify-center rounded-[2rem] p-5 transition-transform duration-200 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-primary/40 active:scale-95 sm:h-56 sm:w-56"
      >
        <Image
          src="/logo.png"
          alt="MAWIO"
          width={224}
          height={224}
          priority
          className="h-full w-full object-contain"
        />
      </button>
    </main>
  );
}
