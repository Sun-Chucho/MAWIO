"use client";

import Link from "next/link";
import Image from "next/image";
import { useState } from "react";

export default function Home() {
  const [activeTab, setActiveTab] = useState<"login" | "director">("login");

  const handleSwap = () => {
    alert("Swap hotels clicked");
  };

  return (
    <main className="min-h-screen flex flex-col bg-gray-100 items-center">
      <header className="w-full bg-white shadow p-4 flex justify-between items-center">
        <Link href="/" className="flex items-center gap-2">
          <Image src="/logo.jpeg" alt="MAWIO logo" width={40} height={40} />
          <h1 className="text-xl font-bold">MAWIO</h1>
        </Link>
        <nav className="flex gap-2">
          <button
            className={`px-4 py-2 rounded ${activeTab === "login" ? "bg-blue-600 text-white" : "bg-gray-200"}`}
            onClick={() => setActiveTab("login")}
          >
            Login
          </button>
          <button
            className={`px-4 py-2 rounded ${activeTab === "director" ? "bg-green-600 text-white" : "bg-gray-200"}`}
            onClick={() => setActiveTab("director")}
          >
            Director
          </button>
        </nav>
      </header>

      <section className="flex-1 w-full max-w-md p-6">
        {activeTab === "login" && (
          <div className="bg-white p-6 rounded shadow">
            <h2 className="text-2xl mb-4">Login</h2>
            <form>
              <label className="block mb-2">
                Email
                <input type="email" className="w-full border rounded p-2 mt-1" placeholder="you@example.com" />
              </label>
              <label className="block mb-4">
                Password
                <input type="password" className="w-full border rounded p-2 mt-1" />
              </label>
              <button type="submit" className="w-full bg-blue-600 text-white py-2 rounded">
                Sign In
              </button>
            </form>
          </div>
        )}
        {activeTab === "director" && (
          <div className="bg-white p-6 rounded shadow flex flex-col items-center">
            <h2 className="text-2xl mb-4">Director Panel</h2>
            <button className="bg-green-600 text-white py-2 px-4 rounded" onClick={handleSwap}>
              Swap Hotels
            </button>
          </div>
        )}
      </section>

      <footer className="w-full text-center p-4 text-sm text-gray-500">
        © {new Date().getFullYear()} MAWIO
      </footer>
    </main>
  );
}
