"use client";

import { useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { useRouter } from "next/navigation";

export default function LoginPage() {
  const router = useRouter();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const login = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (busy) return;

    setError(null);
    setBusy(true);

    const { error } = await supabase.auth.signInWithPassword({
      email: email.trim(),
      password,
    });

    setBusy(false);

    if (error) {
      setError(error.message);
      return;
    }

    router.replace("/new-job");
  };

  return (
    <div className="min-h-[100dvh] bg-slate-950 text-slate-100 flex items-center justify-center px-4 pb-[env(safe-area-inset-bottom)]">
      {/* Background glow (matches Field UI) */}
      <div className="fixed inset-0 -z-10">
        <div className="absolute inset-0 bg-slate-950" />
        <div className="absolute top-1/3 left-1/2 -translate-x-1/2 h-[360px] w-[360px] rounded-full bg-purple-600/20 blur-[90px]" />
      </div>

      <div className="w-full max-w-sm rounded-3xl bg-white/[0.03] ring-1 ring-white/10 overflow-hidden">
        <div className="px-5 py-4 border-b border-white/10">
          <div className="text-lg font-extrabold tracking-tight">
            <span className="text-purple-300">Purple</span> Field
          </div>
          <div className="mt-1 text-xs text-slate-300/70">
            Sign in to continue
          </div>
        </div>

        <form onSubmit={login} className="p-5 space-y-4">
          <div>
            <label className="block mb-2 text-[11px] font-semibold text-slate-300/80">
              Email
            </label>
            <input
              type="email"
              inputMode="email"
              autoComplete="email"
              placeholder="you@purpledetailing.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="h-12 w-full rounded-2xl bg-white/5 ring-1 ring-white/10 px-4 text-base text-white/90 placeholder:text-slate-400/70 focus:outline-none focus:ring-2 focus:ring-purple-400/30"
              required
            />
          </div>

          <div>
            <label className="block mb-2 text-[11px] font-semibold text-slate-300/80">
              Password
            </label>
            <input
              type="password"
              autoComplete="current-password"
              placeholder="••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="h-12 w-full rounded-2xl bg-white/5 ring-1 ring-white/10 px-4 text-base text-white/90 placeholder:text-slate-400/70 focus:outline-none focus:ring-2 focus:ring-purple-400/30"
              required
            />
          </div>

          {error && (
            <div className="rounded-2xl bg-red-500/10 ring-1 ring-red-400/20 px-3 py-2 text-xs text-red-200">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={busy}
            className={[
              "w-full h-12 rounded-2xl font-extrabold text-sm transition ring-1",
              busy
                ? "bg-white/5 text-slate-500 cursor-not-allowed ring-white/10"
                : "bg-purple-500/15 text-purple-100 ring-purple-400/25 hover:bg-purple-500/20",
            ].join(" ")}
          >
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </form>
      </div>
    </div>
  );
}
